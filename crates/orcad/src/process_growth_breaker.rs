use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::terminal_spawn_gate::TerminalSpawnGate;

#[derive(Debug, Clone)]
pub struct ProcessGrowthSample {
    pub at_ms: u64,
    pub host_descendants: Option<usize>,
    pub scopes: HashMap<String, usize>,
}

#[derive(Debug, Clone)]
pub struct ProcessGrowthLimits {
    pub host_elevated_descendants: usize,
    pub growth_per_second: f64,
    pub sustain_ms: u64,
    pub min_rising_samples: usize,
}

impl Default for ProcessGrowthLimits {
    fn default() -> Self {
        Self {
            host_elevated_descendants: 1500,
            growth_per_second: 40.0,
            sustain_ms: 10_000,
            min_rising_samples: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessGrowthTrip {
    pub scope_id: Option<String>,
    pub descendants: usize,
    pub growth_per_second: u64,
}

#[derive(Debug, Clone)]
struct RisingStreak {
    since_ms: u64,
    samples: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ProcessGrowthState {
    previous: Option<ProcessGrowthSample>,
    streaks: HashMap<String, RisingStreak>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GrowthLevel {
    Ok,
    Elevated,
    Critical,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ProcessGrowthVerdict {
    pub level: GrowthLevel,
    pub trips: Vec<ProcessGrowthTrip>,
    pub rising: bool,
}

pub fn evaluate_process_growth(
    state: &mut ProcessGrowthState,
    sample: &ProcessGrowthSample,
    limits: &ProcessGrowthLimits,
) -> ProcessGrowthVerdict {
    let host_descendants = match sample.host_descendants {
        Some(n) => n,
        None => {
            return ProcessGrowthVerdict {
                level: GrowthLevel::Unknown,
                trips: Vec::new(),
                rising: !state.streaks.is_empty(),
            };
        }
    };

    let elapsed_ms = state
        .previous
        .as_ref()
        .map(|prev| sample.at_ms.saturating_sub(prev.at_ms))
        .unwrap_or(0);

    let mut trips = Vec::new();
    let mut growing = false;

    let growth_rate = |prev_count: Option<usize>, cur_count: usize| -> f64 {
        if let Some(prev) = prev_count {
            if elapsed_ms > 0 {
                return (cur_count as f64 - prev as f64) * 1000.0 / elapsed_ms as f64;
            }
        }
        0.0
    };

    // 1. Observe host-level growth
    let host_prev = state.previous.as_ref().and_then(|p| p.host_descendants);
    let host_rate = growth_rate(host_prev, host_descendants);
    if host_rate >= limits.growth_per_second {
        growing = true;
        let streak = state.streaks.entry("".to_string()).or_insert(RisingStreak {
            since_ms: state.previous.as_ref().map(|p| p.at_ms).unwrap_or(sample.at_ms),
            samples: 0,
        });
        streak.samples += 1;
        if streak.samples >= limits.min_rising_samples
            && sample.at_ms.saturating_sub(streak.since_ms) >= limits.sustain_ms
        {
            trips.push(ProcessGrowthTrip {
                scope_id: None,
                descendants: host_descendants,
                growth_per_second: host_rate.round() as u64,
            });
        }
    } else {
        state.streaks.remove("");
    }

    // 2. Observe per-scope growth
    for (scope_id, &cur_count) in &sample.scopes {
        let prev_count = state.previous.as_ref().and_then(|p| p.scopes.get(scope_id).copied());
        let rate = growth_rate(prev_count, cur_count);
        if rate >= limits.growth_per_second {
            growing = true;
            let streak = state.streaks.entry(scope_id.clone()).or_insert(RisingStreak {
                since_ms: state.previous.as_ref().map(|p| p.at_ms).unwrap_or(sample.at_ms),
                samples: 0,
            });
            streak.samples += 1;
            if streak.samples >= limits.min_rising_samples
                && sample.at_ms.saturating_sub(streak.since_ms) >= limits.sustain_ms
            {
                trips.push(ProcessGrowthTrip {
                    scope_id: Some(scope_id.clone()),
                    descendants: cur_count,
                    growth_per_second: rate.round() as u64,
                });
            }
        } else {
            state.streaks.remove(scope_id);
        }
    }

    state.previous = Some(sample.clone());

    if !trips.is_empty() {
        ProcessGrowthVerdict {
            level: GrowthLevel::Critical,
            trips,
            rising: true,
        }
    } else {
        let level = if growing || host_descendants >= limits.host_elevated_descendants {
            GrowthLevel::Elevated
        } else {
            GrowthLevel::Ok
        };
        ProcessGrowthVerdict {
            level,
            trips,
            rising: growing,
        }
    }
}

pub struct ProcessGrowthMonitor {
    limits: ProcessGrowthLimits,
    state: Mutex<ProcessGrowthState>,
    spawn_gate: Arc<TerminalSpawnGate>,
}

impl ProcessGrowthMonitor {
    pub fn new(spawn_gate: Arc<TerminalSpawnGate>) -> Self {
        Self {
            limits: ProcessGrowthLimits::default(),
            state: Mutex::new(ProcessGrowthState::default()),
            spawn_gate,
        }
    }

    pub async fn ingest_sample(&self, sample: ProcessGrowthSample) -> ProcessGrowthVerdict {
        let mut state = self.state.lock().await;
        let verdict = evaluate_process_growth(&mut state, &sample, &self.limits);
        if !verdict.trips.is_empty() {
            let reason = format!(
                "process_growth_breaker: {} trips (rate={}/s)",
                verdict.trips.len(),
                verdict.trips[0].growth_per_second
            );
            self.spawn_gate.pause_automatic_work(reason).await;
        }
        verdict
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_growth_evaluation_trips_after_sustained_growth() {
        let limits = ProcessGrowthLimits {
            host_elevated_descendants: 1000,
            growth_per_second: 50.0,
            sustain_ms: 2000,
            min_rising_samples: 3,
        };
        let mut state = ProcessGrowthState::default();

        // Sample 1: Baseline at t=0
        let s1 = ProcessGrowthSample {
            at_ms: 0,
            host_descendants: Some(10),
            scopes: HashMap::new(),
        };
        let v1 = evaluate_process_growth(&mut state, &s1, &limits);
        assert_eq!(v1.level, GrowthLevel::Ok);

        // Sample 2: t=1000ms, descendants=100 (rate 90/s) -> Rising
        let s2 = ProcessGrowthSample {
            at_ms: 1000,
            host_descendants: Some(100),
            scopes: HashMap::new(),
        };
        let v2 = evaluate_process_growth(&mut state, &s2, &limits);
        assert_eq!(v2.level, GrowthLevel::Elevated);
        assert!(v2.rising);

        // Sample 3: t=2000ms, descendants=200 (rate 100/s) -> Sample count=2, sustain met
        let s3 = ProcessGrowthSample {
            at_ms: 2000,
            host_descendants: Some(200),
            scopes: HashMap::new(),
        };
        let v3 = evaluate_process_growth(&mut state, &s3, &limits);
        assert_eq!(v3.level, GrowthLevel::Elevated);

        // Sample 4: t=3000ms, descendants=300 (rate 100/s) -> Sample count=3, sustain >= 2000ms -> TRIP!
        let s4 = ProcessGrowthSample {
            at_ms: 3000,
            host_descendants: Some(300),
            scopes: HashMap::new(),
        };
        let v4 = evaluate_process_growth(&mut state, &s4, &limits);
        assert_eq!(v4.level, GrowthLevel::Critical);
        assert_eq!(v4.trips.len(), 1);
        assert_eq!(v4.trips[0].descendants, 300);
    }
}
