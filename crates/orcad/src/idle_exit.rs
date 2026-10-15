use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, oneshot, Mutex};

pub struct IdleExitManager {
    active_connections: Arc<AtomicUsize>,
    active_terminals: Arc<AtomicUsize>,
    idle_timeout: Duration,
    shutdown_tx: broadcast::Sender<()>,
    cancel_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl IdleExitManager {
    pub fn new(idle_timeout: Duration, shutdown_tx: broadcast::Sender<()>) -> Arc<Self> {
        let mgr = Arc::new(Self {
            active_connections: Arc::new(AtomicUsize::new(0)),
            active_terminals: Arc::new(AtomicUsize::new(0)),
            idle_timeout,
            shutdown_tx,
            cancel_tx: Arc::new(Mutex::new(None)),
        });

        // Arm timer initially if starting with 0 connections and 0 terminals
        let mgr_clone = Arc::clone(&mgr);
        tokio::spawn(async move {
            mgr_clone.check_and_arm().await;
        });

        mgr
    }

    pub fn active_connections(&self) -> usize {
        self.active_connections.load(Ordering::SeqCst)
    }

    pub fn active_terminals(&self) -> usize {
        self.active_terminals.load(Ordering::SeqCst)
    }

    pub async fn connection_opened(&self) {
        self.active_connections.fetch_add(1, Ordering::SeqCst);
        self.disarm().await;
    }

    pub async fn connection_closed(&self) {
        let prev = self.active_connections.fetch_sub(1, Ordering::SeqCst);
        if prev <= 1 {
            self.check_and_arm().await;
        }
    }

    pub async fn terminal_created(&self) {
        self.active_terminals.fetch_add(1, Ordering::SeqCst);
        self.disarm().await;
    }

    pub async fn terminal_closed(&self) {
        let prev = self.active_terminals.fetch_sub(1, Ordering::SeqCst);
        if prev <= 1 {
            self.check_and_arm().await;
        }
    }

    async fn disarm(&self) {
        let mut guard = self.cancel_tx.lock().await;
        if let Some(cancel) = guard.take() {
            let _ = cancel.send(());
        }
    }

    async fn check_and_arm(&self) {
        if self.idle_timeout.is_zero() {
            return;
        }
        if self.active_connections.load(Ordering::SeqCst) == 0
            && self.active_terminals.load(Ordering::SeqCst) == 0
        {
            let (tx, mut rx) = oneshot::channel();
            {
                let mut guard = self.cancel_tx.lock().await;
                if let Some(prev) = guard.take() {
                    let _ = prev.send(());
                }
                *guard = Some(tx);
            }

            let timeout = self.idle_timeout;
            let shutdown_tx = self.shutdown_tx.clone();
            let conns = Arc::clone(&self.active_connections);
            let terms = Arc::clone(&self.active_terminals);

            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(timeout) => {
                        if conns.load(Ordering::SeqCst) == 0 && terms.load(Ordering::SeqCst) == 0 {
                            tracing::info!("Idle timeout reached. Shutting down daemon cleanly.");
                            let _ = shutdown_tx.send(());
                        }
                    }
                    _ = &mut rx => {
                        // Cancelled due to activity
                    }
                }
            });
        }
    }

    pub fn trigger_shutdown(&self) {
        let _ = self.shutdown_tx.send(());
    }
}
