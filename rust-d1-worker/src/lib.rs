use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use wasm_bindgen::JsValue;
use worker::*;

const EXPECTED_GUILD: &str = "1560367587542433812";
const MAX_SYNC_ITEMS: usize = 250;
const MAX_MESSAGE_BATCH: usize = 100;

#[derive(Deserialize)]
struct SyncPayload {
    guild_id: String,
    #[serde(default)] guild_name: Option<String>,
    #[serde(default)] icon_url: Option<String>,
    #[serde(default)] everyone_role_id: Option<String>,
    #[serde(default)] channels: Vec<ChannelInput>,
    #[serde(default)] roles: Vec<RoleInput>,
    #[serde(default)] members: Vec<MemberInput>,
    #[serde(default)] emojis: Vec<EmojiInput>,
}

#[derive(Deserialize)]
struct ChannelInput {
    id: String,
    name: String,
    #[serde(default)] position: i32,
    #[serde(default)] category: Option<String>,
    #[serde(default)] overwrites: Vec<OverwriteInput>,
}

#[derive(Deserialize)]
struct OverwriteInput {
    id: String,
    #[serde(default)] target_type: String,
    #[serde(default)] allow: Vec<String>,
    #[serde(default)] deny: Vec<String>,
}

#[derive(Deserialize)]
struct EmojiInput {
    id: String,
    name: String,
    image_url: String,
}

#[derive(Deserialize)]
struct RoleInput {
    id: String,
    name: String,
    #[serde(default)] position: i32,
    #[serde(default)] color: Option<String>,
}

#[derive(Deserialize)]
struct MemberInput {
    id: String,
    username: String,
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] avatar_url: Option<String>,
    #[serde(default)] roles: Vec<String>,
    #[serde(default)] status: Option<String>,
    #[serde(default)] bot: bool,
}

#[derive(Deserialize)]
struct MessageBatch {
    guild_id: String,
    messages: Vec<MessageInput>,
}

#[derive(Deserialize)]
struct PresenceInput {
    guild_id: String,
    user_id: String,
    status: String,
}

#[derive(Deserialize)]
struct SingleMessagePayload {
    guild_id: String,
    #[serde(flatten)]
    message: MessageInput,
}

#[derive(Deserialize)]
struct MessageInput {
    message_id: String,
    channel_id: String,
    author_id: String,
    #[serde(default)] username: Option<String>,
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] avatar_url: Option<String>,
    content: String,
    #[serde(default)] timestamp: Option<i64>,
}

#[derive(Deserialize)]
struct SystemServer {
    id: String,
    owner_id: String,
}

#[derive(Deserialize)]
struct IdRow { id: String }

#[derive(Deserialize)]
struct LinkRow { mallow_channel_id: String }

#[derive(Deserialize)]
struct ExistsRow { present: i32 }

#[derive(Deserialize)]
struct MessageLinkRow { discord_message_id: String }

#[derive(Deserialize)]
struct ChannelLinkRow { discord_channel_id: String, mallow_channel_id: String }

#[derive(Deserialize)]
struct DiscordUserRow { discord_user_id: String, user_id: String }

#[derive(Deserialize)]
struct UserNameRow { id: String, username_key: String }

#[derive(Deserialize)]
struct UserRow { user_id: String }

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
    database: &'static str,
}

fn response<T: Serialize>(value: &T, status: u16) -> Result<Response> {
    Ok(Response::from_json(value)?.with_status(status))
}

fn text(value: &str) -> JsValue { JsValue::from_str(value) }
fn number(value: i64) -> JsValue { JsValue::from_f64(value as f64) }
fn new_id() -> String { Uuid::new_v4().to_string() }
fn now() -> i64 { (js_sys::Date::now() / 1000.0) as i64 }

