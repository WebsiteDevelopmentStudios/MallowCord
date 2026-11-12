use crate::{discord_bridge, AppState};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_ATTEMPTS: i32 = 12;
const LOCK_TIMEOUT_SECS: i64 = 120;

#[derive(FromRow)]
struct PendingEvent {
    event_id: String,
    source: String,
    event_type: String,
    payload: Value,
    attempts: i32,
}

async fn claim_one(pool: &PgPool) -> Result<Option<PendingEvent>, sqlx::Error> {
    sqlx::query_as::<_, PendingEvent>(
        "WITH candidate AS (
            SELECT event_id
            FROM event_inbox
            WHERE processed_at IS NULL
              AND dead_lettered_at IS NULL
              AND next_attempt_at <= NOW()
              AND (locked_at IS NULL OR locked_at < NOW() - ($1 * INTERVAL '1 second'))
              AND attempts < $2
            ORDER BY received_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE event_inbox AS event
         SET locked_at = NOW(), attempts = attempts + 1
         FROM candidate
         WHERE event.event_id = candidate.event_id
         RETURNING event.event_id, event.source, event.event_type, event.payload, event.attempts",
    )
    .bind(LOCK_TIMEOUT_SECS)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(pool)
    .await
}

async fn finish_event(
    pool: &PgPool,
    event: &PendingEvent,
    result: Result<(), String>,
) -> Result<(), sqlx::Error> {
    match result {
        Ok(()) => {
            sqlx::query(
                "UPDATE event_inbox
                 SET processed_at = NOW(), locked_at = NULL, last_error = NULL
                 WHERE event_id = $1",
            )
            .bind(&event.event_id)
            .execute(pool)
            .await?;
        }
        Err(error) => {
            let error: String = error.chars().take(2000).collect();
            sqlx::query(
                "UPDATE event_inbox
                 SET locked_at = NULL,
                     last_error = $2,
                     next_attempt_at = NOW() + (LEAST(300, power(2, LEAST(attempts, 8))) * INTERVAL '1 second'),
                     dead_lettered_at = CASE WHEN attempts >= $3 THEN NOW() ELSE NULL END
                 WHERE event_id = $1",
            )
            .bind(&event.event_id)
            .bind(error)
            .bind(MAX_ATTEMPTS)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

async fn process_one(state: &AppState, pool: &PgPool) -> Result<bool, sqlx::Error> {
    let Some(event) = claim_one(pool).await? else {
        return Ok(false);
    };
    let result = if event.source != "mallowbot" {
        Err(format!("Unsupported event source: {}", event.source))
    } else {
        discord_bridge::process_inbox_event(
            state.clone(),
            &event.event_type,
            event.payload.clone(),
        )
        .await
    };
    if let Err(error) = &result {
        tracing::warn!(
            event_id = %event.event_id,
            event_type = %event.event_type,
            attempt = event.attempts,
            error = %error,
            "Mallow-Bot event processing failed; it will be retried"
        );
    } else {
        tracing::debug!(
            event_id = %event.event_id,
            event_type = %event.event_type,
            "Mallow-Bot event processed"
        );
    }
    finish_event(pool, &event, result).await?;
    Ok(true)
}

pub(crate) async fn run(state: AppState) {
    let Some(pool) = state.database.clone() else {
        tracing::info!("Mallow-Bot event consumer disabled because PostgreSQL is not configured");
        return;
    };
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        for _ in 0..25 {
            match process_one(&state, &pool).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    tracing::error!(%error, "Mallow-Bot event consumer database operation failed");
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn retry_policy_is_bounded() {
        let delays: Vec<u32> = (1..=12)
            .map(|attempt| 2u32.pow(attempt.min(8) as u32).min(300))
            .collect();
        assert_eq!(delays[0], 2);
        assert_eq!(delays[7], 256);
        assert_eq!(delays[8], 256);
        assert!(delays.iter().all(|delay| *delay <= 300));
    }
}
