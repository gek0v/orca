use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub const TERMINAL_SPAWN_DEFERRED_PREFIX: &str = "terminal_spawn_deferred:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpawnIntent {
    Interactive,
    UserResume,
    AutomaticRestore,
}

impl SpawnIntent {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "interactive" => Some(Self::Interactive),
            "user-resume" => Some(Self::UserResume),
            "automatic-restore" => Some(Self::AutomaticRestore),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnCharge {
    Interactive,
    User,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnDeferralReason {
    Paused,
    LiveCap,
    Pressure,
    Deadline,
}

impl SpawnDeferralReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Paused => "paused",
            Self::LiveCap => "live_cap",
            Self::Pressure => "pressure",
            Self::Deadline => "deadline",
        }
    }

    pub fn error_message(&self) -> String {
        format!("{}{}", TERMINAL_SPAWN_DEFERRED_PREFIX, self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomaticWorkMode {
    Active,
    Paused {
        reason: String,
        #[serde(rename = "sinceMs")]
        since_ms: u64,
    },
}

#[derive(Debug, Clone)]
pub struct SpawnAdmissionLimits {
    pub automatic_concurrency: usize,
    pub automatic_tokens_per_second: f64,
    pub automatic_burst: f64,
    pub max_live_automatic: usize,
    pub user_resume_concurrency: usize,
    pub user_resume_bucket_capacity: f64,
    pub user_resume_bucket_window_ms: u64,
}

impl Default for SpawnAdmissionLimits {
    fn default() -> Self {
        Self {
            automatic_concurrency: 3,
            automatic_tokens_per_second: 1.0,
            automatic_burst: 3.0,
            max_live_automatic: 8,
            user_resume_concurrency: 3,
            user_resume_bucket_capacity: 4.0,
            user_resume_bucket_window_ms: 10_000,
        }
    }
}

#[derive(Debug, Clone)]
struct TokenBucket {
    tokens: f64,
    updated_at_ms: u64,
    capacity: f64,
    tokens_per_ms: f64,
}

impl TokenBucket {
    fn new(capacity: f64, tokens_per_ms: f64, now_ms: u64) -> Self {
        Self {
            tokens: capacity,
            updated_at_ms: now_ms,
            capacity,
            tokens_per_ms,
        }
    }

    fn refill(&mut self, now_ms: u64) {
        let elapsed = now_ms.saturating_sub(self.updated_at_ms) as f64;
        self.tokens = (self.tokens + elapsed * self.tokens_per_ms).min(self.capacity);
        self.updated_at_ms = now_ms;
    }

    fn try_consume(&mut self, amount: f64, now_ms: u64) -> bool {
        self.refill(now_ms);
        if self.tokens >= amount {
            self.tokens -= amount;
            true
        } else {
            false
        }
    }
}

struct GateState {
    mode: AutomaticWorkMode,
    in_flight: HashMap<SpawnCharge, usize>,
    live_automatic: usize,
    automatic_bucket: TokenBucket,
    user_buckets: HashMap<String, TokenBucket>,
}

pub struct TerminalSpawnGate {
    limits: SpawnAdmissionLimits,
    state: Arc<Mutex<GateState>>,
}

impl TerminalSpawnGate {
    pub fn new(limits: SpawnAdmissionLimits) -> Self {
        let now = now_ms();
        let auto_tokens_per_ms = limits.automatic_tokens_per_second / 1000.0;
        let mut in_flight = HashMap::new();
        in_flight.insert(SpawnCharge::Interactive, 0);
        in_flight.insert(SpawnCharge::User, 0);
        in_flight.insert(SpawnCharge::Automatic, 0);

        Self {
            limits,
            state: Arc::new(Mutex::new(GateState {
                mode: AutomaticWorkMode::Active,
                in_flight,
                live_automatic: 0,
                automatic_bucket: TokenBucket::new(3.0, auto_tokens_per_ms, now),
                user_buckets: HashMap::new(),
            })),
        }
    }

    pub async fn check_and_admit(
        &self,
        client_id: &str,
        declared_intent: Option<SpawnIntent>,
        has_agent_session_claim: bool,
        deadline_at: Option<u64>,
    ) -> Result<SpawnCharge, String> {
        let now = now_ms();
        let mut state = self.state.lock().await;

        let inferred = if has_agent_session_claim {
            SpawnIntent::AutomaticRestore
        } else {
            SpawnIntent::Interactive
        };

        let intent = match declared_intent {
            Some(SpawnIntent::Interactive) => inferred,
            Some(declared) => declared,
            None => inferred,
        };

        if intent == SpawnIntent::Interactive {
            *state.in_flight.entry(SpawnCharge::Interactive).or_insert(0) += 1;
            return Ok(SpawnCharge::Interactive);
        }

        // Evaluate user-resume vs automatic
        let charge = if intent == SpawnIntent::UserResume {
            let user_tokens_per_ms =
                self.limits.user_resume_bucket_capacity / self.limits.user_resume_bucket_window_ms as f64;
            let bucket = state.user_buckets.entry(client_id.to_string()).or_insert_with(|| {
                TokenBucket::new(
                    self.limits.user_resume_bucket_capacity,
                    user_tokens_per_ms,
                    now,
                )
            });

            if bucket.try_consume(1.0, now) {
                SpawnCharge::User
            } else {
                SpawnCharge::Automatic
            }
        } else {
            SpawnCharge::Automatic
        };

        if charge == SpawnCharge::User {
            let current_user = *state.in_flight.get(&SpawnCharge::User).unwrap_or(&0);
            let is_past_deadline = deadline_at.map(|d| now >= d).unwrap_or(false);
            if current_user < self.limits.user_resume_concurrency || is_past_deadline {
                *state.in_flight.entry(SpawnCharge::User).or_insert(0) += 1;
                return Ok(SpawnCharge::User);
            }
        }

        // Automatic restore check
        let is_negotiated = declared_intent.is_some();
        let may_defer = is_negotiated && declared_intent != Some(SpawnIntent::UserResume);

        if may_defer {
            if let AutomaticWorkMode::Paused { .. } = &state.mode {
                return Err(SpawnDeferralReason::Paused.error_message());
            }

            let in_flight_auto = *state.in_flight.get(&SpawnCharge::Automatic).unwrap_or(&0);
            if state.live_automatic + in_flight_auto >= self.limits.max_live_automatic {
                return Err(SpawnDeferralReason::LiveCap.error_message());
            }
        }

        let in_flight_auto = *state.in_flight.get(&SpawnCharge::Automatic).unwrap_or(&0);
        let concurrency_ok = in_flight_auto < self.limits.automatic_concurrency;
        let token_ok = state.automatic_bucket.try_consume(1.0, now);

        if concurrency_ok && token_ok {
            *state.in_flight.entry(SpawnCharge::Automatic).or_insert(0) += 1;
            return Ok(SpawnCharge::Automatic);
        }

        if let Some(deadline) = deadline_at {
            if now >= deadline {
                if may_defer {
                    return Err(SpawnDeferralReason::Deadline.error_message());
                } else {
                    *state.in_flight.entry(SpawnCharge::Automatic).or_insert(0) += 1;
                    return Ok(SpawnCharge::Automatic);
                }
            }
        }

        if may_defer {
            Err(SpawnDeferralReason::Deadline.error_message())
        } else {
            *state.in_flight.entry(SpawnCharge::Automatic).or_insert(0) += 1;
            Ok(SpawnCharge::Automatic)
        }
    }

    pub async fn settle(&self, charge: SpawnCharge, became_live: bool) {
        let mut state = self.state.lock().await;
        if let Some(count) = state.in_flight.get_mut(&charge) {
            *count = count.saturating_sub(1);
        }
        if charge == SpawnCharge::Automatic && became_live {
            state.live_automatic += 1;
        }
    }

    pub async fn release_live_automatic(&self) {
        let mut state = self.state.lock().await;
        state.live_automatic = state.live_automatic.saturating_sub(1);
    }

    pub async fn pause_automatic_work(&self, reason: String) {
        let mut state = self.state.lock().await;
        state.mode = AutomaticWorkMode::Paused {
            reason,
            since_ms: now_ms(),
        };
    }

    pub async fn resume_automatic_work(&self) -> bool {
        let mut state = self.state.lock().await;
        let was_paused = matches!(&state.mode, AutomaticWorkMode::Paused { .. });
        state.mode = AutomaticWorkMode::Active;
        was_paused
    }

    pub async fn status(&self) -> serde_json::Value {
        let state = self.state.lock().await;
        let (mode_str, reason, since_ms) = match &state.mode {
            AutomaticWorkMode::Active => ("active", None, None),
            AutomaticWorkMode::Paused { reason, since_ms } => {
                ("paused", Some(reason.as_str()), Some(*since_ms))
            }
        };

        serde_json::json!({
            "mode": mode_str,
            "reason": reason,
            "sinceMs": since_ms,
            "liveAutomatic": state.live_automatic,
            "maxLiveAutomatic": self.limits.max_live_automatic,
            "inFlight": {
                "interactive": state.in_flight.get(&SpawnCharge::Interactive).unwrap_or(&0),
                "user": state.in_flight.get(&SpawnCharge::User).unwrap_or(&0),
                "automatic": state.in_flight.get(&SpawnCharge::Automatic).unwrap_or(&0)
            }
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_gate_interactive_bypasses() {
        let gate = TerminalSpawnGate::new(SpawnAdmissionLimits::default());
        let res = gate.check_and_admit("client-1", Some(SpawnIntent::Interactive), false, None).await;
        assert_eq!(res.unwrap(), SpawnCharge::Interactive);
    }

    #[tokio::test]
    async fn test_spawn_gate_pause_defers_automatic() {
        let gate = TerminalSpawnGate::new(SpawnAdmissionLimits::default());
        gate.pause_automatic_work("test_breaker".to_string()).await;

        let res = gate
            .check_and_admit("client-1", Some(SpawnIntent::AutomaticRestore), false, None)
            .await;
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "terminal_spawn_deferred:paused");

        // Resuming clears paused state
        assert!(gate.resume_automatic_work().await);
        let res2 = gate
            .check_and_admit("client-1", Some(SpawnIntent::AutomaticRestore), false, None)
            .await;
        assert_eq!(res2.unwrap(), SpawnCharge::Automatic);
    }

    #[tokio::test]
    async fn test_spawn_gate_live_cap_defers_automatic() {
        let mut limits = SpawnAdmissionLimits::default();
        limits.max_live_automatic = 2;
        let gate = TerminalSpawnGate::new(limits);

        // Admit 2 automatic spawns and settle as live
        let c1 = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await.unwrap();
        gate.settle(c1, true).await;
        let c2 = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await.unwrap();
        gate.settle(c2, true).await;

        // Third should fail with live_cap
        let res = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await;
        assert_eq!(res.unwrap_err(), "terminal_spawn_deferred:live_cap");

        // Release one live automatic
        gate.release_live_automatic().await;

        // Now should be admitted
        let c3 = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await;
        assert!(c3.is_ok());
    }

    #[tokio::test]
    async fn test_spawn_gate_deadline_defers_when_tokens_exhausted() {
        let mut limits = SpawnAdmissionLimits::default();
        limits.automatic_burst = 1.0;
        limits.automatic_concurrency = 10;
        let gate = TerminalSpawnGate::new(limits);

        // Consume default tokens
        let _ = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await.unwrap();
        let _ = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await.unwrap();
        let _ = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, None).await.unwrap();

        // Expired deadline: should defer with deadline
        let expired = now_ms().saturating_sub(100);
        let res = gate.check_and_admit("c1", Some(SpawnIntent::AutomaticRestore), false, Some(expired)).await;
        assert_eq!(res.unwrap_err(), "terminal_spawn_deferred:deadline");
    }
}
