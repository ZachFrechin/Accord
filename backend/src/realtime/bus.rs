//! The realtime bus: per-node subscription registry + cross-node delivery.
//!
//! For each user this node currently hosts, the bus holds ONE NATS subscription
//! (`accord.user.{id}`) whose messages are pumped into a local broadcast channel
//! shared by all of that user's sockets on this node. Subscriptions are created
//! on the first local socket and torn down (via an RAII [`LocalGuard`]) when the
//! last one closes — so a node subscribes only to the users it actually serves.

use std::sync::Arc;

use dashmap::DashMap;
use dashmap::mapref::entry::Entry;
use futures_util::StreamExt;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::error::ApiError;
use crate::realtime::protocol::ServerEvent;

/// Local broadcast capacity per user. A socket that lags past this is reset.
const CHANNEL_CAP: usize = 256;

/// NATS subject carrying events addressed to a single user.
fn user_subject(user_id: Uuid) -> String {
    format!("accord.user.{user_id}")
}

/// One hosted user's local delivery channel + the NATS pump feeding it.
struct UserChannel {
    tx: broadcast::Sender<String>,
    refcount: usize,
    pump: JoinHandle<()>,
}

/// Cross-node realtime delivery. Cheap to clone via `Arc` in `AppState`.
pub struct RealtimeBus {
    nats: async_nats::Client,
    users: DashMap<Uuid, UserChannel>,
}

/// RAII handle held by a socket for the lifetime of its subscription. Dropping it
/// releases the local reference and tears down the NATS subscription if it was
/// the last socket for that user on this node.
pub struct LocalGuard {
    bus: Arc<RealtimeBus>,
    user_id: Uuid,
}

impl Drop for LocalGuard {
    fn drop(&mut self) {
        self.bus.release(self.user_id);
    }
}

impl RealtimeBus {
    /// Creates a bus over an existing NATS client.
    pub fn new(nats: async_nats::Client) -> Self {
        Self {
            nats,
            users: DashMap::new(),
        }
    }

    /// Subscribes a local socket to a user's event stream, returning a receiver
    /// and a guard. The NATS subscription + pump task are created lazily on the
    /// first socket for that user.
    pub async fn subscribe_local(
        self: &Arc<Self>,
        user_id: Uuid,
    ) -> Result<(broadcast::Receiver<String>, LocalGuard), ApiError> {
        // Fast path: this node already hosts the user.
        if let Some(mut entry) = self.users.get_mut(&user_id) {
            entry.refcount += 1;
            let rx = entry.tx.subscribe();
            return Ok((
                rx,
                LocalGuard {
                    bus: self.clone(),
                    user_id,
                },
            ));
        }

        // Slow path: create the NATS subscription (no lock held across await).
        let mut subscriber = self
            .nats
            .subscribe(user_subject(user_id))
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("nats subscribe: {e}")))?;
        let (tx, rx) = broadcast::channel::<String>(CHANNEL_CAP);
        let pump_tx = tx.clone();
        let pump = tokio::spawn(async move {
            while let Some(message) = subscriber.next().await {
                if let Ok(text) = String::from_utf8(message.payload.to_vec()) {
                    // Ignore send errors: momentarily zero receivers is fine.
                    let _ = pump_tx.send(text);
                }
            }
        });

        // Install, guarding against a concurrent creator for the same user.
        match self.users.entry(user_id) {
            Entry::Occupied(mut occupied) => {
                pump.abort();
                occupied.get_mut().refcount += 1;
                let rx = occupied.get().tx.subscribe();
                Ok((
                    rx,
                    LocalGuard {
                        bus: self.clone(),
                        user_id,
                    },
                ))
            }
            Entry::Vacant(vacant) => {
                vacant.insert(UserChannel {
                    tx,
                    refcount: 1,
                    pump,
                });
                Ok((
                    rx,
                    LocalGuard {
                        bus: self.clone(),
                        user_id,
                    },
                ))
            }
        }
    }

    /// Releases one local reference; tears down the subscription at zero.
    fn release(&self, user_id: Uuid) {
        if let Entry::Occupied(mut occupied) = self.users.entry(user_id) {
            let channel = occupied.get_mut();
            channel.refcount -= 1;
            if channel.refcount == 0 {
                channel.pump.abort();
                occupied.remove();
            }
        }
    }

    /// Delivers an event to a user across the whole fleet by publishing to NATS.
    /// Every node hosting that user fans it out to its local sockets.
    pub async fn deliver_to_user(
        &self,
        user_id: Uuid,
        event: &ServerEvent,
    ) -> Result<(), ApiError> {
        let json = serde_json::to_string(event)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialize event: {e}")))?;
        self.nats
            .publish(user_subject(user_id), json.into_bytes().into())
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("nats publish: {e}")))?;
        Ok(())
    }
}
