use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{
        header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use object_store::path::Path as ObjectPath;
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    auth::{current_user, AuthUser},
    server::channel_permission_allowed,
    AppState,
};

const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn require_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(PgPool, AuthUser), Box<Response>> {
    let Some(pool) = state.database.as_ref() else {
        return Err(Box::new((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response()));
    };
    match current_user(headers, pool).await {
        Ok(Some(user)) => {
            if user.status == "timed_out" && user.timeout_until.unwrap_or(0) > now() {
                return Err(Box::new((
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": "Your account is timed out."})),
                )
                    .into_response()));
            }
            Ok((pool.clone(), user))
        }
        Ok(None) => Err(Box::new((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Sign in required."})),
        )
            .into_response())),
        Err(error) => {
            tracing::error!(%error, "attachment API session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
        }
    }
}

async fn channel_access(
    pool: &PgPool,
    user: &AuthUser,
    channel_id: &str,
    permission: &str,
) -> Result<String, Box<Response>> {
    let server_id = sqlx::query_scalar::<_, String>(
        "SELECT server_id FROM channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "attachment channel lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_lookup_failed"}))).into_response())
    })?
    .ok_or_else(|| Box::new((StatusCode::NOT_FOUND, Json(json!({"error": "Channel not found."}))).into_response()))?;

    match channel_permission_allowed(pool, &user.id, channel_id, permission).await {
        Ok(true) => Ok(server_id),
        Ok(false) => Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "You cannot access this channel."}))).into_response())),
        Err(error) => {
            tracing::error!(%error, "attachment channel permission lookup failed");
            Err(Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response()))
        }
    }
}

fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control() && *character != '/' && *character != '\\')
        .take(180)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() {
        "upload".to_owned()
    } else {
        cleaned.to_owned()
    }
}

fn allowed_content_type(content_type: &str) -> bool {
    let value = content_type.to_ascii_lowercase();
    !value.starts_with("text/html")
        && !value.starts_with("image/svg+xml")
        && !value.starts_with("application/xhtml+xml")
        && !value.starts_with("application/javascript")
        && !value.starts_with("text/javascript")
        && !value.starts_with("application/x-msdownload")
        && !value.starts_with("application/x-sh")
}

async fn upload_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    mut multipart: Multipart,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let server_id = match channel_access(&pool, &user, &channel_id, "attach_files").await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(store) = state.object_store.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Object storage is not configured yet."}))).into_response();
    };

    let mut uploaded: Option<(String, String, Vec<u8>)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "multipart upload parse failed");
                return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid upload form."}))).into_response();
            }
        };
        if field.name() != Some("file") {
            continue;
        }
        if uploaded.is_some() {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": "Upload one file at a time."}))).into_response();
        }
        let filename = sanitize_filename(field.file_name().unwrap_or("upload"));
        let content_type = field.content_type().unwrap_or("application/octet-stream").to_owned();
        if !allowed_content_type(&content_type) {
            return (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(json!({"error": "That file type cannot be uploaded."}))).into_response();
        }
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(%error, "upload body read failed");
                return (StatusCode::BAD_REQUEST, Json(json!({"error": "Could not read uploaded file."}))).into_response();
            }
        };
        if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error": "Files must be between 1 byte and 25 MB."}))).into_response();
        }
        uploaded = Some((filename, content_type, bytes.to_vec()));
    }

    let Some((filename, content_type, bytes)) = uploaded else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Choose a file to upload."}))).into_response();
    };

    let id = Uuid::new_v4().to_string();
    let object_key = format!("mallowcord/{server_id}/{channel_id}/{id}");
    let object_path = ObjectPath::from(object_key.as_str());
    let payload = Bytes::from(bytes.clone()).into();
    if let Err(error) = store.put(&object_path, payload).await {
        tracing::error!(%error, "object storage upload failed");
        return (StatusCode::BAD_GATEWAY, Json(json!({"error": "File storage is temporarily unavailable."}))).into_response();
    }

    let insert = sqlx::query(
        "INSERT INTO message_attachments(id, channel_id, uploader_id, filename, content_type, size, object_key, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&channel_id)
    .bind(&user.id)
    .bind(&filename)
    .bind(&content_type)
    .bind(bytes.len() as i64)
    .bind(&object_key)
    .bind(now())
    .execute(&pool)
    .await;
    if let Err(error) = insert {
        tracing::error!(%error, "attachment metadata insert failed");
        if let Err(cleanup_error) = store.delete(&object_path).await {
            tracing::error!(%cleanup_error, "failed to clean up unreferenced uploaded object");
        }
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "File metadata could not be saved."}))).into_response();
    }

    (
        StatusCode::CREATED,
        Json(json!({"attachment": {
            "id": id,
            "filename": filename,
            "content_type": content_type,
            "size": bytes.len()
        }})),
    )
        .into_response()
}

