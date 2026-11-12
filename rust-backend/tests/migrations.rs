use sqlx::{postgres::PgPoolOptions, Row};

#[tokio::test]
async fn postgres_migrations_apply_and_create_runtime_tables() {
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        // Unit-only environments can run without a local PostgreSQL instance.
        return;
    };

    let pool = PgPoolOptions::new()
        .max_connections(3)
        .connect(&database_url)
        .await
        .expect("connect to the disposable PostgreSQL test database");

    let baseline = include_str!("fixtures/neon_base_schema.sql");
    for statement in baseline.split(';').map(str::trim).filter(|value| !value.is_empty()) {
        sqlx::query(statement)
            .execute(&pool)
            .await
            .expect("create the pre-existing Neon baseline tables");
    }

    let migrator = sqlx::migrate!("./migrations");
    migrator
        .run(&pool)
        .await
        .expect("apply every MallowCord Rust migration");
    migrator
        .run(&pool)
        .await
        .expect("a second migration run must be safe");

    for table in [
        "users",
        "sessions",
        "oauth_states",
        "oauth_accounts",
        "oauth_login_codes",
        "oauth_diagnostics",
        "servers",
        "server_onboarding",
        "onboarding_completions",
        "messages",
        "message_attachments",
        "event_inbox",
        "worker_error_logs",
    ] {
        let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(table)
            .fetch_one(&pool)
            .await
            .expect("check migrated table");
        assert!(exists, "migration did not create table {table}");
    }

    let index_count: i64 = sqlx::query(
        "SELECT COUNT(*)::BIGINT AS count
         FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = ANY($1)",
    )
    .bind(vec![
        "event_inbox_pending_idx",
        "messages_channel_idx",
        "oauth_states_expiry_idx",
        "worker_error_logs_created_idx",
        "onboarding_completions_user_idx",
        "message_attachments_message_idx",
    ])
    .fetch_one(&pool)
    .await
    .expect("check hot-path indexes")
    .get("count");
    assert_eq!(index_count, 6, "expected all migration indexes to exist");

    pool.close().await;
}