async fn system_server(db: &D1Database) -> Result<SystemServer> {
    if let Some(server) = db.prepare(
        "SELECT id, owner_id FROM servers WHERE is_system=1 LIMIT 1"
    ).first::<SystemServer>(None).await? {
        return Ok(server);
    }

    let owner = db.prepare(
        "SELECT id FROM users WHERE account_type='owner' ORDER BY created_at LIMIT 1"
    ).first::<IdRow>(None).await?
        .ok_or_else(|| Error::RustError("Mallow Swamp owner account is missing".into()))?;

    let server_id = new_id();
    let everyone_id = new_id();
    let member_id = new_id();
    let channel_id = new_id();
    let timestamp = now();
    let statements = vec![
        db.prepare("INSERT INTO servers(id,name,owner_id,is_system,created_at) VALUES(?,'Mallow Swamp',?,1,?)")
            .bind(&[text(&server_id), text(&owner.id), number(timestamp)])?,
        db.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?,'@everyone',1,0)")
            .bind(&[text(&everyone_id), text(&server_id)])?,
        db.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?,'@Member',1,1)")
            .bind(&[text(&member_id), text(&server_id)])?,
        db.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?,'general','text',0)")
            .bind(&[text(&channel_id), text(&server_id)])?,
    ];
    db.batch(statements).await?;
    Ok(SystemServer { id: server_id, owner_id: owner.id })
}