#[derive(FromRow)]
struct AttachmentAccess {
    channel_id: String,
    uploader_id: String,
    message_id: Option<String>,
    filename: String,
    content_type: String,
    object_key: String,
}

async fn attachment_metadata(
    pool: &PgPool,
    id: &str,
) -> Result<Option<AttachmentAccess>, sqlx::Error> {
    sqlx::query_as::<_, AttachmentAccess>(
        "SELECT channel_id, uploader_id, message_id, filename, content_type, object_key
         FROM message_attachments WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

async fn get_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attachment_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let metadata = match attachment_metadata(&pool, &attachment_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Attachment not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "attachment metadata lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "attachment_lookup_failed"}))).into_response();
        }
    };
    if metadata.message_id.is_none() {
        if metadata.uploader_id != user.id {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot access this upload."}))).into_response();
        }
    } else if let Err(response) = channel_access(&pool, &user, &metadata.channel_id, "view_channel").await {
        return *response;
    }

    let Some(store) = state.object_store.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Object storage is not configured yet."}))).into_response();
    };
    let path = ObjectPath::from(metadata.object_key.as_str());
    let object = match store.get(&path).await {
        Ok(object) => object,
        Err(error) => {
            tracing::error!(%error, "attachment object lookup failed");
            return (StatusCode::NOT_FOUND, Json(json!({"error": "Attachment file not found."}))).into_response();
        }
    };
    let bytes = match object.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(%error, "attachment object read failed");
            return (StatusCode::BAD_GATEWAY, Json(json!({"error": "Attachment storage is temporarily unavailable."}))).into_response();
        }
    };
    let inline = ["image/png", "image/jpeg", "image/gif", "image/webp"]
        .contains(&metadata.content_type.to_ascii_lowercase().as_str());
    let disposition = if inline { "inline" } else { "attachment" };
    let safe_filename = metadata.filename.replace('"', "");
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, if inline { HeaderValue::from_str(&metadata.content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")) } else { HeaderValue::from_static("application/octet-stream") })
        .header(CONTENT_DISPOSITION, format!("{disposition}; filename=\"{safe_filename}\""))
        .header(CACHE_CONTROL, "private, no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(bytes));
    match response {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "attachment response construction failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn delete_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(attachment_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let metadata = match attachment_metadata(&pool, &attachment_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Attachment not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "attachment metadata lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "attachment_lookup_failed"}))).into_response();
        }
    };
    if metadata.uploader_id != user.id || metadata.message_id.is_some() {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Only your unattached uploads can be removed."}))).into_response();
    }
    let Some(store) = state.object_store.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Object storage is not configured yet."}))).into_response();
    };
    let path = ObjectPath::from(metadata.object_key.as_str());
    if let Err(error) = store.delete(&path).await {
        tracing::error!(%error, "attachment object deletion failed");
        return (StatusCode::BAD_GATEWAY, Json(json!({"error": "Could not remove uploaded file."}))).into_response();
    }
    match sqlx::query("DELETE FROM message_attachments WHERE id = $1 AND uploader_id = $2 AND message_id IS NULL")
        .bind(&attachment_id)
        .bind(&user.id)
        .execute(&pool)
        .await
    {
        Ok(result) if result.rows_affected() > 0 => Json(json!({"ok": true})).into_response(),
        Ok(_) => (StatusCode::CONFLICT, Json(json!({"error": "Upload was already attached."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "attachment metadata deletion failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "attachment_delete_failed"}))).into_response()
        }
    }
}


async fn public_avatar(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> Response {
    let Some(pool) = state.database.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response();
    };
    let avatar = match sqlx::query_scalar::<_, Option<String>>(
        "SELECT avatar_url FROM user_profiles WHERE user_id = $1",
    )
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(Some(avatar))) => avatar,
        Ok(Some(None)) | Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(%error, "public avatar lookup failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if avatar.len() > 7 * 1024 * 1024 {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Some((metadata, encoded)) = avatar.split_once(',') else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(mime) = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = match mime {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/gif" => "image/gif",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let bytes = match STANDARD.decode(encoded) {
        Ok(bytes) if bytes.len() <= 5 * 1024 * 1024 => bytes,
        Ok(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mut response = Body::from(bytes).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300, stale-while-revalidate=60"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/public/avatars/{user_id}", get(public_avatar))
        .route("/api/channels/{channel_id}/attachments", post(upload_attachment))
        .route("/api/attachments/{attachment_id}", get(get_attachment).delete(delete_attachment))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
}
