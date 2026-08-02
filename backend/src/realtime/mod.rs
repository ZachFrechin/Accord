//! Realtime backbone: a WebSocket gateway whose fan-out crosses nodes via NATS.
//!
//! Each node keeps only the sockets it hosts in process memory; delivery to a
//! user is a NATS publish to `accord.user.{id}`, and every node hosting that user
//! fans the message out to its local sockets. No socket state is shared between
//! nodes, so replicas stay interchangeable. Live fan-out uses core NATS pub/sub
//! (ephemeral); durable per-channel sequencing/replay arrives with message
//! content in a later phase.

pub mod bus;
pub mod call_state;
pub mod presence;
pub mod protocol;
