//! MLS Delivery-Service repository (Phase 3 · Lot 3).
//!
//! Owns the per-group epoch/sequence authority, the ordered opaque frame log, and
//! the Welcome mailbox. All payloads are opaque MLS bytes — the server never reads
//! plaintext or holds a group secret. Ordering the first Commit per epoch is a
//! single atomic CAS, correct across all stateless replicas.

use uuid::Uuid;

use crate::error::ApiError;

/// One ordered frame in a group's log.
pub struct Frame {
    pub order_seq: i64,
    pub epoch: i64,
    pub content_type: String,
    pub sender_id: Option<Uuid>,
    pub frame_data: Vec<u8>,
}

/// A queued Welcome for an offline-added device.
pub struct PendingWelcome {
    pub id: Uuid,
    pub group_id: Uuid,
    pub welcome_data: Vec<u8>,
}

/// Result of [`ensure_group`] — whether THIS call created the row, plus the
/// group's authoritative position. `created` is the creation arbitration two
/// devices race on: exactly one caller ever sees `true` per group, so only that
/// device may build the root MLS group locally; everyone else must wait to be
/// added (Welcome) instead of forking a second group under the same id.
pub struct GroupStatus {
    pub created: bool,
    pub current_epoch: i64,
    pub order_seq: i64,
}

/// Create the ordering row for a group (idempotent — group_id = conversation id),
/// reporting whether it already existed and where it stands. The no-op
/// `DO UPDATE` makes `RETURNING` yield a row on the conflict path too; `xmax = 0`
/// distinguishes a fresh insert from an existing row.
pub async fn ensure_group(pool: &sqlx::PgPool, group_id: Uuid) -> Result<GroupStatus, ApiError> {
    let row = sqlx::query!(
        "INSERT INTO mls_groups (group_id) VALUES ($1) \
         ON CONFLICT (group_id) DO UPDATE SET group_id = EXCLUDED.group_id \
         RETURNING (xmax = 0) AS \"created!\", current_epoch, order_seq",
        group_id,
    )
    .fetch_one(pool)
    .await?;
    Ok(GroupStatus {
        created: row.created,
        current_epoch: row.current_epoch,
        order_seq: row.order_seq,
    })
}

/// The group's current epoch, or `None` if it has no ordering row.
pub async fn current_epoch(pool: &sqlx::PgPool, group_id: Uuid) -> Result<Option<i64>, ApiError> {
    sqlx::query_scalar!(
        "SELECT current_epoch FROM mls_groups WHERE group_id = $1",
        group_id,
    )
    .fetch_optional(pool)
    .await
    .map_err(ApiError::from)
}

/// Submit a Commit: accepted only if it targets the current epoch (CAS). The
/// first such Commit wins, advances the epoch, and gets an order_seq; a stale
/// Commit returns `None` → the caller resyncs, rebases, and retries (409).
pub async fn submit_commit(
    pool: &sqlx::PgPool,
    group_id: Uuid,
    claimed_epoch: i64,
    sender_id: Uuid,
    frame_data: &[u8],
) -> Result<Option<i64>, ApiError> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query!(
        "UPDATE mls_groups SET current_epoch = current_epoch + 1, order_seq = order_seq + 1 \
         WHERE group_id = $1 AND current_epoch = $2 RETURNING order_seq",
        group_id,
        claimed_epoch,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(None); // conflict: someone committed this epoch first
    };
    sqlx::query!(
        "INSERT INTO mls_frames (group_id, order_seq, epoch, content_type, sender_id, frame_data) \
         VALUES ($1, $2, $3, 'commit', $4, $5)",
        group_id,
        row.order_seq,
        claimed_epoch,
        sender_id,
        frame_data,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(row.order_seq))
}

/// How far behind the group's epoch a non-commit frame may claim to be. Covers
/// the legitimate race of a message encrypted just before someone else's commit
/// landed (receivers keep a matching decryption window, `max_past_epochs`);
/// anything older is a divergent or badly stale device that must resync.
pub const MAX_FRAME_EPOCH_LAG: i64 = 2;

/// Outcome of appending a non-commit frame.
pub enum SubmitFrameOutcome {
    Accepted {
        order_seq: i64,
    },
    /// The sender claimed an epoch too far behind the group — a split-brain or
    /// badly stale device. Nothing was appended; the caller gets a 409 and the
    /// authoritative epoch so it can repair instead of silently poisoning the log.
    StaleEpoch {
        current_epoch: i64,
    },
    /// The group has no ordering row yet.
    NoGroup,
}

