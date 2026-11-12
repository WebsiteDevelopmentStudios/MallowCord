use object_store::{aws::AmazonS3Builder, ObjectStore};
use std::{env, sync::Arc};

pub(crate) fn from_env() -> Option<Arc<dyn ObjectStore>> {
    let endpoint = env::var("MALLOWCORD_OBJECT_STORE_ENDPOINT").ok()?;
    let region = env::var("MALLOWCORD_OBJECT_STORE_REGION").ok()?;
    let bucket = env::var("MALLOWCORD_OBJECT_STORE_BUCKET").ok()?;
    let access_key = env::var("MALLOWCORD_OBJECT_STORE_ACCESS_KEY").ok()?;
    let secret_key = env::var("MALLOWCORD_OBJECT_STORE_SECRET_KEY").ok()?;

    if endpoint.is_empty() || region.is_empty() || bucket.is_empty()
        || access_key.is_empty() || secret_key.is_empty()
    {
        tracing::warn!("object storage is not configured; upload routes will return 503");
        return None;
    }

    match AmazonS3Builder::new()
        .with_bucket_name(bucket)
        .with_region(region)
        .with_endpoint(endpoint)
        .with_access_key_id(access_key)
        .with_secret_access_key(secret_key)
        .with_virtual_hosted_style_request(false)
        .build()
    {
        Ok(store) => {
            tracing::info!("S3-compatible object storage configured");
            Some(Arc::new(store))
        }
        Err(error) => {
            tracing::error!(%error, "failed to configure S3-compatible object storage");
            None
        }
    }
}