async fn sync_discord(db: &D1Database, payload: SyncPayload) -> Result<Value> {
    if payload.guild_id != EXPECTED_GUILD {
        return Ok(json!({"error":"This bridge is restricted to the configured official Discord server."}));
    }
    if payload.channels.len() > MAX_SYNC_ITEMS || payload.roles.len() > MAX_SYNC_ITEMS
        || payload.members.len() > MAX_SYNC_ITEMS {
        return Ok(json!({"error":"A sync batch may contain at most 250 items per collection."}));
    }

    let server = system_server(db).await?;
    let timestamp = now();

    if let Some(icon) = payload.icon_url.as_deref().filter(|v| v.starts_with("https://")) {
        db.prepare("UPDATE servers SET icon_url=? WHERE id=?")
            .bind(&[text(icon), text(&server.id)])?.run().await?;
    }

    let everyone = db.prepare("SELECT id FROM roles WHERE server_id=? AND name='@everyone'")
        .bind(&[text(&server.id)])?.first::<IdRow>(None).await?;
    let member_role = db.prepare("SELECT id FROM roles WHERE server_id=? AND name='@Member'")
        .bind(&[text(&server.id)])?.first::<IdRow>(None).await?;

    let mut channel_map = Vec::new();
    let mut channel_ids = std::collections::HashMap::new();
    let mut channel_writes = Vec::new();
    for channel in payload.channels.iter() {
        let discord_id = channel.id.trim();
        let name = channel.name.trim();
        if discord_id.is_empty() || name.len() < 2 { continue; }
        let linked = db.prepare("SELECT mallow_channel_id FROM discord_channel_links WHERE discord_channel_id=?")
            .bind(&[text(discord_id)])?.first::<LinkRow>(None).await?;
        let existing = if linked.is_none() {
            db.prepare("SELECT id FROM channels WHERE server_id=? AND name=? AND kind='text' LIMIT 1")
                .bind(&[text(&server.id), text(name)])?.first::<IdRow>(None).await?
        } else { None };
        let channel_id = linked.map(|r| r.mallow_channel_id)
            .or_else(|| existing.map(|r| r.id)).unwrap_or_else(new_id);
        channel_writes.push(db.prepare(
            "INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?,?,'text',?)              ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position"
        ).bind(&[text(&channel_id), text(&server.id), text(name), number(channel.position as i64)])?);
        channel_writes.push(db.prepare(
            "INSERT INTO discord_channel_links(discord_channel_id,server_id,mallow_channel_id,category_name,updated_at)              VALUES(?,?,?,?,?) ON CONFLICT(discord_channel_id) DO UPDATE SET              server_id=excluded.server_id,mallow_channel_id=excluded.mallow_channel_id,             category_name=excluded.category_name,updated_at=excluded.updated_at"
        ).bind(&[
            text(discord_id), text(&server.id), text(&channel_id),
            text(channel.category.as_deref().unwrap_or("")), number(timestamp)
        ])?);
        channel_ids.insert(discord_id.to_owned(), channel_id.clone());
        channel_map.push(json!({"discord_id":discord_id,"mallow_id":channel_id,"name":name}));
    }
    for chunk in channel_writes.chunks(400) {
        db.batch(chunk.to_vec()).await?;
    }

    let mut role_map = Vec::new();
    let mut role_ids = std::collections::HashMap::new();
    let mut role_writes = Vec::new();
    for role in payload.roles.iter() {
        let discord_id = role.id.trim();
        let name = role.name.trim();
        if discord_id.is_empty() || name.is_empty() || name == "@everyone" { continue; }
        let linked = db.prepare("SELECT role_id AS id FROM discord_role_links WHERE discord_role_id=?")
            .bind(&[text(discord_id)])?.first::<IdRow>(None).await?;
        let existing = if linked.is_none() {
            db.prepare("SELECT id FROM roles WHERE server_id=? AND name=? LIMIT 1")
                .bind(&[text(&server.id), text(name)])?.first::<IdRow>(None).await?
        } else { None };
        let role_id = linked.map(|r| r.id).or_else(|| existing.map(|r| r.id)).unwrap_or_else(new_id);
        let color = role.color.as_deref().filter(|v| v.len()==7 && v.starts_with('#')
            && v[1..].bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or("#99aab5");
        role_writes.push(db.prepare(
            "INSERT INTO roles(id,server_id,name,is_system,position,color) VALUES(?,?,?,0,?,?)              ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position,color=excluded.color"
        ).bind(&[text(&role_id),text(&server.id),text(name),number(role.position as i64),text(color)])?);
        role_writes.push(db.prepare(
            "INSERT INTO discord_role_links(discord_role_id,server_id,role_id) VALUES(?,?,?)              ON CONFLICT(discord_role_id) DO UPDATE SET server_id=excluded.server_id,role_id=excluded.role_id"
        ).bind(&[text(discord_id),text(&server.id),text(&role_id)])?);
        role_ids.insert(discord_id.to_owned(), role_id.clone());
        role_map.push(json!({"discord_id":discord_id,"mallow_id":role_id}));
    }
    for chunk in role_writes.chunks(400) { db.batch(chunk.to_vec()).await?; }

    let allowed_permissions = ["view_channel","send_messages","read_message_history","attach_files","embed_links","manage_messages"];
    let mut permission_writes = Vec::new();
    for channel in payload.channels.iter() {
        let Some(channel_id) = channel_ids.get(&channel.id) else { continue; };
        for overwrite in channel.overwrites.iter() {
            let target_type = if overwrite.target_type == "user" { "user" } else { "role" };
            let target_id = if target_type == "role" {
                if overwrite.id == payload.everyone_role_id.as_deref().unwrap_or(&payload.guild_id) {
                    everyone.as_ref().map(|r| r.id.clone())
                } else if let Some(mapped) = role_ids.get(&overwrite.id) {
                    Some(mapped.clone())
                } else {
                    db.prepare("SELECT role_id AS id FROM discord_role_links WHERE discord_role_id=? AND server_id=?")
                        .bind(&[text(&overwrite.id),text(&server.id)])?
                        .first::<IdRow>(None).await?.map(|r|r.id)
                }
            } else {
                let linked = db.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?")
                    .bind(&[text(&overwrite.id),text(&server.id)])?.first::<UserRow>(None).await?;
                if let Some(row) = linked { Some(row.user_id) } else {
                    db.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?")
                        .bind(&[text(&overwrite.id),text(&server.id)])?
                        .first::<UserRow>(None).await?.map(|r|r.user_id)
                }
            };
            let Some(target_id) = target_id else { continue; };
            let allow: Vec<&str> = overwrite.allow.iter().map(String::as_str).filter(|p| allowed_permissions.contains(p)).collect();
            let deny: Vec<&str> = overwrite.deny.iter().map(String::as_str).filter(|p| allowed_permissions.contains(p)).collect();
            permission_writes.push(db.prepare(
                "INSERT INTO channel_permissions(channel_id,target_type,target_id,allow_json,deny_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET allow_json=excluded.allow_json,deny_json=excluded.deny_json,updated_at=excluded.updated_at"
            ).bind(&[text(channel_id),text(target_type),text(&target_id),text(&serde_json::to_string(&allow)?),text(&serde_json::to_string(&deny)?),number(timestamp)])?);
        }
        if channel.name.eq_ignore_ascii_case("rules") || channel.name.eq_ignore_ascii_case("server-rules") {
            if let Some(role) = everyone.as_ref() {
                permission_writes.push(db.prepare(
                    "INSERT INTO channel_permissions(channel_id,target_type,target_id,allow_json,deny_json,updated_at) VALUES(?,'role',?,'[]','[\"send_messages\"]',?) ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET deny_json='[\"send_messages\"]',updated_at=excluded.updated_at"
                ).bind(&[text(channel_id),text(&role.id),number(timestamp)])?);
            }
        }
    }
    for chunk in permission_writes.chunks(400) { db.batch(chunk.to_vec()).await?; }

    let mut emoji_writes = Vec::new();
    for emoji in payload.emojis.iter().take(MAX_SYNC_ITEMS) {
        let discord_id = emoji.id.trim();
        let name: String = emoji.name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(32).collect();
        if discord_id.is_empty() || name.len() < 2 || !emoji.image_url.starts_with("https://") { continue; }
        let linked = db.prepare("SELECT emoji_id AS id FROM discord_emoji_links WHERE discord_emoji_id=? AND server_id=?")
            .bind(&[text(discord_id),text(&server.id)])?.first::<IdRow>(None).await?;
        let existing = if linked.is_none() {
            db.prepare("SELECT id FROM server_emojis WHERE server_id=? AND name=?")
                .bind(&[text(&server.id),text(&name)])?.first::<IdRow>(None).await?
        } else { None };
        let emoji_id = linked.map(|r|r.id).or_else(||existing.map(|r|r.id)).unwrap_or_else(new_id);
        emoji_writes.push(db.prepare(
            "INSERT INTO server_emojis(id,server_id,name,image_url,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_url=excluded.image_url"
        ).bind(&[text(&emoji_id),text(&server.id),text(&name),text(&emoji.image_url),text(&server.owner_id),number(timestamp)])?);
        emoji_writes.push(db.prepare(
            "INSERT INTO discord_emoji_links(discord_emoji_id,server_id,emoji_id) VALUES(?,?,?) ON CONFLICT(discord_emoji_id) DO UPDATE SET server_id=excluded.server_id,emoji_id=excluded.emoji_id"
        ).bind(&[text(discord_id),text(&server.id),text(&emoji_id)])?);
    }
    for chunk in emoji_writes.chunks(400) { db.batch(chunk.to_vec()).await?; }

    let mut member_writes = Vec::new();
    let mut member_count = 0usize;
    for member in payload.members.iter().filter(|m| !m.bot) {
        let discord_id = member.id.trim();
        if discord_id.is_empty() { continue; }
        let username = format!("discord_{}", discord_id);
        let user_id = db.prepare("SELECT id FROM users WHERE username_key=?")
            .bind(&[text(&username.to_lowercase())])?.first::<IdRow>(None).await?
            .map(|row| row.id).unwrap_or_else(|| format!("discord:{}", discord_id));
        let display = member.display_name.as_deref().unwrap_or(&member.username);
        let avatar = member.avatar_url.as_deref().filter(|v| v.starts_with("https://")).unwrap_or("");
        let account = db.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?")
            .bind(&[text(discord_id),text(&server.id)])?.first::<UserRow>(None).await?;
        let membership_user = account.map(|r| r.user_id).unwrap_or_else(|| user_id.clone());
        member_writes.push(db.prepare(
            "INSERT OR IGNORE INTO users(id,username,username_key,account_type,status,created_at,updated_at)              VALUES(?,?,?,'basic','active',?,?)"
        ).bind(&[text(&user_id),text(&username),text(&username.to_lowercase()),number(timestamp),number(timestamp)])?);
        member_writes.push(db.prepare(
            "INSERT INTO user_profiles(user_id,display_name,avatar_url,status,discord_username,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,status=excluded.status,discord_username=excluded.discord_username,updated_at=excluded.updated_at"
        ).bind(&[
            text(&user_id), text(display), text(avatar),
            text(match member.status.as_deref() { Some("online") => "online", Some("idle") => "idle", Some("dnd") => "dnd", _ => "offline" }),
            text(&member.username), number(timestamp)
        ])?);
        member_writes.push(db.prepare(
            "INSERT INTO discord_user_links(discord_user_id,server_id,user_id,updated_at) VALUES(?,?,?,?)              ON CONFLICT(discord_user_id) DO UPDATE SET server_id=excluded.server_id,user_id=excluded.user_id,updated_at=excluded.updated_at"
        ).bind(&[text(discord_id),text(&server.id),text(&user_id),number(timestamp)])?);
        member_writes.push(db.prepare(
            "INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)"
        ).bind(&[text(&server.id),text(&membership_user),number(timestamp)])?);
        if let Some(role) = everyone.as_ref() {
            member_writes.push(db.prepare(
                "INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)"
            ).bind(&[text(&server.id),text(&membership_user),text(&role.id)])?);
        }
        if let Some(role) = member_role.as_ref() {
            member_writes.push(db.prepare(
                "INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)"
            ).bind(&[text(&server.id),text(&membership_user),text(&role.id)])?);
        }
        for discord_role in member.roles.iter() {
            let mapped = if let Some(value) = role_ids.get(discord_role) {
                Some(value.clone())
            } else {
                db.prepare("SELECT role_id AS id FROM discord_role_links WHERE discord_role_id=? AND server_id=?")
                    .bind(&[text(discord_role),text(&server.id)])?
                    .first::<IdRow>(None).await?.map(|row| row.id)
            };
            if let Some(mapped) = mapped {
                member_writes.push(db.prepare(
                    "INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)"
                ).bind(&[text(&server.id),text(&membership_user),text(&mapped)])?);
            }
        }
        member_count += 1;
        if member_writes.len() >= 350 {
            db.batch(std::mem::take(&mut member_writes)).await?;
        }
    }
    if !member_writes.is_empty() { db.batch(member_writes).await?; }

    Ok(json!({
        "ok":true,"server_id":server.id,"channels":channel_map.len(),
        "roles":role_map.len(),"members":member_count,"channel_map":channel_map
    }))
}

async fn sync_messages(db: &D1Database, payload: MessageBatch) -> Result<Value> {
    if payload.guild_id != EXPECTED_GUILD {
        return Ok(json!({"error":"This bridge is restricted to the configured official Discord server."}));
    }
    if payload.messages.len() > MAX_MESSAGE_BATCH {
        return Ok(json!({"error":"A message batch may contain at most 100 messages."}));
    }

    let server = system_server(db).await?;
    let timestamp = now();
    let valid: Vec<&MessageInput> = payload.messages.iter().filter(|message| {
        !message.message_id.trim().is_empty()
            && !message.channel_id.trim().is_empty()
            && !message.author_id.trim().is_empty()
            && !message.content.trim().is_empty()
            && message.content.trim().len() <= 4000
    }).collect();
    if valid.is_empty() {
        return Ok(json!({"ok":true,"accepted":0}));
    }

    let mut message_ids = std::collections::HashSet::new();
    let mut channel_ids = std::collections::HashSet::new();
    let mut author_ids = std::collections::HashSet::new();
    for message in &valid {
        message_ids.insert(message.message_id.trim().to_owned());
        channel_ids.insert(message.channel_id.trim().to_owned());
        author_ids.insert(message.author_id.trim().to_owned());
    }
    let message_ids: Vec<String> = message_ids.into_iter().collect();
    let channel_ids: Vec<String> = channel_ids.into_iter().collect();
    let author_ids: Vec<String> = author_ids.into_iter().collect();
    let placeholders = |count: usize| std::iter::repeat("?").take(count).collect::<Vec<_>>().join(",");

    // Read each lookup set once per batch instead of issuing 4-5 SELECTs for
    // every message. This keeps large history imports inside D1's daily read budget.
    let mut message_params: Vec<JsValue> = message_ids.iter().map(|id| text(id)).collect();
    let existing_messages = db.prepare(&format!(
        "SELECT discord_message_id FROM discord_message_links WHERE discord_message_id IN ({})",
        placeholders(message_ids.len())
    )).bind(&message_params)?.all().await?.results::<MessageLinkRow>()?;
    let mut seen_messages: std::collections::HashSet<String> =
        existing_messages.into_iter().map(|row| row.discord_message_id).collect();
    message_params.clear();

    let mut channel_params = vec![text(&server.id)];
    channel_params.extend(channel_ids.iter().map(|id| text(id)));
    let channels = db.prepare(&format!(
        "SELECT discord_channel_id,mallow_channel_id FROM discord_channel_links WHERE server_id=? AND discord_channel_id IN ({})",
        placeholders(channel_ids.len())
    )).bind(&channel_params)?.all().await?.results::<ChannelLinkRow>()?;
    let channel_map: std::collections::HashMap<String,String> =
        channels.into_iter().map(|row|(row.discord_channel_id,row.mallow_channel_id)).collect();

    let mut author_params = vec![text(&server.id)];
    author_params.extend(author_ids.iter().map(|id| text(id)));
    let account_links = db.prepare(&format!(
        "SELECT discord_user_id,user_id FROM discord_account_links WHERE server_id=? AND discord_user_id IN ({})",
        placeholders(author_ids.len())
    )).bind(&author_params)?.all().await?.results::<DiscordUserRow>()?;
    let mut user_map: std::collections::HashMap<String,String> =
        account_links.into_iter().map(|row|(row.discord_user_id,row.user_id)).collect();

    let mut shadow_params = vec![text(&server.id)];
    shadow_params.extend(author_ids.iter().map(|id| text(id)));
    let shadow_links = db.prepare(&format!(
        "SELECT discord_user_id,user_id FROM discord_user_links WHERE server_id=? AND discord_user_id IN ({})",
        placeholders(author_ids.len())
    )).bind(&shadow_params)?.all().await?.results::<DiscordUserRow>()?;
    for row in shadow_links {
        user_map.entry(row.discord_user_id).or_insert(row.user_id);
    }

    let usernames: Vec<String> = author_ids.iter().map(|id|format!("discord_{}",id).to_lowercase()).collect();
    let username_params: Vec<JsValue> = usernames.iter().map(|name|text(name)).collect();
    let existing_users = db.prepare(&format!(
        "SELECT id,username_key FROM users WHERE username_key IN ({})",
        placeholders(usernames.len())
    )).bind(&username_params)?.all().await?.results::<UserNameRow>()?;
    let mut username_map: std::collections::HashMap<String,String> =
        existing_users.into_iter().map(|row|(row.username_key,row.id)).collect();

    let everyone = db.prepare("SELECT id FROM roles WHERE server_id=? AND name='@everyone'")
        .bind(&[text(&server.id)])?.first::<IdRow>(None).await?;
    let member_role = db.prepare("SELECT id FROM roles WHERE server_id=? AND name='@Member'")
        .bind(&[text(&server.id)])?.first::<IdRow>(None).await?;

    let mut author_map = std::collections::HashMap::new();
    let mut user_writes = Vec::new();
    for author_id in author_ids.iter() {
        let username = format!("discord_{}",author_id);
        let user_id = user_map.get(author_id).cloned().or_else(||username_map.get(&username.to_lowercase()).cloned())
            .unwrap_or_else(||format!("discord:{}",author_id));
        user_map.insert(author_id.clone(),user_id.clone());
        author_map.insert(author_id.clone(),user_id.clone());
        user_writes.push(db.prepare(
            "INSERT OR IGNORE INTO users(id,username,username_key,account_type,status,created_at,updated_at) VALUES(?,?,?,'basic','active',?,?)"
        ).bind(&[text(&user_id),text(&username),text(&username.to_lowercase()),number(timestamp),number(timestamp)])?);

        let sample = valid.iter().find(|message|message.author_id.trim()==author_id.as_str()).copied();
        let display = sample.and_then(|m|m.display_name.as_deref().or(m.username.as_deref())).unwrap_or(&username);
        let avatar = sample.and_then(|m|m.avatar_url.as_deref()).filter(|v|v.starts_with("https://")).unwrap_or("");
        user_writes.push(db.prepare(
            "INSERT INTO user_profiles(user_id,display_name,avatar_url,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at"
        ).bind(&[text(&user_id),text(display),text(avatar),number(timestamp)])?);
        user_writes.push(db.prepare(
            "INSERT INTO discord_user_links(discord_user_id,server_id,user_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET server_id=excluded.server_id,user_id=excluded.user_id,updated_at=excluded.updated_at"
        ).bind(&[text(author_id),text(&server.id),text(&user_id),number(timestamp)])?);
        user_writes.push(db.prepare(
            "INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)"
        ).bind(&[text(&server.id),text(&user_id),number(timestamp)])?);
        if let Some(role) = everyone.as_ref() {
            user_writes.push(db.prepare(
                "INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)"
            ).bind(&[text(&server.id),text(&user_id),text(&role.id)])?);
        }
        if let Some(role) = member_role.as_ref() {
            user_writes.push(db.prepare(
                "INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)"
            ).bind(&[text(&server.id),text(&user_id),text(&role.id)])?);
        }
    }
    for chunk in user_writes.chunks(400) { db.batch(chunk.to_vec()).await?; }

    let mut message_writes = Vec::new();
    let mut accepted = 0usize;
    for message in valid {
        let discord_id = message.message_id.trim();
        if !seen_messages.insert(discord_id.to_owned()) { continue; }
        let Some(channel_id) = channel_map.get(message.channel_id.trim()) else { continue; };
        let Some(author_id) = author_map.get(message.author_id.trim()) else { continue; };
        let message_id = new_id();
        let created = message.timestamp.unwrap_or(timestamp);
        message_writes.push(db.prepare(
            "INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)"
        ).bind(&[text(&message_id),text(channel_id),text(author_id),text(message.content.trim()),number(created)])?);
        message_writes.push(db.prepare(
            "INSERT OR IGNORE INTO discord_message_links(discord_message_id,mallow_message_id,discord_channel_id) VALUES(?,?,?)"
        ).bind(&[text(discord_id),text(&message_id),text(message.channel_id.trim())])?);
        accepted += 1;
    }
    for chunk in message_writes.chunks(400) { db.batch(chunk.to_vec()).await?; }

    Ok(json!({"ok":true,"accepted":accepted}))
}

#[event(fetch)]
pub async fn main(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    let method = req.method();

    if method == Method::Options {
        return Ok(Response::empty()?.with_status(204));
    }
    if path == "/health" && method == Method::Get {
        return response(&Health { status:"ok", service:"mallowcord-rust-d1", database:"bound" }, 200);
    }

    let db = env.d1("DB")?;
    if path == "/ready" && method == Method::Get {
        let check = db.prepare("SELECT 1 AS present").first::<ExistsRow>(None).await;
        return match check {
            Ok(_) => response(&json!({"status":"ready","database":"connected"}),200),
            Err(_) => response(&json!({"status":"not_ready","database":"unavailable"}),503),
        };
    }

    let configured_key = env.var("MALLOWBOT_SERVICE_KEY")
        .map(|v| v.to_string()).unwrap_or_default();
    let supplied_key = req.headers().get("X-MallowBot-Key")?.unwrap_or_default();
    if configured_key.is_empty() || supplied_key != configured_key {
        return response(&json!({"error":"Integration authentication failed."}),401);
    }

    if path == "/api/integrations/mallowbot/discord/sync" && method == Method::Post {
        let payload: SyncPayload = req.json().await?;
        if payload.guild_id != EXPECTED_GUILD {
            return response(&json!({"error":"This bridge is restricted to the configured official Discord server."}),403);
        }
        let result = match sync_discord(&db,payload).await {
            Ok(value) => value,
            Err(error) => {
                // Return a structured diagnostic to the authenticated bridge instead
                // of Cloudflare's generic plain-text 500 response. This makes D1
                // schema/constraint failures actionable in the bot logs.
                return response(&json!({"error":"Discord sync failed","detail":error.to_string()}),500);
            }
        };
        if result.get("error").is_some() { return response(&result,400); }
        return response(&result,200);
    }

    if path == "/api/integrations/mallowbot/discord/presence" && method == Method::Post {
        let payload: PresenceInput = req.json().await?;
        if payload.guild_id != EXPECTED_GUILD {
            return response(&json!({"error":"This bridge is restricted to the configured official Discord server."}),403);
        }
        let status = match payload.status.as_str() {
            "online" | "idle" | "dnd" | "offline" => payload.status.as_str(),
            _ => "offline",
        };
        let server = system_server(&db).await?;
        let linked = db.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?")
            .bind(&[text(&payload.user_id),text(&server.id)])?.first::<UserRow>(None).await?
            .or(db.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?")
                .bind(&[text(&payload.user_id),text(&server.id)])?.first::<UserRow>(None).await?);
        let ignored = linked.is_none();
        if let Some(user) = linked.as_ref() {
            db.prepare("UPDATE user_profiles SET status=?,updated_at=? WHERE user_id=?")
                .bind(&[text(status),number(now()),text(&user.user_id)])?.run().await?;
        }
        return response(&json!({"ok":true,"ignored":ignored}),200);
    }

    if path == "/api/integrations/mallowbot/discord/messages" && method == Method::Post {
        let payload: SingleMessagePayload = req.json().await?;
        if payload.guild_id != EXPECTED_GUILD {
            return response(&json!({"error":"This bridge is restricted to the configured official Discord server."}),403);
        }
        let result = sync_messages(&db,MessageBatch { guild_id: payload.guild_id, messages: vec![payload.message] }).await?;
        if result.get("error").is_some() { return response(&result,400); }
        return response(&result,200);
    }

    if path == "/api/integrations/mallowbot/discord/messages/batch" && method == Method::Post {
        let payload: MessageBatch = req.json().await?;
        if payload.guild_id != EXPECTED_GUILD {
            return response(&json!({"error":"This bridge is restricted to the configured official Discord server."}),403);
        }
        let result = sync_messages(&db,payload).await?;
        if result.get("error").is_some() { return response(&result,400); }
        return response(&result,200);
    }

    response(&json!({"error":"Not found"}),404)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_are_bounded() {
        assert_eq!(MAX_SYNC_ITEMS,250);
        assert_eq!(MAX_MESSAGE_BATCH,100);
        assert_eq!(EXPECTED_GUILD,"1560367587542433812");
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(new_id(),new_id());
    }
}