/// Append a proposal or application frame — takes an order_seq WITHOUT advancing
/// the epoch. When the sender claims its epoch (newer clients), the frame is
/// rejected if it lags more than [`MAX_FRAME_EPOCH_LAG`] behind; a `None` claim
/// (older clients) keeps the legacy no-check behavior.
pub async fn submit_frame(
    pool: &sqlx::PgPool,
    group_id: Uuid,
    content_type: &str,
    sender_id: Uuid,
    frame_data: &[u8],
    claimed_epoch: Option<i64>,
) -> Result<SubmitFrameOutcome, ApiError> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query!(
        "UPDATE mls_groups SET order_seq = order_seq + 1 WHERE group_id = $1 \
         RETURNING order_seq, current_epoch",
        group_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(SubmitFrameOutcome::NoGroup);
    };
    if let Some(claimed) = claimed_epoch
        && claimed + MAX_FRAME_EPOCH_LAG < row.current_epoch
    {
        // Dropping the tx rolls the order_seq bump back — nothing is consumed.
        return Ok(SubmitFrameOutcome::StaleEpoch {
            current_epoch: row.current_epoch,
        });
    }
    sqlx::query!(
        "INSERT INTO mls_frames (group_id, order_seq, epoch, content_type, sender_id, frame_data) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        group_id,
        row.order_seq,
        // Store the epoch the frame was actually encrypted at when the sender
        // claims it — receivers use it to tell "from before I joined" apart
        // from "undecryptable in my current group".
        claimed_epoch.unwrap_or(row.current_epoch),
        content_type,
        sender_id,
        frame_data,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(SubmitFrameOutcome::Accepted {
        order_seq: row.order_seq,
    })
}

/// Frames after `after` (a resume cursor) in total order — for replay on reconnect.
pub async fn frames_since(
    pool: &sqlx::PgPool,
    group_id: Uuid,
    after: i64,
) -> Result<Vec<Frame>, ApiError> {
    sqlx::query_as!(
        Frame,
        "SELECT order_seq, epoch, content_type, sender_id, frame_data FROM mls_frames \
         WHERE group_id = $1 AND order_seq > $2 ORDER BY order_seq",
        group_id,
        after,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Queue a Welcome for a specific recipient device (delivered when it polls).
pub async fn store_welcome(
    pool: &sqlx::PgPool,
    group_id: Uuid,
    recipient_user_id: Uuid,
    recipient_device_id: &str,
    welcome_data: &[u8],
) -> Result<(), ApiError> {
    sqlx::query!(
        "INSERT INTO mls_welcomes (group_id, recipient_user_id, recipient_device_id, welcome_data) \
         VALUES ($1, $2, $3, $4)",
        group_id,
        recipient_user_id,
        recipient_device_id,
        welcome_data,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Undelivered Welcomes for a device (oldest first).
pub async fn pending_welcomes(
    pool: &sqlx::PgPool,
    recipient_user_id: Uuid,
    recipient_device_id: &str,
) -> Result<Vec<PendingWelcome>, ApiError> {
    sqlx::query_as!(
        PendingWelcome,
        "SELECT id, group_id, welcome_data FROM mls_welcomes \
         WHERE recipient_user_id = $1 AND recipient_device_id = $2 AND delivered_at IS NULL \
         ORDER BY created_at",
        recipient_user_id,
        recipient_device_id,
    )
    .fetch_all(pool)
    .await
    .map_err(ApiError::from)
}

/// Mark a Welcome delivered so it is not replayed (legacy fetch-marks path).
pub async fn mark_welcome_delivered(pool: &sqlx::PgPool, id: Uuid) -> Result<(), ApiError> {
    sqlx::query!(
        "UPDATE mls_welcomes SET delivered_at = now() WHERE id = $1",
        id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Client acknowledgment of a processed Welcome (at-least-once delivery: the
/// welcome stays fetchable until the device confirms it attempted the join).
/// Ownership-checked; returns whether a row was actually acked.
pub async fn ack_welcome(
    pool: &sqlx::PgPool,
    id: Uuid,
    recipient_user_id: Uuid,
) -> Result<bool, ApiError> {
    let result = sqlx::query!(
        "UPDATE mls_welcomes SET delivered_at = now() \
         WHERE id = $1 AND recipient_user_id = $2 AND delivered_at IS NULL",
        id,
        recipient_user_id,
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
