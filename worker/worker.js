const COOKIE="mallowcord_device",DAYS=30;
const now=()=>Math.floor(Date.now()/1000),uid=()=>crypto.randomUUID();
const json=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...h}});
const fail=(e,s=400)=>json({error:e},s),hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
const sha=async v=>hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,"0")).join("");
const setCookie=v=>COOKIE+"="+v+"; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age="+(DAYS*86400);
const clearCookie=()=>COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0";
const ip=req=>req.headers.get("CF-Connecting-IP")||"";
const ipDigest=async(req,env)=>ip(req)?sha(ip(req)+env.IP_HASH_SECRET):null;
async function passwordHash(password,salt){salt=salt||token().slice(0,32);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new TextEncoder().encode(salt),iterations:100000,hash:"SHA-256"},key,256);return "pbkdf2$"+salt+"$"+hex(bits);}
async function passwordCheck(password,stored){if(!stored)return false;const p=stored.split("$");if(p[0]!=="pbkdf2")return false;const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);for(const iterations of [100000,210000]){try{const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new TextEncoder().encode(p[1]),iterations,hash:"SHA-256"},key,256);if(hex(bits)===p[2])return true;}catch{}}return false;}
async function body(req){try{return await req.json()}catch{return {}}}
async function userFor(req,env){const c=(req.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="));if(!c)return null;const th=await sha(c.slice(COOKIE.length+1));const u=await env.DB.prepare("SELECT u.id,u.username,u.account_type,u.status,u.timeout_until,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(th,now()).first();if(!u||u.status==="banned"||u.status==="deleted")return null;if(u.status==="timed_out"&&u.timeout_until>now())u.timed_out=true;return u;}
const isOwner=u=>u&&u.account_type==="owner";
async function session(req,env,userId){const raw=token(),t=now();await env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at,user_agent,ip_hash) VALUES(?,?,?,?,?,?,?)").bind(uid(),userId,await sha(raw),t,t+DAYS*86400,req.headers.get("User-Agent")||"",await ipDigest(req,env)).run();return setCookie(raw);}
async function recovery(env,userId){const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let c="";const b=crypto.getRandomValues(new Uint8Array(20));for(let i=0;i<b.length;i++)c+=chars[b[i]%chars.length];c=c.match(/.{1,4}/g).join("-");await env.DB.prepare("DELETE FROM recovery_codes WHERE user_id=?").bind(userId).run();await env.DB.prepare("INSERT INTO recovery_codes(id,user_id,code_hash,created_at) VALUES(?,?,?,?)").bind(uid(),userId,await sha(c.replace(/-/g,"")),now()).run();return c;}
async function joinSwamp(env,userId){const s=await env.DB.prepare("SELECT id FROM servers WHERE is_system=1 LIMIT 1").first();if(!s)return;await env.DB.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(s.id,userId,now()).run();const rs=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name IN ('@everyone','@Member')").bind(s.id).all();for(const r of rs.results)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s.id,userId,r.id).run();}
async function audit(env,actor,target,action,details){await env.DB.prepare("INSERT INTO audit_logs(id,actor_id,target_user_id,action,details,created_at) VALUES(?,?,?,?,?,?)").bind(uid(),actor||null,target||null,action,details||"",now()).run();}

async function ensureChannelPermissionTable(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS channel_permissions(channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,target_type TEXT NOT NULL CHECK(target_type IN ('role','user')),target_id TEXT NOT NULL,allow_json TEXT NOT NULL DEFAULT '[]',deny_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,target_type,target_id))").run();
}
async function channelPermissionAllowed(env,channelId,userId,permission){
 await ensureChannelPermissionTable(env);
 const channel=await env.DB.prepare("SELECT server_id FROM channels WHERE id=?").bind(channelId).first();
 if(!channel)return false;
 const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(channel.server_id,userId).first();
 if(!member)return false;
 const roles=(await env.DB.prepare("SELECT role_id FROM member_roles WHERE server_id=? AND user_id=?").bind(channel.server_id,userId).all()).results.map(row=>String(row.role_id));
 const everyone=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name='@everyone'").bind(channel.server_id).first();
 if(everyone)roles.push(String(everyone.id));
 const rows=(await env.DB.prepare("SELECT target_type,target_id,allow_json,deny_json FROM channel_permissions WHERE channel_id=?").bind(channelId).all()).results;
 const parse=value=>{try{return JSON.parse(value||"[]")}catch{return []}};
 const userRows=rows.filter(row=>row.target_type==="user"&&row.target_id===userId);
 const roleRows=rows.filter(row=>row.target_type==="role"&&roles.includes(String(row.target_id)));
 if(userRows.some(row=>parse(row.deny_json).includes(permission)))return false;
 if(userRows.some(row=>parse(row.allow_json).includes(permission)))return true;
 if(roleRows.some(row=>parse(row.allow_json).includes(permission)))return true;
 if(roleRows.some(row=>parse(row.deny_json).includes(permission)))return false;
 return true;
}
async function bootstrap(env,secret){if(!env.BOOTSTRAP_SECRET||secret!==env.BOOTSTRAP_SECRET)throw Error("Invalid bootstrap secret.");if(await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first())return {already_initialized:true};if(!env.OWNER_PASSWORD||env.OWNER_PASSWORD.length<12)throw Error("Set OWNER_PASSWORD to at least 12 characters.");const t=now(),u=uid(),name=env.OWNER_USERNAME||"Blemmished";await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'owner',?,?,?)").bind(u,name,name.toLowerCase(),await passwordHash(env.OWNER_PASSWORD),t,t).run();const s=uid(),r1=uid(),r2=uid(),ch=uid();await env.DB.batch([env.DB.prepare("INSERT INTO servers(id,name,owner_id,icon_url,is_system,created_at) VALUES(?,?,?,?,1,?)").bind(s,"Mallow Swamp",u,env.MALLOWBOT_ICON_URL||null,t),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@everyone',1,0)").bind(r1,s),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@Member',1,1)").bind(r2,s),env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?, 'general','text',0)").bind(ch,s),env.DB.prepare("INSERT INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(s,u,t),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u,r1),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u,r2)]);return {initialized:true,owner:name,server:"Mallow Swamp"};}

const OAUTH_REDIRECTS={
 google:"https://mallowcord-api.wowgrayhaha.workers.dev/api/auth/google/callback",
 discord:"https://mallowcord-api.wowgrayhaha.workers.dev/api/auth/discord/callback"
};
async function ensureAccountTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,display_name TEXT,avatar_url TEXT,email TEXT,email_verified_at INTEGER,phone TEXT,phone_verified_at INTEGER,updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,settings_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS contact_verifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,channel TEXT NOT NULL,target TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN bio TEXT").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'online'").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN pronouns TEXT").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN discord_username TEXT").run().catch(()=>{});
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();
}
async function ensureOAuthTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY,provider TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_accounts(provider TEXT NOT NULL,provider_user_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,email TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,provider_user_id),UNIQUE(provider,user_id))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_login_codes(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
}
async function ensureBridgeSystemServer(env){
 let server=await env.DB.prepare("SELECT id,owner_id FROM servers WHERE is_system=1 LIMIT 1").first();
 if(server)return server;
 let owner=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' ORDER BY created_at LIMIT 1").first();
 if(!owner){
  const id=uid(),t=now();
  try{
   await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,created_at,updated_at) VALUES(?,'MallowSwampSystem','mallowswampsystem','owner',?,?)").bind(id,t,t).run();
   owner={id};
  }catch{
   owner=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' ORDER BY created_at LIMIT 1").first();
   if(!owner)throw Error("Could not create the Mallow Swamp system owner.");
  }
 }
 await ensureOAuthSystemServer(env,owner.id);
 return await env.DB.prepare("SELECT id,owner_id FROM servers WHERE is_system=1 LIMIT 1").first();
}
async function ensureOAuthSystemServer(env,userId){
 let server=await env.DB.prepare("SELECT id,owner_id FROM servers WHERE is_system=1 LIMIT 1").first();
 if(!server){
  const sid=uid(),everyone=uid(),member=uid(),channel=uid(),t=now();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO servers(id,name,owner_id,icon_url,is_system,created_at) VALUES(?,?,?,?,1,?)").bind(sid,"Mallow Swamp",userId,env.MALLOWBOT_ICON_URL||null,t),
   env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@everyone',1,0)").bind(everyone,sid),
   env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@Member',1,1)").bind(member,sid),
   env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?, 'general','text',0)").bind(channel,sid)
  ]);
  server={id:sid,owner_id:userId};
 }
 const account=await env.DB.prepare("SELECT account_type FROM users WHERE id=?").bind(userId).first();
 if(account?.account_type==="owner"&&server.owner_id!==userId){
  await env.DB.prepare("UPDATE servers SET owner_id=? WHERE id=?").bind(userId,server.id).run();
 }
 await env.DB.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(server.id,userId,now()).run();
 const roles=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name IN ('@everyone','@Member')").bind(server.id).all();
 for(const role of roles.results)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(server.id,userId,role.id).run();
}
function oauthFailure(env,provider){
 const origin=String(env.FRONTEND_ORIGIN||"");
 if(!origin)return new Response("OAuth frontend is not configured.",{status:503});
 const target=new URL("/",origin);target.searchParams.set("login_error",provider);
 return Response.redirect(target.toString(),302);
}
async function oauthDiagnostic(env,provider,stage,detail={}){
 try{
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_diagnostics(id TEXT PRIMARY KEY,provider TEXT NOT NULL,stage TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await env.DB.prepare("INSERT INTO oauth_diagnostics(id,provider,stage,detail,created_at) VALUES(?,?,?,?,?)").bind(uid(),provider,String(stage).slice(0,100),JSON.stringify(detail).slice(0,4000),now()).run();
 }catch(error){console.error("OAuth diagnostic logging failed",String(error?.message||error));}
}
async function oauthStart(req,env,provider){
 await ensureOAuthTables(env);
 const clientId=provider==="google"?env.GOOGLE_CLIENT_ID:env.DISCORD_CLIENT_ID;
 if(!clientId||!env.FRONTEND_ORIGIN)return fail("OAuth is not configured yet.",503);
 const state=token(),created=now();
 await env.DB.prepare("INSERT INTO oauth_states(state_hash,provider,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha(state),provider,created+600,created).run();
 const auth=provider==="google"?"https://accounts.google.com/o/oauth2/v2/auth":"https://discord.com/oauth2/authorize";
 const params=new URLSearchParams({client_id:clientId,redirect_uri:OAUTH_REDIRECTS[provider],response_type:"code",scope:provider==="google"?"openid email profile":"identify email",state});
 if(provider==="google")params.set("prompt","select_account");
 return Response.redirect(auth+"?"+params.toString(),302);
}
async function oauthUser(env,provider,profile){
 await ensureOAuthTables(env);
 const providerId=String(profile.id||profile.sub||"");
 if(!providerId)return {error:"The identity provider did not return a user ID."};
 const email=String(profile.email||"").trim().toLowerCase()||null;
 const ownerMatch=provider==="google"
  ? !!profile.email_verified&&!!env.OWNER_GOOGLE_EMAIL&&email===String(env.OWNER_GOOGLE_EMAIL).trim().toLowerCase()
  : !!env.OWNER_DISCORD_ID&&providerId===String(env.OWNER_DISCORD_ID);
 let linked=await env.DB.prepare("SELECT u.id,u.username,u.account_type,u.status FROM oauth_accounts a JOIN users u ON u.id=a.user_id WHERE a.provider=? AND a.provider_user_id=?").bind(provider,providerId).first();
 let user=linked;
 if(!user&&ownerMatch)user=await env.DB.prepare("SELECT id,username,account_type,status FROM users WHERE account_type='owner' ORDER BY created_at LIMIT 1").first();
 if(user&&user.status!=="active")return {error:"This MallowCord account is not active."};
 const display=String(profile.name||profile.global_name||profile.username||profile.email?.split("@")[0]||"MallowUser").trim();
 const avatar=provider==="discord"&&profile.avatar
  ?"https://cdn.discordapp.com/avatars/"+providerId+"/"+profile.avatar+".png?size=128"
  :String(profile.picture||"").startsWith("https://")?profile.picture:null;
 if(!user){
  let base=display.normalize("NFKD").replace(/[^A-Za-z0-9_]/g,"").slice(0,18)||"MallowUser";
  let username=base,id=uid(),t=now(),created=false;
  for(let i=0;i<12;i++){
   try{
    await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,created_at,updated_at) VALUES(?,?,?, ?,?,?)").bind(id,username,username.toLowerCase(),ownerMatch?"owner":"basic",t,t).run();
    created=true;break;
   }catch{
    username=(base.slice(0,Math.max(3,18-5))+"_"+token().slice(0,4)).slice(0,24);
   }
  }
  if(!created)return {error:"Could not create a unique MallowCord username. Please try again."};
  user={id,username,account_type:ownerMatch?"owner":"basic",status:"active"};
 }
 if(ownerMatch&&user.account_type!=="owner"){
  await env.DB.prepare("UPDATE users SET account_type='owner',updated_at=? WHERE id=?").bind(now(),user.id).run();
  user.account_type="owner";
 }
 await env.DB.prepare("INSERT INTO oauth_accounts(provider,provider_user_id,user_id,email,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(provider,provider_user_id) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at").bind(provider,providerId,user.id,email,now(),now()).run();
 await ensureAccountTables(env);
 await env.DB.prepare("INSERT INTO user_profiles(user_id,display_name,avatar_url,email,email_verified_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=COALESCE(excluded.avatar_url,user_profiles.avatar_url),email=COALESCE(excluded.email,user_profiles.email),email_verified_at=CASE WHEN excluded.email_verified_at IS NOT NULL THEN excluded.email_verified_at ELSE user_profiles.email_verified_at END,updated_at=excluded.updated_at").bind(user.id,display,avatar,email,provider==="google"&&profile.email_verified?now():null,now()).run();
 await ensureOAuthSystemServer(env,user.id);
 return {user:{id:user.id,username:user.username,account_type:user.account_type}};
}
async function oauthCallback(req,env,provider){
 await ensureOAuthTables(env);
 const url=new URL(req.url),state=String(url.searchParams.get("state")||""),code=String(url.searchParams.get("code")||"");
 if(url.searchParams.has("error")||!state||!code){const reason=url.searchParams.get("error")||"missing_code_or_state";await oauthDiagnostic(env,provider,"callback_parameters_missing",{reason,hasState:!!state,hasCode:!!code});console.error("OAuth provider returned an error or callback parameters were missing",provider,reason);return oauthFailure(env,provider);}
 const stateHash=await sha(state);
 const saved=await env.DB.prepare("SELECT provider,expires_at FROM oauth_states WHERE state_hash=?").bind(stateHash).first();
 await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=?").bind(stateHash).run();
 if(!saved||saved.provider!==provider||saved.expires_at<now()){const detail={found:!!saved,providerMatches:saved?.provider===provider,expired:!!saved&&saved.expires_at<now()};await oauthDiagnostic(env,provider,"state_validation_failed",detail);console.error("OAuth state validation failed",provider,detail);return oauthFailure(env,provider);}
 try{
  const clientId=provider==="google"?env.GOOGLE_CLIENT_ID:env.DISCORD_CLIENT_ID;
  const clientSecret=provider==="google"?env.GOOGLE_CLIENT_SECRET:env.DISCORD_CLIENT_SECRET;
  if(!clientId||!clientSecret){const detail={clientIdPresent:!!clientId,clientSecretPresent:!!clientSecret};await oauthDiagnostic(env,provider,"credentials_missing",detail);console.error("OAuth credentials are missing",provider,detail);return oauthFailure(env,provider);}
  const form=new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:"authorization_code",code,redirect_uri:OAUTH_REDIRECTS[provider]});
  const tokenResponse=await fetch(provider==="google"?"https://oauth2.googleapis.com/token":"https://discord.com/api/oauth2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form});
  const tokenData=await tokenResponse.json();
  if(!tokenResponse.ok||!tokenData.access_token){const detail={status:tokenResponse.status,error:tokenData.error||"missing_access_token",errorDescription:tokenData.error_description||null};await oauthDiagnostic(env,provider,"token_exchange_failed",detail);console.error("OAuth token exchange rejected",provider,detail);return oauthFailure(env,provider);}
  const profileResponse=await fetch(provider==="google"?"https://openidconnect.googleapis.com/v1/userinfo":"https://discord.com/api/users/@me",{headers:{Authorization:"Bearer "+tokenData.access_token}});
  const profile=await profileResponse.json();
  if(!profileResponse.ok){const detail={status:profileResponse.status};await oauthDiagnostic(env,provider,"profile_fetch_failed",detail);console.error("OAuth profile request failed",provider,detail);return oauthFailure(env,provider);}
  if(provider==="google"&&profile.email_verified!==true){await oauthDiagnostic(env,provider,"email_not_verified",{});console.error("Google account email is not verified");return oauthFailure(env,provider);}
  const result=await oauthUser(env,provider,profile);
  if(result.error){await oauthDiagnostic(env,provider,"account_provisioning_failed",{reason:result.error});console.error("OAuth account provisioning failed",provider,result.error);return oauthFailure(env,provider);}
  const loginCode=token(),t=now();
  await env.DB.prepare("INSERT INTO oauth_login_codes(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha(loginCode),result.user.id,t+90,t).run();
  await oauthDiagnostic(env,provider,"callback_success_code_issued",{userId:result.user.id});
  const target=new URL("/",env.FRONTEND_ORIGIN);target.searchParams.set("oauth_code",loginCode);
  return Response.redirect(target.toString(),302);
 }catch(error){await oauthDiagnostic(env,provider,"callback_exception",{message:String(error?.message||error),stack:String(error?.stack||"").slice(0,2500)});console.error("OAuth callback failed",provider,error);return oauthFailure(env,provider);}
}
async function oauthExchange(req,env){
 await ensureOAuthTables(env);
 const code=String((await body(req)).code||"");
 if(!/^[a-f0-9]{64}$/.test(code)){await oauthDiagnostic(env,"unknown","exchange_invalid_code_format",{});return fail("Sign-in code is invalid or expired.",401);}
 const hash=await sha(code),row=await env.DB.prepare("SELECT user_id,expires_at FROM oauth_login_codes WHERE code_hash=?").bind(hash).first();
 if(!row||row.expires_at<now()){await oauthDiagnostic(env,"unknown","exchange_code_not_found_or_expired",{found:!!row,expired:!!row&&row.expires_at<now()});return fail("Sign-in code is invalid or expired.",401);}
 await env.DB.prepare("DELETE FROM oauth_login_codes WHERE code_hash=?").bind(hash).run();
 const user=await env.DB.prepare("SELECT id,username,account_type,status FROM users WHERE id=?").bind(row.user_id).first();
 if(!user||user.status!=="active"){await oauthDiagnostic(env,"unknown","exchange_user_inactive_or_missing",{found:!!user,status:user?.status||null});return fail("This MallowCord account is not active.",403);}
 const cookie=await session(req,env,user.id);
 await oauthDiagnostic(env,"unknown","exchange_session_created",{userId:user.id});
 return json({user:{id:user.id,username:user.username,account_type:user.account_type}},200,{"set-cookie":cookie});
}

async function handle(req,env){const p=new URL(req.url).pathname,m=req.method;let x;
if(p==="/api/health")return json({ok:true,service:"mallowcord",time:now()});
const publicAvatar=p.match(/^\/api\/public\/avatars\/([A-Za-z0-9:_-]+)$/);
if(publicAvatar&&m==="GET"){
 await ensureAccountTables(env);
 const profile=await env.DB.prepare("SELECT avatar_url FROM user_profiles WHERE user_id=?").bind(publicAvatar[1]).first();
 const value=String(profile?.avatar_url||"");
 if(value.startsWith("https://"))return Response.redirect(value,302);
 const match=value.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
 if(!match)return new Response("Avatar not found.",{status:404});
 const binary=atob(match[2]),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return new Response(bytes,{headers:{"content-type":match[1],"cache-control":"public, max-age=300","x-content-type-options":"nosniff","access-control-allow-origin":"*"}});
}

if(p!=="/api/bootstrap"&&env.DB){const blocked=await env.DB.prepare("SELECT id FROM bans WHERE ip_hash=? AND server_id IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").bind(await ipDigest(req,env),now()).first();if(blocked)return fail("Access to MallowCord is blocked.",403);}
if(p==="/api/bootstrap"&&m==="POST")return fail("Password-based bootstrap has been removed. Sign in with the configured owner Google or Discord account.",410);

/* Two-way Discord bridge for the official Mallow Swamp server. */
const discordBridgePath=p.startsWith("/api/integrations/mallowbot/discord/");
if(discordBridgePath){
 if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);
 const expectedGuild="1560367587542433812";
 await ensureAccountTables(env);const system=await ensureBridgeSystemServer(env);
 if(!system)return fail("Mallow Swamp could not be initialized.",503);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_channel_links(discord_channel_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,mallow_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,category_name TEXT,updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_user_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_account_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,UNIQUE(server_id,user_id))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_role_links(discord_role_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE)").run();
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#99aab5'").run().catch(()=>{});
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_message_links(discord_message_id TEXT PRIMARY KEY,mallow_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,discord_channel_id TEXT NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_outbox(id TEXT PRIMARY KEY,discord_channel_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL,processed_at INTEGER,discord_message_id TEXT)").run();

 if(p==="/api/integrations/mallowbot/discord/link/claim"&&m==="POST"){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_account_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,UNIQUE(server_id,user_id))").run();
  const b=await body(req),code=String(b.code||"").replace(/[^A-Za-z0-9]/g,"").toUpperCase(),discordId=String(b.discord_user_id||"");
  if(!/^[A-Z0-9]{8}$/.test(code)||!/^[0-9]{15,22}$/.test(discordId))return fail("Invalid link code.");
  const hash=await sha(code),row=await env.DB.prepare("SELECT user_id,expires_at FROM discord_link_codes WHERE code_hash=?").bind(hash).first();
  if(!row||row.expires_at<now())return fail("Link code is invalid or expired.",404);
  const existing=await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(discordId,system.id).first();
  if(existing&&existing.user_id!==row.user_id)return fail("This Discord account is already linked to another MallowCord account.",409);
  const other=await env.DB.prepare("SELECT discord_user_id FROM discord_account_links WHERE user_id=? AND server_id=?").bind(row.user_id,system.id).first();
  if(other&&other.discord_user_id!==discordId)return fail("This MallowCord account is already linked to another Discord account.",409);
  const shadow=await env.DB.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?").bind(discordId,system.id).first();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO discord_account_links(discord_user_id,server_id,user_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET user_id=excluded.user_id,updated_at=excluded.updated_at").bind(discordId,system.id,row.user_id,now()),
   env.DB.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(system.id,row.user_id,now()),
   env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) SELECT server_id,?,role_id FROM member_roles WHERE server_id=? AND user_id=?").bind(row.user_id,system.id,shadow?.user_id||""),
   env.DB.prepare("DELETE FROM discord_link_codes WHERE code_hash=?").bind(hash)
  ]);
  if(shadow?.user_id&&shadow.user_id!==row.user_id){
   await env.DB.prepare("DELETE FROM memberships WHERE server_id=? AND user_id=?").bind(system.id,shadow.user_id).run();
   await env.DB.prepare("UPDATE channel_permissions SET target_id=? WHERE channel_id IN (SELECT id FROM channels WHERE server_id=?) AND target_type='user' AND target_id=?").bind(row.user_id,system.id,shadow.user_id).run().catch(()=>{});
  }
  return json({ok:true,linked:true});
 }
 if(p==="/api/integrations/mallowbot/discord/commands/next"&&m==="GET"){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_command_jobs(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,discord_user_id TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,processed_at INTEGER)").run();
  await env.DB.prepare("UPDATE discord_command_jobs SET status='queued',processed_at=NULL WHERE status='processing' AND processed_at<?").bind(now()-120).run();
  const rows=await env.DB.prepare("SELECT j.id,j.channel_id,j.discord_user_id,j.content,cl.discord_channel_id FROM discord_command_jobs j JOIN discord_channel_links cl ON cl.mallow_channel_id=j.channel_id AND cl.server_id=j.server_id WHERE j.status='queued' ORDER BY j.created_at LIMIT 5").all();
  for(const job of rows.results)await env.DB.prepare("UPDATE discord_command_jobs SET status='processing',processed_at=? WHERE id=? AND status='queued'").bind(now(),job.id).run();
  return json({jobs:rows.results});
 }
 if(p==="/api/integrations/mallowbot/discord/commands/result"&&m==="POST"){
  const b=await body(req),id=String(b.id||""),content=String(b.content||"").slice(0,4000);
  const job=await env.DB.prepare("SELECT id,channel_id,user_id,status FROM discord_command_jobs WHERE id=?").bind(id).first();
  if(!job||job.status!=="processing")return fail("Command job not found.",404);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,source_user_id TEXT REFERENCES users(id),username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  if(content)await env.DB.prepare("INSERT INTO bot_messages(id,channel_id,source_user_id,username,avatar_url,content,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(),job.channel_id,job.user_id,"Mallow Bot",env.MALLOWBOT_ICON_URL||"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",content,now()).run();
  await env.DB.prepare("UPDATE discord_command_jobs SET status='done',processed_at=? WHERE id=?").bind(now(),id).run();
  return json({ok:true});
 }
 if(p==="/api/integrations/mallowbot/discord/sync"&&m==="POST"){
  const b=await body(req);if(String(b.guild_id)!==expectedGuild)return fail("This bridge is restricted to the configured official Discord server.",403);
  const channels=Array.isArray(b.channels)?b.channels.slice(0,250):[],roles=Array.isArray(b.roles)?b.roles.slice(0,250):[],members=Array.isArray(b.members)?b.members.slice(0,250):[];
  await env.DB.prepare("UPDATE servers SET icon_url=COALESCE(?,icon_url) WHERE id=?").bind(typeof b.icon_url==="string"?b.icon_url:null,system.id).run();
  const everyone=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name='@everyone'").bind(system.id).first();
  const memberRole=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name='@Member'").bind(system.id).first();
  const channelMap=[];
  for(const ch of channels){
   const dcid=String(ch.id||"");const raw=String(ch.name||"").trim().slice(0,80);
   if(!dcid||raw.length<2)continue;
   const existing=await env.DB.prepare("SELECT mallow_channel_id FROM discord_channel_links WHERE discord_channel_id=?").bind(dcid).first();
   let cid=existing?.mallow_channel_id;
   if(!cid){const same=await env.DB.prepare("SELECT id FROM channels WHERE server_id=? AND name=? AND kind='text'").bind(system.id,raw).first();cid=same?.id;}
   if(cid)await env.DB.prepare("UPDATE channels SET name=?,kind='text',position=? WHERE id=? AND server_id=?").bind(raw,Number(ch.position)||0,cid,system.id).run();
   else{cid=uid();await env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?,?,'text',?)").bind(cid,system.id,raw,Number(ch.position)||0).run();}
   await env.DB.prepare("INSERT INTO discord_channel_links(discord_channel_id,server_id,mallow_channel_id,category_name,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(discord_channel_id) DO UPDATE SET mallow_channel_id=excluded.mallow_channel_id,category_name=excluded.category_name,updated_at=excluded.updated_at").bind(dcid,system.id,cid,String(ch.category||"").slice(0,100)||null,now()).run();
   channelMap.push({discord_id:dcid,mallow_id:cid,name:raw});
  }
  const roleMap=[];
  for(const role of roles){
   const rid=String(role.id||""),rname=String(role.name||"").trim().slice(0,32),rcolor=/^#[0-9a-fA-F]{6}$/.test(String(role.color||""))?String(role.color):"#99aab5";if(!rid||!rname||rname==="@everyone")continue;
   const linked=await env.DB.prepare("SELECT role_id FROM discord_role_links WHERE discord_role_id=?").bind(rid).first();
   let mrole=linked?.role_id;
   if(!mrole){const existing=await env.DB.prepare("SELECT id FROM roles WHERE server_id=? AND name=?").bind(system.id,rname).first();mrole=existing?.id;}
   if(!mrole){mrole=uid();const safeName=rname.replace(/[<>]/g,"").trim()||("discord-role-"+rid.slice(-5));try{await env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position,color) VALUES(?,?,?,0,?,?)").bind(mrole,system.id,safeName,Number(role.position)||0,rcolor).run();}catch{continue;}}
   await env.DB.prepare("UPDATE roles SET color=?,position=? WHERE id=? AND server_id=?").bind(rcolor,Number(role.position)||0,mrole,system.id).run();
   await env.DB.prepare("INSERT INTO discord_role_links(discord_role_id,server_id,role_id) VALUES(?,?,?) ON CONFLICT(discord_role_id) DO UPDATE SET role_id=excluded.role_id").bind(rid,system.id,mrole).run();roleMap.push({discord_id:rid,mallow_id:mrole});
  }
  const roleLookup=new Map(roleMap.map(r=>[r.discord_id,r.mallow_id]));
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS channel_permissions(channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,target_type TEXT NOT NULL CHECK(target_type IN ('role','user')),target_id TEXT NOT NULL,allow_json TEXT NOT NULL DEFAULT '[]',deny_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,target_type,target_id))").run();
  for(const ch of channels){
   const linkedChannel=await env.DB.prepare("SELECT mallow_channel_id FROM discord_channel_links WHERE discord_channel_id=? AND server_id=?").bind(String(ch.id||""),system.id).first();
   if(!linkedChannel)continue;
   const cid=linkedChannel.mallow_channel_id;
   for(const overwrite of (Array.isArray(ch.overwrites)?ch.overwrites:[])){
    const targetType=overwrite.target_type==="user"?"user":"role",discordTarget=String(overwrite.id||"");
    let targetId=null;
    if(targetType==="role"){
     if(discordTarget===String(b.everyone_role_id||b.guild_id))targetId=everyone?.id||null;
     else targetId=(await env.DB.prepare("SELECT role_id FROM discord_role_links WHERE discord_role_id=? AND server_id=?").bind(discordTarget,system.id).first())?.role_id||null;
    }else targetId=(await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(discordTarget,system.id).first())?.user_id||(await env.DB.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?").bind(discordTarget,system.id).first())?.user_id||null;
    if(!targetId)continue;
    const allowed=["view_channel","send_messages","read_message_history","attach_files","embed_links","manage_messages"];
    const allow=(Array.isArray(overwrite.allow)?overwrite.allow:[]).filter(v=>allowed.includes(v));
    const deny=(Array.isArray(overwrite.deny)?overwrite.deny:[]).filter(v=>allowed.includes(v));
    await env.DB.prepare("INSERT INTO channel_permissions(channel_id,target_type,target_id,allow_json,deny_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET allow_json=excluded.allow_json,deny_json=excluded.deny_json,updated_at=excluded.updated_at").bind(cid,targetType,targetId,JSON.stringify(allow),JSON.stringify(deny),now()).run();
   }
   if(ch.locked||["rules","server-rules"].includes(String(ch.name||"").toLowerCase())){
    if(everyone)await env.DB.prepare("INSERT INTO channel_permissions(channel_id,target_type,target_id,allow_json,deny_json,updated_at) VALUES(?,'role',?,'[]',?,?) ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET deny_json=excluded.deny_json,updated_at=excluded.updated_at").bind(cid,everyone.id,JSON.stringify(["send_messages"]),now()).run();
   }
  }
  const emojis=Array.isArray(b.emojis)?b.emojis.slice(0,250):[];
  if(emojis.length){
   await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_emojis(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,image_url TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,UNIQUE(server_id,name))").run();
   await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_emoji_links(discord_emoji_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,emoji_id TEXT NOT NULL REFERENCES server_emojis(id) ON DELETE CASCADE)").run();
   for(const emoji of emojis){
    const eid=String(emoji.id||""),name=String(emoji.name||"").replace(/[^A-Za-z0-9_]/g,"").slice(0,32),url=String(emoji.image_url||"");
    if(!eid||name.length<2||!url.startsWith("https://"))continue;
    let linked=await env.DB.prepare("SELECT emoji_id FROM discord_emoji_links WHERE discord_emoji_id=? AND server_id=?").bind(eid,system.id).first();
    let mid=linked?.emoji_id;
    if(!mid){const existing=await env.DB.prepare("SELECT id FROM server_emojis WHERE server_id=? AND name=?").bind(system.id,name).first();mid=existing?.id||uid();}
    await env.DB.prepare("INSERT INTO server_emojis(id,server_id,name,image_url,created_by,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image_url=excluded.image_url").bind(mid,system.id,name,url,system.owner_id,now()).run();
    await env.DB.prepare("INSERT INTO discord_emoji_links(discord_emoji_id,server_id,emoji_id) VALUES(?,?,?) ON CONFLICT(discord_emoji_id) DO UPDATE SET emoji_id=excluded.emoji_id").bind(eid,system.id,mid).run();
   }
  }

  let synced=0;
  for(const mem of members){
   const did=String(mem.id||"");if(!did||mem.bot)continue;
   const username="discord_"+did;let user=await env.DB.prepare("SELECT id FROM users WHERE username_key=?").bind(username.toLowerCase()).first();let userId=user?.id||("discord:"+did);
   if(!user){await env.DB.prepare("INSERT OR IGNORE INTO users(id,username,username_key,account_type,status,created_at,updated_at) VALUES(?,?,?,'basic','active',?,?)").bind(userId,username,username.toLowerCase(),now(),now()).run();user=await env.DB.prepare("SELECT id FROM users WHERE username_key=?").bind(username.toLowerCase()).first();userId=user?.id||userId;}
   await env.DB.prepare("INSERT INTO user_profiles(user_id,display_name,avatar_url,status,discord_username,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,status=excluded.status,discord_username=excluded.discord_username,updated_at=excluded.updated_at").bind(userId,String(mem.display_name||mem.username||username).slice(0,32),String(mem.avatar_url||"").slice(0,1000)||null,["online","idle","dnd","offline"].includes(mem.status)?mem.status:"offline",String(mem.username||"").slice(0,32),now()).run();
   await env.DB.prepare("INSERT INTO discord_user_links(discord_user_id,server_id,user_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET user_id=excluded.user_id,updated_at=excluded.updated_at").bind(did,system.id,userId,now()).run();
   const accountLink=await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(did,system.id).first();const memberUserId=accountLink?.user_id||userId;
   await env.DB.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(system.id,memberUserId,now()).run();
   if(everyone)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(system.id,memberUserId,everyone.id).run();
   if(memberRole)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(system.id,memberUserId,memberRole.id).run();
   for(const drid of (Array.isArray(mem.roles)?mem.roles:[])){let mr=roleLookup.get(String(drid));if(!mr){const linkedRole=await env.DB.prepare("SELECT role_id FROM discord_role_links WHERE discord_role_id=? AND server_id=?").bind(String(drid),system.id).first();mr=linkedRole?.role_id;}if(mr)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(system.id,memberUserId,mr).run();}
   synced++;
  }
  return json({ok:true,server_id:system.id,channels:channelMap.length,roles:roleMap.length,members:synced,channel_map:channelMap});
 }
 if(p==="/api/integrations/mallowbot/discord/presence"&&m==="POST"){
  const b=await body(req);if(String(b.guild_id)!==expectedGuild)return fail("Guild is not linked.",403);
  const presence=["online","idle","dnd","offline"].includes(b.status)?b.status:"offline";
  const linked=await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(String(b.user_id||""),system.id).first()||await env.DB.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?").bind(String(b.user_id||""),system.id).first();
  if(!linked)return json({ok:true,ignored:true});
  await env.DB.prepare("UPDATE user_profiles SET status=?,updated_at=? WHERE user_id=?").bind(presence,now(),linked.user_id).run();return json({ok:true});
 }
 if(p==="/api/integrations/mallowbot/discord/messages"&&m==="POST"){
  const b=await body(req);if(String(b.guild_id)!==expectedGuild)return fail("Guild is not linked.",403);
  const did=String(b.message_id||""),dcid=String(b.channel_id||""),author=String(b.author_id||""),content=String(b.content||"").trim();
  if(!did||!dcid||!author||!content||content.length>4000)return fail("Message payload is incomplete.");
  const dupe=await env.DB.prepare("SELECT mallow_message_id FROM discord_message_links WHERE discord_message_id=?").bind(did).first();if(dupe)return json({ok:true,duplicate:true});await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
  const channel=await env.DB.prepare("SELECT mallow_channel_id FROM discord_channel_links WHERE discord_channel_id=? AND server_id=?").bind(dcid,system.id).first();if(!channel)return fail("Discord channel has not been synchronized.",404);
  let linked=await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(author,system.id).first()||await env.DB.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?").bind(author,system.id).first();
  let userId=linked?.user_id;
  if(!userId){const username="discord_"+author;let row=await env.DB.prepare("SELECT id FROM users WHERE username_key=?").bind(username.toLowerCase()).first();userId=row?.id||("discord:"+author);if(!row){await env.DB.prepare("INSERT OR IGNORE INTO users(id,username,username_key,account_type,status,created_at,updated_at) VALUES(?,?,?,'basic','active',?,?)").bind(userId,username,username.toLowerCase(),now(),now()).run();row=await env.DB.prepare("SELECT id FROM users WHERE username_key=?").bind(username.toLowerCase()).first();userId=row?.id||userId;}await env.DB.prepare("INSERT INTO discord_user_links(discord_user_id,server_id,user_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET user_id=excluded.user_id,updated_at=excluded.updated_at").bind(author,system.id,userId,now()).run();await env.DB.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(system.id,userId,now()).run();if(everyone)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(system.id,userId,everyone.id).run();if(memberRole)await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(system.id,userId,memberRole.id).run();}
  await env.DB.prepare("INSERT INTO user_profiles(user_id,display_name,avatar_url,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at").bind(userId,String(b.display_name||b.username||"Discord user").slice(0,32),String(b.avatar_url||"").slice(0,1000)||null,now()).run();
  const mid=uid(),created=Number(b.timestamp)||now();await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(mid,channel.mallow_channel_id,userId,content,created).run();
  await env.DB.prepare("INSERT INTO discord_message_links(discord_message_id,mallow_message_id,discord_channel_id) VALUES(?,?,?)").bind(did,mid,dcid).run();const mentionedIds=Array.isArray(b.mentioned_user_ids)?b.mentioned_user_ids.map(String):[];for(const discordUserId of mentionedIds){const target=await env.DB.prepare("SELECT user_id FROM discord_account_links WHERE discord_user_id=? AND server_id=?").bind(discordUserId,system.id).first()||await env.DB.prepare("SELECT user_id FROM discord_user_links WHERE discord_user_id=? AND server_id=?").bind(discordUserId,system.id).first();if(target&&target.user_id!==userId)await env.DB.prepare("INSERT OR IGNORE INTO message_notifications(id,user_id,server_id,channel_id,message_id,kind,created_at) VALUES(?,?,?,?,?,'mention',?)").bind(uid(),target.user_id,system.id,channel.mallow_channel_id,mid,now()).run();}
  return json({ok:true,message_id:mid},201);
 }
 if(p==="/api/integrations/mallowbot/discord/outbox"&&m==="GET"){
  const rows=await env.DB.prepare("SELECT o.id,o.discord_channel_id,o.username,CASE WHEN o.avatar_url LIKE 'data:image/%' THEN 'https://mallowcord-api.wowgrayhaha.workers.dev/api/public/avatars/'||m.author_id ELSE o.avatar_url END AS avatar_url,o.content,o.message_id FROM discord_outbox o LEFT JOIN messages m ON m.id=o.message_id WHERE o.processed_at IS NULL ORDER BY o.created_at LIMIT 30").all();return json({events:rows.results});
 }
 const ack=p.match(/^\/api\/integrations\/mallowbot\/discord\/outbox\/([\w-]+)\/ack$/);
 if(ack&&m==="POST"){const b=await body(req);await env.DB.prepare("UPDATE discord_outbox SET processed_at=?,discord_message_id=? WHERE id=?").bind(now(),String(b.discord_message_id||"").slice(0,32)||null,ack[1]).run();return json({ok:true});}
}
if(p==="/api/integrations/mallowbot/users"&&m==="POST")return fail("MallowCord accounts must be created through Google or Discord OAuth.",410);
if(p==="/api/admin/users"&&m==="POST")return fail("MallowCord accounts must be created through Google or Discord OAuth.",410);
if(p==="/api/integrations/mallowbot/users"&&m==="GET"){
if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);
const ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();
if(m==="GET"){const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}
const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");
if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");
const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}
await joinSwamp(env,id2);await audit(env,ownerRow?.id,id2,"mallowbot_create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
const botParts=p.split("/");const botMatch=botParts.length===7&&botParts[1]==="api"&&botParts[2]==="integrations"&&botParts[3]==="mallowbot"&&botParts[4]==="users"&&["timeout","ban","unban","delete"].includes(botParts[6]);
if(botMatch&&m==="POST"){
if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);
const target=botParts[5],action=botParts[6],b=await body(req),ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();
if(!ownerRow)return fail("Owner not initialized.",503);
if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),target).run();}
if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),target).run();
if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),target).run();
if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(target).run();
if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();
await audit(env,ownerRow.id,target,"mallowbot_"+action,JSON.stringify(b));return json({ok:true});}

if(p==="/api/auth/google"&&m==="GET")return oauthStart(req,env,"google");
if(p==="/api/auth/google/callback"&&m==="GET")return oauthCallback(req,env,"google");
if(p==="/api/auth/discord"&&m==="GET")return oauthStart(req,env,"discord");
if(p==="/api/auth/discord/callback"&&m==="GET")return oauthCallback(req,env,"discord");
if(p==="/api/auth/exchange"&&m==="POST")return oauthExchange(req,env);
if(["/api/auth/register","/api/auth/login","/api/auth/recover"].includes(p))return fail("Username, password and recovery-code sign-in have been removed. Use Google or Discord.",410);
if(p==="/api/auth/logout"&&m==="POST"){const u=await userFor(req,env);if(u){await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();await env.DB.prepare("DELETE FROM user_presence WHERE user_id=?").bind(u.id).run();await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(u.session_id).run();}return json({ok:true},200,{"set-cookie":clearCookie()});}
const u=await userFor(req,env);
if(p==="/api/auth/me"&&m==="GET")return u?json({user:{id:u.id,username:u.username,account_type:u.account_type}}):fail("Not signed in.",401);
if(!u)return fail("Sign in required.",401);
const banned=await env.DB.prepare("SELECT id FROM bans WHERE ip_hash=? AND server_id IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").bind(await ipDigest(req,env),now()).first();if(banned)return fail("Access to MallowCord is blocked.",403);
if(u.timed_out&&p.startsWith("/api/")&&!["/api/auth/me","/api/auth/logout"].includes(p))return fail("Your account is timed out.",403);
if(p==="/api/presence/heartbeat"&&m==="POST"){
 await ensureAccountTables(env);
 const preferences=await env.DB.prepare("SELECT settings_json FROM user_preferences WHERE user_id=?").bind(u.id).first();
 let settings={};try{settings=JSON.parse(preferences?.settings_json||"{}")}catch{}
 const showOnline=settings?.privacy?.showOnlineStatus!==false;
 await env.DB.prepare("INSERT INTO user_presence(user_id,last_seen_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at").bind(u.id,showOnline?now():0).run();
 return json({ok:true,presence:showOnline?"online":"offline"});
}
if(p==="/api/notifications"&&m==="GET"){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_notification_settings(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,scope_type TEXT NOT NULL CHECK(scope_type IN ('server','channel')),scope_id TEXT NOT NULL,muted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,scope_type,scope_id))").run();
 const rows=(await env.DB.prepare("SELECT mn.server_id,mn.channel_id,COUNT(*) AS count FROM message_notifications mn WHERE mn.user_id=? AND mn.seen_at IS NULL AND NOT EXISTS(SELECT 1 FROM user_notification_settings ns WHERE ns.user_id=mn.user_id AND ns.muted=1 AND ((ns.scope_type='server' AND ns.scope_id=mn.server_id) OR (ns.scope_type='channel' AND ns.scope_id=mn.channel_id))) GROUP BY mn.server_id,mn.channel_id").bind(u.id).all()).results;
 return json({unread:rows,total:rows.reduce((n,r)=>n+Number(r.count||0),0)});
}
if(p==="/api/notifications/read"&&m==="POST"){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
 const b=await body(req),cid=String(b.channel_id||"");
 const access=await env.DB.prepare("SELECT c.server_id FROM channels c JOIN memberships m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=?").bind(cid,u.id).first();
 if(!access)return fail("You cannot mark this channel as read.",403);
 await env.DB.prepare("UPDATE message_notifications SET seen_at=? WHERE user_id=? AND channel_id=? AND seen_at IS NULL").bind(now(),u.id,cid).run();
 return json({ok:true});
}
if(p==="/api/notification-settings"&&(m==="GET"||m==="POST")){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_notification_settings(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,scope_type TEXT NOT NULL CHECK(scope_type IN ('server','channel')),scope_id TEXT NOT NULL,muted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,scope_type,scope_id))").run();
 if(m==="GET"){const rows=await env.DB.prepare("SELECT scope_type,scope_id,muted FROM user_notification_settings WHERE user_id=? AND muted=1").bind(u.id).all();return json({settings:rows.results})}
 const b=await body(req),scope=String(b.scope_type||""),id=String(b.scope_id||""),muted=!!b.muted;if(!["server","channel"].includes(scope)||!id)return fail("Invalid notification setting.");
 const access=scope==="server"?await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(id,u.id).first():await env.DB.prepare("SELECT 1 FROM channels c JOIN memberships m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=?").bind(id,u.id).first();if(!access)return fail("You cannot change notifications for this item.",403);
 await env.DB.prepare("INSERT INTO user_notification_settings(user_id,scope_type,scope_id,muted,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,scope_type,scope_id) DO UPDATE SET muted=excluded.muted,updated_at=excluded.updated_at").bind(u.id,scope,id,muted?1:0,now()).run();return json({ok:true,muted});
}
if(p==="/api/notifications/clear"&&m==="POST"){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
 const b=await body(req),scope=String(b.scope_type||""),id=String(b.scope_id||"");if(!["server","channel"].includes(scope)||!id)return fail("Invalid notification target.");
 const access=scope==="server"?await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(id,u.id).first():await env.DB.prepare("SELECT 1 FROM channels c JOIN memberships m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=?").bind(id,u.id).first();if(!access)return fail("You cannot clear notifications for this item.",403);
 if(scope==="server")await env.DB.prepare("UPDATE message_notifications SET seen_at=? WHERE user_id=? AND server_id=? AND seen_at IS NULL").bind(now(),u.id,id).run();else await env.DB.prepare("UPDATE message_notifications SET seen_at=? WHERE user_id=? AND channel_id=? AND seen_at IS NULL").bind(now(),u.id,id).run();return json({ok:true});
}


/* Account profile, preferences, password and verified contact methods */
async function ensureAccountTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,display_name TEXT,avatar_url TEXT,email TEXT,email_verified_at INTEGER,phone TEXT,phone_verified_at INTEGER,updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,settings_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS contact_verifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,channel TEXT NOT NULL,target TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN bio TEXT").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'online'").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN pronouns TEXT").run().catch(()=>{});
 await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN discord_username TEXT").run().catch(()=>{});
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();
}
x=p.match(/^\/api\/users\/([\w:%-]+)\/profile$/);
if(x&&m==="GET"){
 await ensureAccountTables(env);
 await ensureSocialTables(env);
 const targetId=decodeURIComponent(x[1]);
 const shared=await env.DB.prepare("SELECT 1 FROM memberships mine JOIN memberships target ON target.server_id=mine.server_id WHERE mine.user_id=? AND target.user_id=? LIMIT 1").bind(u.id,targetId).first();
 const [lowProfile,highProfile]=u.id<targetId?[u.id,targetId]:[targetId,u.id];
 const related=await env.DB.prepare("SELECT 1 FROM friendships WHERE user_low_id=? AND user_high_id=? UNION ALL SELECT 1 FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) LIMIT 1").bind(lowProfile,highProfile,u.id,targetId,targetId,u.id).first();
 if(!shared&&!related)return fail("You cannot view this profile.",403);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();
 const profile=await env.DB.prepare("SELECT COALESCE(up.display_name,u.username) AS display_name,COALESCE(up.discord_username,u.username) AS username,up.avatar_url,up.bio,CASE WHEN COALESCE(json_extract(pref.settings_json,'$.privacy.showOnlineStatus'),1)=0 THEN 'offline' WHEN COALESCE(pr.last_seen_at,0)>=? THEN COALESCE(up.status,'online') ELSE 'offline' END AS status,up.pronouns FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id LEFT JOIN user_presence pr ON pr.user_id=u.id LEFT JOIN user_preferences pref ON pref.user_id=u.id WHERE u.id=? AND u.status='active'").bind(now()-45,targetId).first();
 if(!profile)return fail("User not found.",404);
 const serverId=new URL(req.url).searchParams.get("server_id");
 let roles=[];
 if(serverId){
  const inServer=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(serverId,targetId).first();
  const viewerInServer=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(serverId,u.id).first();
  if(!inServer||!viewerInServer)return fail("You cannot view this server's roles.",403);
  roles=(await env.DB.prepare("SELECT r.id,r.name,r.color,r.position FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=? AND mr.user_id=? ORDER BY r.position DESC").bind(serverId,targetId).all()).results;
 }
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS friendships(user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(user_low_id,user_high_id))").run();
 const [low,high]=u.id<targetId?[u.id,targetId]:[targetId,u.id];
 const friendship=await env.DB.prepare("SELECT 1 FROM friendships WHERE user_low_id=? AND user_high_id=?").bind(low,high).first();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS friend_requests(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(sender_id,recipient_id))").run();
 const incoming=await env.DB.prepare("SELECT 1 FROM friend_requests WHERE sender_id=? AND recipient_id=? AND status='pending'").bind(targetId,u.id).first();
 const outgoing=await env.DB.prepare("SELECT 1 FROM friend_requests WHERE sender_id=? AND recipient_id=? AND status='pending'").bind(u.id,targetId).first();
 return json({profile,roles,friend_status:friendship?"friends":incoming?"incoming":outgoing?"outgoing":"none"});
}
async function ensureSocialTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS friend_requests(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(sender_id,recipient_id))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS friendships(user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,PRIMARY KEY(user_low_id,user_high_id))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS dm_conversations(id TEXT PRIMARY KEY,user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_low_id,user_high_id))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS dm_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,content TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
}
if(p==="/api/friends"&&m==="GET"){
 await ensureSocialTables(env);
 const friends=await env.DB.prepare("SELECT u.id,u.username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url,up.status FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_low_id=? THEN f.user_high_id ELSE f.user_low_id END LEFT JOIN user_profiles up ON up.user_id=u.id WHERE f.user_low_id=? OR f.user_high_id=? ORDER BY COALESCE(up.display_name,u.username)").bind(u.id,u.id,u.id).all();
 const incoming=await env.DB.prepare("SELECT fr.id,fr.sender_id AS user_id,u.username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url,fr.created_at FROM friend_requests fr JOIN users u ON u.id=fr.sender_id LEFT JOIN user_profiles up ON up.user_id=u.id WHERE fr.recipient_id=? AND fr.status='pending' ORDER BY fr.created_at DESC").bind(u.id).all();
 const outgoing=await env.DB.prepare("SELECT fr.id,fr.recipient_id AS user_id,u.username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url,fr.created_at FROM friend_requests fr JOIN users u ON u.id=fr.recipient_id LEFT JOIN user_profiles up ON up.user_id=u.id WHERE fr.sender_id=? AND fr.status='pending' ORDER BY fr.created_at DESC").bind(u.id).all();
 return json({friends:friends.results,incoming:incoming.results,outgoing:outgoing.results});
}
if(p==="/api/friends/request"&&m==="POST"){
 await ensureSocialTables(env);
 const b=await body(req),name=String(b.username||"").trim();
 if(!name)return fail("Enter the exact username of the person you want to add.");
 const target=await env.DB.prepare("SELECT u.id,u.username FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id WHERE (u.username_key=? OR lower(up.discord_username)=?) AND u.status='active' LIMIT 1").bind(name.toLowerCase(),name.toLowerCase()).first();
 if(!target)return fail("No active user has that username.",404);
 if(target.id===u.id)return fail("You cannot add yourself.");
 const [low,high]=u.id<target.id?[u.id,target.id]:[target.id,u.id];
 if(await env.DB.prepare("SELECT 1 FROM friendships WHERE user_low_id=? AND user_high_id=?").bind(low,high).first())return fail("You are already friends.");
 const reverse=await env.DB.prepare("SELECT id FROM friend_requests WHERE sender_id=? AND recipient_id=? AND status='pending'").bind(target.id,u.id).first();
 if(reverse){
  await env.DB.batch([
   env.DB.prepare("INSERT OR IGNORE INTO friendships(user_low_id,user_high_id,created_at) VALUES(?,?,?)").bind(low,high,now()),
   env.DB.prepare("UPDATE friend_requests SET status='accepted',updated_at=? WHERE id=?").bind(now(),reverse.id)
  ]);
  return json({ok:true,accepted:true,message:"Friend request accepted. You are now friends."});
 }
 try{await env.DB.prepare("INSERT INTO friend_requests(id,sender_id,recipient_id,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(sender_id,recipient_id) DO UPDATE SET status='pending',updated_at=excluded.updated_at").bind(uid(),u.id,target.id,now(),now()).run();}
 catch{return fail("A friend request is already pending.",409);}
 return json({ok:true,message:"Friend request sent."},201);
}
const friendAction=p.match(/^\/api\/friends\/([\w:%-]+)\/(accept|decline|remove)$/);
if(friendAction&&m==="POST"){
 await ensureSocialTables(env);
 const target=decodeURIComponent(friendAction[1]),action=friendAction[2],[low,high]=u.id<target?[u.id,target]:[target,u.id];
 if(action==="accept"){
  const request=await env.DB.prepare("SELECT id FROM friend_requests WHERE sender_id=? AND recipient_id=? AND status='pending'").bind(target,u.id).first();
  if(!request)return fail("That friend request is no longer pending.",404);
  await env.DB.batch([
   env.DB.prepare("INSERT OR IGNORE INTO friendships(user_low_id,user_high_id,created_at) VALUES(?,?,?)").bind(low,high,now()),
   env.DB.prepare("UPDATE friend_requests SET status='accepted',updated_at=? WHERE id=?").bind(now(),request.id)
  ]);
  return json({ok:true});
 }
 if(action==="decline"){
  const result=await env.DB.prepare("UPDATE friend_requests SET status='declined',updated_at=? WHERE sender_id=? AND recipient_id=? AND status='pending'").bind(now(),target,u.id).run();
  if(!result.meta?.changes)return fail("Friend request not found.",404);
  return json({ok:true});
 }
 const result=await env.DB.prepare("DELETE FROM friendships WHERE user_low_id=? AND user_high_id=?").bind(low,high).run();
 await env.DB.prepare("DELETE FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)").bind(u.id,target,target,u.id).run();
 await env.DB.prepare("DELETE FROM dm_conversations WHERE user_low_id=? AND user_high_id=?").bind(low,high).run();
 if(!result.meta?.changes)return fail("Friendship not found.",404);
 return json({ok:true});
}
if(p==="/api/dms"&&m==="GET"){
 await ensureSocialTables(env);
 const rows=await env.DB.prepare("SELECT c.id,c.updated_at,CASE WHEN c.user_low_id=? THEN c.user_high_id ELSE c.user_low_id END AS user_id,u.username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url,(SELECT content FROM dm_messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,(SELECT created_at FROM dm_messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at FROM dm_conversations c JOIN users u ON u.id=CASE WHEN c.user_low_id=? THEN c.user_high_id ELSE c.user_low_id END LEFT JOIN user_profiles up ON up.user_id=u.id WHERE c.user_low_id=? OR c.user_high_id=? ORDER BY c.updated_at DESC").bind(u.id,u.id,u.id,u.id).all();
 return json({conversations:rows.results});
}
if(p==="/api/dms/open"&&m==="POST"){
 await ensureSocialTables(env);
 const target=String((await body(req)).user_id||"");
 if(!target||target===u.id)return fail("Choose another user.");
 const [low,high]=u.id<target?[u.id,target]:[target,u.id];
 if(!await env.DB.prepare("SELECT 1 FROM friendships WHERE user_low_id=? AND user_high_id=?").bind(low,high).first())return fail("You can only message friends.",403);
 await env.DB.prepare("INSERT OR IGNORE INTO dm_conversations(id,user_low_id,user_high_id,created_at,updated_at) VALUES(?,?,?,?,?)").bind(uid(),low,high,now(),now()).run();
 const conversation=await env.DB.prepare("SELECT id FROM dm_conversations WHERE user_low_id=? AND user_high_id=?").bind(low,high).first();
 return json({conversation:{id:conversation.id,user_id:target}},201);
}
const dmRoute=p.match(/^\/api\/dms\/([\w-]+)\/messages$/);
if(dmRoute&&(m==="GET"||m==="POST")){
 await ensureSocialTables(env);
 const cid=dmRoute[1],conversation=await env.DB.prepare("SELECT id FROM dm_conversations WHERE id=? AND (user_low_id=? OR user_high_id=?)").bind(cid,u.id,u.id).first();
 if(!conversation)return fail("Direct message conversation not found.",404);
 if(m==="GET"){
  const rows=await env.DB.prepare("SELECT m.id,m.content,m.created_at,m.author_id,u.username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url FROM dm_messages m JOIN users u ON u.id=m.author_id LEFT JOIN user_profiles up ON up.user_id=u.id WHERE m.conversation_id=? ORDER BY m.created_at DESC LIMIT 75").bind(cid).all();
  return json({messages:rows.results.reverse()});
 }
 const content=String((await body(req)).content||"").trim();
 if(!content||content.length>4000)return fail("Messages must contain 1–4000 characters.");
 const id=uid(),created=now();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO dm_messages(id,conversation_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(id,cid,u.id,content,created),
  env.DB.prepare("UPDATE dm_conversations SET updated_at=? WHERE id=?").bind(created,cid)
 ]);
 return json({message:{id,content,created_at:created,author_id:u.id,username:u.username,display_name:u.username}},201);
}
if(p==="/api/account/profile"&&(m==="GET"||m==="POST")){
 await ensureAccountTables(env);
 if(m==="GET"){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();
  const profile=await env.DB.prepare("SELECT up.display_name,up.avatar_url,up.bio,CASE WHEN COALESCE(json_extract(pref.settings_json,'$.privacy.showOnlineStatus'),1)=0 THEN 'offline' WHEN COALESCE(pr.last_seen_at,0)>=? THEN COALESCE(up.status,'online') ELSE 'offline' END AS status,up.pronouns,up.email,up.email_verified_at,up.phone,up.phone_verified_at FROM user_profiles up LEFT JOIN user_presence pr ON pr.user_id=up.user_id LEFT JOIN user_preferences pref ON pref.user_id=up.user_id WHERE up.user_id=?").bind(now()-45,u.id).first();
  return json({profile:profile||{display_name:null,avatar_url:null,bio:null,status:'offline',pronouns:null,email:null,email_verified_at:null,phone:null,phone_verified_at:null},username:u.username,account_type:u.account_type});
 }
 const b=await body(req),display=String(b.display_name||"").trim().slice(0,32),avatar=String(b.avatar_url||"").trim();
  await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN bio TEXT").run().catch(()=>{});
  await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'online'").run().catch(()=>{});
  await env.DB.prepare("ALTER TABLE user_profiles ADD COLUMN pronouns TEXT").run().catch(()=>{});
  const bio=String(b.bio||"").trim().slice(0,190),pronouns=String(b.pronouns||"").trim().slice(0,32),presence=["online","idle","dnd","invisible"].includes(b.status)?b.status:"online";
 const isUploadedAvatar=/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)&&avatar.length<=700000;
 const isRemoteAvatar=/^https:\/\/[^\s]+$/i.test(avatar)&&avatar.length<=1000;
 if(avatar&&!isUploadedAvatar&&!isRemoteAvatar)return fail("Avatar must be an HTTPS image URL or a cropped JPEG image under 500 KB.");
 await env.DB.prepare("INSERT INTO user_profiles(user_id,display_name,avatar_url,bio,status,pronouns,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,bio=excluded.bio,status=excluded.status,pronouns=excluded.pronouns,updated_at=excluded.updated_at").bind(u.id,display||null,avatar||null,bio||null,presence,pronouns||null,now()).run();
 return json({ok:true,display_name:display||null,avatar_url:avatar||null});
}
if(p==="/api/account/preferences"&&(m==="GET"||m==="POST")){
 await ensureAccountTables(env);
 if(m==="GET"){
  const row=await env.DB.prepare("SELECT settings_json FROM user_preferences WHERE user_id=?").bind(u.id).first();
  let settings={};try{settings=JSON.parse(row?.settings_json||"{}")}catch{}
  return json({settings});
 }
 const b=await body(req),settings=b.settings;
 if(!settings||typeof settings!=="object"||Array.isArray(settings)||JSON.stringify(settings).length>65000)return fail("Invalid settings payload.");
 await env.DB.prepare("INSERT INTO user_preferences(user_id,settings_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at").bind(u.id,JSON.stringify(settings),now()).run();
 return json({ok:true});
}
if(p==="/api/account/status"&&m==="GET"){
 const row=await env.DB.prepare("SELECT username,account_type,status,timeout_until,created_at FROM users WHERE id=?").bind(u.id).first();
 return json({account:row});
}
if(p==="/api/account/password"&&m==="POST")return fail("Password authentication has been removed. Manage your sign-in through Google or Discord.",410);
if(p==="/api/account/contact/request"&&m==="POST"){
 await ensureAccountTables(env);
 const b=await body(req),channel=b.channel==="phone"?"phone":b.channel==="email"?"email":null,target=String(b.value||"").trim();
 if(!channel)return fail("Choose email or phone verification.");
 if(channel==="email"&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target))return fail("Enter a valid email address.");
 if(channel==="phone"&&!/^\+[1-9]\d{7,14}$/.test(target))return fail("Enter a phone number in international format, such as +12065550123.");
 const last=await env.DB.prepare("SELECT created_at FROM contact_verifications WHERE user_id=? AND channel=? ORDER BY created_at DESC LIMIT 1").bind(u.id,channel).first();
 if(last&&now()-last.created_at<60)return fail("Please wait 60 seconds before requesting another code.",429);
 const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0"),t=now(),id=uid();
 await env.DB.prepare("DELETE FROM contact_verifications WHERE user_id=? AND channel=?").bind(u.id,channel).run();
 await env.DB.prepare("INSERT INTO contact_verifications(id,user_id,channel,target,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)").bind(id,u.id,channel,target,await sha(channel+":"+u.id+":"+code+":"+env.IP_HASH_SECRET),t+600,t).run();
 if(channel==="email"){
  if(!env.RESEND_API_KEY||!env.MALLOWCORD_EMAIL_FROM){await env.DB.prepare("DELETE FROM contact_verifications WHERE id=?").bind(id).run();return fail("Email verification is not configured yet. The site owner must configure the Resend email service and verified sender address.",503);}
  const sent=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:env.MALLOWCORD_EMAIL_FROM,to:[target],subject:"Your MallowCord verification code",text:"Your MallowCord verification code is "+code+". It expires in 10 minutes. If you did not request this, ignore this email."})});
  if(!sent.ok){await env.DB.prepare("DELETE FROM contact_verifications WHERE id=?").bind(id).run();return fail("The verification email could not be sent. Check the email service configuration.",502);}
 }else{
  if(!env.TWILIO_ACCOUNT_SID||!env.TWILIO_AUTH_TOKEN||!env.TWILIO_FROM_NUMBER){await env.DB.prepare("DELETE FROM contact_verifications WHERE id=?").bind(id).run();return fail("Phone verification is not configured yet. The site owner must configure Twilio SMS.",503);}
  const form=new URLSearchParams({To:target,From:env.TWILIO_FROM_NUMBER,Body:"Your MallowCord verification code is "+code+". It expires in 10 minutes."});
  const auth=btoa(env.TWILIO_ACCOUNT_SID+":"+env.TWILIO_AUTH_TOKEN);
  const sent=await fetch("https://api.twilio.com/2010-04-01/Accounts/"+env.TWILIO_ACCOUNT_SID+"/Messages.json",{method:"POST",headers:{"Authorization":"Basic "+auth,"Content-Type":"application/x-www-form-urlencoded"},body:form});
  if(!sent.ok){await env.DB.prepare("DELETE FROM contact_verifications WHERE id=?").bind(id).run();return fail("The verification text could not be sent. Check the SMS service configuration.",502);}
 }
 await env.DB.prepare("INSERT INTO user_profiles(user_id,updated_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING").bind(u.id,now()).run();
 if(channel==="email")await env.DB.prepare("UPDATE user_profiles SET email=?,email_verified_at=NULL,updated_at=? WHERE user_id=?").bind(target,now(),u.id).run();
 else await env.DB.prepare("UPDATE user_profiles SET phone=?,phone_verified_at=NULL,updated_at=? WHERE user_id=?").bind(target,now(),u.id).run();
 return json({ok:true,message:"Verification code sent. It expires in 10 minutes."});
}
if(p==="/api/account/contact/confirm"&&m==="POST"){
 await ensureAccountTables(env);
 const b=await body(req),channel=b.channel==="phone"?"phone":b.channel==="email"?"email":null,code=String(b.code||"").trim();
 if(!channel||!/^\d{6}$/.test(code))return fail("Enter the six-digit verification code.");
 const row=await env.DB.prepare("SELECT * FROM contact_verifications WHERE user_id=? AND channel=? ORDER BY created_at DESC LIMIT 1").bind(u.id,channel).first();
 if(!row||row.expires_at<now()||row.code_hash!==await sha(channel+":"+u.id+":"+code+":"+env.IP_HASH_SECRET))return fail("That verification code is invalid or expired.",400);
 const col=channel==="email"?"email_verified_at":"phone_verified_at";
 await env.DB.prepare("UPDATE user_profiles SET "+col+"=?,updated_at=? WHERE user_id=?").bind(now(),now(),u.id).run();
 await env.DB.prepare("DELETE FROM contact_verifications WHERE id=?").bind(row.id).run();
 await audit(env,u.id,u.id,"verify_"+channel);
 return json({ok:true,verified:true});
}

if(p==="/api/auth/username"&&m==="POST"){const name=String((await body(req)).username||"").trim();if(!/^[A-Za-z0-9_]{3,24}$/.test(name))return fail("Username must be 3–24 characters.");try{await env.DB.prepare("UPDATE users SET username=?,username_key=?,updated_at=? WHERE id=?").bind(name,name.toLowerCase(),now(),u.id).run();}catch{return fail("That username is already taken.",409);}return json({username:name});}
if(p==="/api/auth/recovery/rotate"&&m==="POST")return fail("Recovery-code authentication has been removed. Sign in with Google or Discord.",410);
if(p==="/api/servers"&&m==="GET"){const a=await env.DB.prepare("SELECT s.id,s.name,COALESCE(s.icon_url,CASE WHEN s.is_system=1 THEN ? END) AS icon_url,s.is_system,m.joined_at FROM memberships m JOIN servers s ON s.id=m.server_id WHERE m.user_id=? ORDER BY s.is_system DESC,s.name").bind(env.MALLOWBOT_ICON_URL||"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",u.id).all();return json({servers:a.results});}
if(p==="/api/servers"&&m==="POST")return fail("Server creation is temporarily disabled. Server invitations are coming soon.",403);

/* Server administration: channels, roles, members, stats and onboarding */
/* Server custom emoji management */
const emojiRoute=p.match(/^\/api\/servers\/([\w-]+)\/emojis(?:\/([\w-]+))?$/);
if(emojiRoute){const sid=emojiRoute[1],eid=emojiRoute[2]||null,server=await env.DB.prepare("SELECT id,owner_id FROM servers WHERE id=?").bind(sid).first();if(!server)return fail("Server not found.",404);const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(sid,u.id).first();if(!member)return fail("You are not a member of this server.",403);const manager=isOwner(u)||server.owner_id===u.id;await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_emojis(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,image_url TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,UNIQUE(server_id,name))").run();if(m==="GET"){const rows=await env.DB.prepare("SELECT id,name,image_url,created_at FROM server_emojis WHERE server_id=? ORDER BY name").bind(sid).all();return json({emojis:rows.results,can_manage:manager})}if(m==="POST"){if(!manager)return fail("Server owner access required.",403);const b=await body(req),name=String(b.name||"").trim().toLowerCase(),url=String(b.image_url||"").trim();if(!/^[a-z0-9_]{2,32}$/.test(name))return fail("Emoji names must be 2–32 letters, numbers or underscores.");const validHttps=/^https:\/\/[^\s]+$/i.test(url)&&url.length<=1000,validImage=/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)&&url.length<=350000;if(!validHttps&&!validImage)return fail("Use a direct HTTPS image URL or upload a PNG, JPG, GIF or WebP image up to 256 KB.");const id=uid();try{await env.DB.prepare("INSERT INTO server_emojis(id,server_id,name,image_url,created_by,created_at) VALUES(?,?,?,?,?,?)").bind(id,sid,name,url,u.id,now()).run()}catch{return fail("That emoji name already exists or could not be added.",409)}return json({emoji:{id,name,image_url:url}},201)}if(m==="DELETE"&&eid){if(!manager)return fail("Server owner access required.",403);await ensureMessageExtras(env);await env.DB.prepare("DELETE FROM server_emojis WHERE id=? AND server_id=?").bind(eid,sid).run();await env.DB.prepare("DELETE FROM message_reactions WHERE emoji=? AND message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.server_id=?)").bind("custom:"+eid,sid).run();return json({ok:true})}}
const serverAdminMatch=p.match(/^\/api\/servers\/([\w-]+)\/(settings|stats|members|roles|onboarding)$/);
if(serverAdminMatch){
 const sid=serverAdminMatch[1],section=serverAdminMatch[2];
 const server=await env.DB.prepare("SELECT id,name,icon_url,is_system,owner_id,created_at FROM servers WHERE id=?").bind(sid).first();
 if(!server)return fail("Server not found.",404);
 const membership=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(sid,u.id).first();
 if(!membership)return fail("You are not a member of this server.",403);
 const manager=isOwner(u)||server.owner_id===u.id;
 if(section==="settings"&&m==="GET")return json({server,can_manage:manager});
 if(section==="settings"&&m==="POST"){
  if(!manager)return fail("Server owner access required.",403);
  const b=await body(req),name=String(b.name??server.name).trim().slice(0,50),icon=String(b.icon_url??server.icon_url??"").trim();
  if(name.length<2)return fail("Server name must be at least 2 characters.");
  if(icon&&!/^https:\/\//i.test(icon))return fail("Server icon must be an HTTPS URL.");
  await env.DB.prepare("UPDATE servers SET name=?,icon_url=? WHERE id=?").bind(name,icon||null,sid).run();
  return json({server:{...server,name,icon_url:icon||null}});
 }
 if(section==="stats"&&m==="GET"){
  const [members,channels,messages,roles]=await Promise.all([
   env.DB.prepare("SELECT COUNT(*) AS count FROM memberships WHERE server_id=?").bind(sid).first(),
   env.DB.prepare("SELECT COUNT(*) AS count FROM channels WHERE server_id=?").bind(sid).first(),
   env.DB.prepare("SELECT COUNT(*) AS count FROM messages m JOIN channels c ON c.id=m.channel_id WHERE c.server_id=?").bind(sid).first(),
   env.DB.prepare("SELECT COUNT(*) AS count FROM roles WHERE server_id=?").bind(sid).first()
  ]);
  return json({stats:{members:members.count,channels:channels.count,messages:messages.count,roles:roles.count,created_at:server.created_at}});
 }
 if(section==="members"&&m==="GET"){
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#99aab5'").run().catch(()=>{});
  await ensureAccountTables(env);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_presence(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_seen_at INTEGER NOT NULL)").run();
  const a=await env.DB.prepare("SELECT u.id,COALESCE(up.discord_username,u.username) AS username,COALESCE(up.display_name,u.username) AS display_name,up.avatar_url,up.bio,up.pronouns,CASE WHEN COALESCE(json_extract(pref.settings_json,'$.privacy.showOnlineStatus'),1)=0 THEN 'offline' WHEN COALESCE(pr.last_seen_at,0)>=? THEN COALESCE(up.status,'online') ELSE 'offline' END AS presence,u.account_type,u.status,m.joined_at,COALESCE((SELECT group_concat(r.name, ', ') FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=m.server_id AND mr.user_id=m.user_id),'@everyone') AS roles,(SELECT json_group_array(json_object('id',r.id,'name',r.name,'color',COALESCE(r.color,'#99aab5'),'position',r.position)) FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=m.server_id AND mr.user_id=m.user_id) AS roles_json FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN user_profiles up ON up.user_id=u.id LEFT JOIN user_presence pr ON pr.user_id=u.id LEFT JOIN user_preferences pref ON pref.user_id=u.id WHERE m.server_id=? ORDER BY m.joined_at").bind(now()-45,sid).all();
  return json({members:a.results,can_manage:manager});
 }
 if(section==="roles"&&m==="GET"){
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#99aab5'").run().catch(()=>{});
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});
  const a=await env.DB.prepare("SELECT id,name,is_system,position,pingable,color FROM roles WHERE server_id=? ORDER BY position DESC,name").bind(sid).all();
  return json({roles:a.results,can_manage:manager});
 }
 if(section==="roles"&&m==="POST"){
  if(!manager)return fail("Server owner access required.",403);
  const b=await body(req),name=String(b.name||"").trim().slice(0,32);
  if(!/^[A-Za-z0-9 _-]{2,32}$/.test(name))return fail("Role names must be 2–32 letters, numbers, spaces, _ or -.");
  const id=uid(),position=Number((await env.DB.prepare("SELECT COALESCE(MAX(position),1)+1 AS n FROM roles WHERE server_id=?").bind(sid).first()).n);
  try{await env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?,?,0,?)").bind(id,sid,name,position).run();}catch{return fail("A role with that name already exists.",409);}
  return json({role:{id,name,is_system:0,position}},201);
 }
 if(section==="onboarding"){
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_onboarding(server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 0,welcome_text TEXT NOT NULL DEFAULT '',rules_text TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS onboarding_completions(server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,completed_at INTEGER NOT NULL,PRIMARY KEY(server_id,user_id))").run();
  if(m==="GET"){
   const config=await env.DB.prepare("SELECT enabled,welcome_text,rules_text FROM server_onboarding WHERE server_id=?").bind(sid).first()||{enabled:0,welcome_text:"Welcome! Please read the rules before chatting.",rules_text:"Be respectful. No spam or harassment."};
   const done=await env.DB.prepare("SELECT 1 FROM onboarding_completions WHERE server_id=? AND user_id=?").bind(sid,u.id).first();
   return json({config,completed:!!done,can_manage:manager});
  }
  if(m==="POST"){
   const b=await body(req);
   if(b.complete===true){
    await env.DB.prepare("INSERT OR REPLACE INTO onboarding_completions(server_id,user_id,completed_at) VALUES(?,?,?)").bind(sid,u.id,now()).run();
    return json({ok:true});
   }
   if(!manager)return fail("Server owner access required.",403);
   const enabled=b.enabled?1:0,welcome=String(b.welcome_text||"").trim().slice(0,1000),rules=String(b.rules_text||"").trim().slice(0,3000);
   await env.DB.prepare("INSERT INTO server_onboarding(server_id,enabled,welcome_text,rules_text,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET enabled=excluded.enabled,welcome_text=excluded.welcome_text,rules_text=excluded.rules_text,updated_at=excluded.updated_at").bind(sid,enabled,welcome,rules,now()).run();
   return json({ok:true});
  }
 }
}
const roleRoute=p.match(/^\/api\/servers\/([\w-]+)\/roles\/([\w-]+)$/);
if(roleRoute&&(m==="POST"||m==="DELETE")){
 const sid=roleRoute[1],rid=roleRoute[2],sv=await env.DB.prepare("SELECT owner_id FROM servers WHERE id=?").bind(sid).first();
 if(!sv)return fail("Server not found.",404);
 if(!isOwner(u)&&sv.owner_id!==u.id)return fail("Server owner access required.",403);
 const role=await env.DB.prepare("SELECT id,is_system FROM roles WHERE id=? AND server_id=?").bind(rid,sid).first();
 if(!role)return fail("Role not found.",404);
 if(m==="DELETE"){
  if(role.is_system)return fail("System roles cannot be deleted.",403);
  await env.DB.prepare("DELETE FROM roles WHERE id=? AND server_id=?").bind(rid,sid).run();
  return json({ok:true});
 }
 const b=await body(req);
 if(typeof b.pingable==="boolean"){
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});
  await env.DB.prepare("UPDATE roles SET pingable=? WHERE id=? AND server_id=?").bind(b.pingable?1:0,rid,sid).run();
  return json({ok:true,pingable:b.pingable});
 }
 if(typeof b.color==="string"){
  const color=b.color.trim();
  if(!/^#[0-9a-fA-F]{6}$/.test(color))return fail("Role color must be a six-digit hex color.");
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#99aab5'").run().catch(()=>{});
  await env.DB.prepare("UPDATE roles SET color=? WHERE id=? AND server_id=?").bind(color.toLowerCase(),rid,sid).run();
  return json({ok:true,color:color.toLowerCase()});
 }
 if(role.is_system)return fail("System role names cannot be changed.",403);
 const name=String(b.name||"").trim().slice(0,32);
 if(!/^[A-Za-z0-9 _-]{2,32}$/.test(name))return fail("Role names must be 2–32 letters, numbers, spaces, _ or -.");
 try{await env.DB.prepare("UPDATE roles SET name=? WHERE id=? AND server_id=?").bind(name,rid,sid).run();}catch{return fail("A role with that name already exists.",409);}
 return json({ok:true,name});
}
const memberRoleRoute=p.match(/^\/api\/servers\/([\w-]+)\/members\/([\w-]+)\/roles$/);
if(memberRoleRoute&&m==="POST"){
 const sid=memberRoleRoute[1],target=memberRoleRoute[2],sv=await env.DB.prepare("SELECT owner_id FROM servers WHERE id=?").bind(sid).first();
 if(!sv)return fail("Server not found.",404);
 if(!isOwner(u)&&sv.owner_id!==u.id)return fail("Server owner access required.",403);
 const b=await body(req),rid=String(b.role_id||"");
 const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(sid,target).first();
 const role=await env.DB.prepare("SELECT id,name FROM roles WHERE id=? AND server_id=?").bind(rid,sid).first();
 if(!member||!role)return fail("Member or role not found.",404);
 if(role.name==="@everyone")return fail("The @everyone role is assigned automatically.",403);
 if(b.remove)await env.DB.prepare("DELETE FROM member_roles WHERE server_id=? AND user_id=? AND role_id=?").bind(sid,target,rid).run();
 else await env.DB.prepare("INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(sid,target,rid).run();
 return json({ok:true});
}


/* User-managed server sections. */
const sectionPath=p.split("/").filter(Boolean);
if(sectionPath[0]==="api"&&sectionPath[1]==="servers"&&sectionPath[3]==="sections"){
 const sid=sectionPath[2];
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_sections(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(server_id,name))").run();
 await env.DB.prepare("ALTER TABLE channels ADD COLUMN section_id TEXT").run().catch(()=>{});
 const server=await env.DB.prepare("SELECT owner_id FROM servers WHERE id=?").bind(sid).first();
 const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(sid,u.id).first();
 if(!server||!member)return fail("Server not found or access denied.",403);
 const manager=isOwner(u)||server.owner_id===u.id;
 if(sectionPath.length===4&&m==="GET"){
  const rows=await env.DB.prepare("SELECT id,name,position FROM server_sections WHERE server_id=? ORDER BY position,name").bind(sid).all();
  return json({sections:rows.results,can_manage:manager});
 }
 if(sectionPath.length===4&&m==="POST"){
  if(!manager)return fail("Server owner access required.",403);
  const b=await body(req),name=String(b.name||"").trim().slice(0,40);
  if(!/^[A-Za-z0-9 _-]{2,40}$/.test(name))return fail("Section names must be 2–40 letters, numbers, spaces, _ or -.");
  const id=uid(),position=Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM server_sections WHERE server_id=?").bind(sid).first()).n);
  try{await env.DB.prepare("INSERT INTO server_sections(id,server_id,name,position,created_at) VALUES(?,?,?,?,?)").bind(id,sid,name,position,now()).run();}
  catch{return fail("A section with that name already exists.",409);}
  return json({section:{id,name,position}},201);
 }
 if(sectionPath.length===5&&(m==="PATCH"||m==="DELETE")){
  if(!manager)return fail("Server owner access required.",403);
  const id=sectionPath[4],exists=await env.DB.prepare("SELECT id FROM server_sections WHERE id=? AND server_id=?").bind(id,sid).first();
  if(!exists)return fail("Section not found.",404);
  if(m==="DELETE"){
   await env.DB.prepare("UPDATE channels SET section_id=NULL WHERE section_id=?").bind(id).run();
   await env.DB.prepare("DELETE FROM server_sections WHERE id=?").bind(id).run();
   return json({ok:true});
  }
  const b=await body(req),name=String(b.name||"").trim().slice(0,40);
  if(!/^[A-Za-z0-9 _-]{2,40}$/.test(name))return fail("Invalid section name.");
  const position=Number.isFinite(Number(b.position))?Math.max(0,Math.min(500,Number(b.position))):0;
  await env.DB.prepare("UPDATE server_sections SET name=?,position=? WHERE id=? AND server_id=?").bind(name,position,id,sid).run();
  return json({ok:true});
 }
}


/* Per-channel permission overwrites. */
const channelRouteParts=p.split("/").filter(Boolean);
if(channelRouteParts[0]==="api"&&channelRouteParts[1]==="channels"&&channelRouteParts[3]==="permissions"){
 const cid=channelRouteParts[2];await ensureChannelPermissionTable(env);
 const channel=await env.DB.prepare("SELECT c.server_id,s.owner_id FROM channels c JOIN servers s ON s.id=c.server_id WHERE c.id=?").bind(cid).first();
 if(!channel)return fail("Channel not found.",404);
 const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(channel.server_id,u.id).first();
 if(!member)return fail("Not a server member.",403);
 const manager=isOwner(u)||channel.owner_id===u.id;
 if(m==="GET"){
  if(!manager)return fail("Server owner access required.",403);
  const rows=await env.DB.prepare("SELECT target_type,target_id,allow_json,deny_json FROM channel_permissions WHERE channel_id=?").bind(cid).all();
  return json({permissions:rows.results});
 }
 if(m==="POST"){
  if(!manager)return fail("Server owner access required.",403);
  const b=await body(req),type=b.target_type==="user"?"user":"role",target=String(b.target_id||"");
  const validNames=new Set(["view_channel","send_messages","read_message_history","attach_files","embed_links","manage_messages"]);
  if(!target||!Array.isArray(b.allow)||!Array.isArray(b.deny)||[...b.allow,...b.deny].some(value=>!validNames.has(value)))return fail("Invalid permission overwrite.");
  const valid=type==="role"?await env.DB.prepare("SELECT id FROM roles WHERE id=? AND server_id=?").bind(target,channel.server_id).first():await env.DB.prepare("SELECT user_id AS id FROM memberships WHERE user_id=? AND server_id=?").bind(target,channel.server_id).first();
  if(!valid)return fail("Permission target is not part of this server.",404);
  await env.DB.prepare("INSERT INTO channel_permissions(channel_id,target_type,target_id,allow_json,deny_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,target_type,target_id) DO UPDATE SET allow_json=excluded.allow_json,deny_json=excluded.deny_json,updated_at=excluded.updated_at").bind(cid,type,target,JSON.stringify([...new Set(b.allow)]),JSON.stringify([...new Set(b.deny)]),now()).run();
  return json({ok:true});
 }
 if(m==="DELETE"){
  if(!manager)return fail("Server owner access required.",403);
  const b=await body(req);await env.DB.prepare("DELETE FROM channel_permissions WHERE channel_id=? AND target_type=? AND target_id=?").bind(cid,b.target_type==="user"?"user":"role",String(b.target_id||"")).run();
  return json({ok:true});
 }
}
x=p.match(/^\/api\/servers\/([\w-]+)\/channels$/);if(x&&m==="GET"){const mem=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(x[1],u.id).first();if(!mem)return fail("Not a server member.",403);await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_channel_links(discord_channel_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,mallow_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,category_name TEXT,updated_at INTEGER NOT NULL)").run();await env.DB.prepare("CREATE TABLE IF NOT EXISTS server_sections(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(server_id,name))").run();await env.DB.prepare("ALTER TABLE channels ADD COLUMN section_id TEXT").run().catch(()=>{});const a=await env.DB.prepare("SELECT c.id,c.name,c.kind,c.position,c.section_id,ss.name AS section_name,d.category_name,d.discord_channel_id FROM channels c LEFT JOIN discord_channel_links d ON d.mallow_channel_id=c.id LEFT JOIN server_sections ss ON ss.id=c.section_id WHERE c.server_id=? ORDER BY COALESCE(ss.position,999),COALESCE(d.category_name,ss.name),c.position").bind(x[1]).all();const checks=await Promise.all(a.results.map(ch=>channelPermissionAllowed(env,ch.id,u.id,"view_channel")));const visible=a.results.filter((ch,i)=>checks[i]);return json({channels:visible});}

if(x&&m==="POST"){
 const sid=x[1],sv=await env.DB.prepare("SELECT owner_id FROM servers WHERE id=?").bind(sid).first();
 if(!sv)return fail("Server not found.",404);
 if(!isOwner(u)&&sv.owner_id!==u.id)return fail("Server owner access required.",403);
 await env.DB.prepare("ALTER TABLE channels ADD COLUMN section_id TEXT").run().catch(()=>{});const b=await body(req),name=String(b.name||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,50),kind=b.kind==="voice"?"voice":"text",sectionId=String(b.section_id||"")||null;
 if(name.length<2)return fail("Channel name must be at least 2 characters.");
 const position=Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM channels WHERE server_id=?").bind(sid).first()).n),id=uid();
 if(sectionId&&!await env.DB.prepare("SELECT id FROM server_sections WHERE id=? AND server_id=?").bind(sectionId,sid).first())return fail("Section not found.",404);try{await env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position,section_id) VALUES(?,?,?,?,?,?)").bind(id,sid,name,kind,position,sectionId).run();}catch{return fail("A channel with that name could not be created.",409);}
 return json({channel:{id,name,kind,position}},201);
}


/* Message replies, reactions, edits, deletes and forwarding */
const forwardRoute=p.match(/^\/api\/messages\/([\w-]+)\/forward$/);
if(forwardRoute&&m==="POST"){const source=await env.DB.prepare("SELECT m.id,m.content,u.username,c.server_id FROM messages m JOIN users u ON u.id=m.author_id JOIN channels c ON c.id=m.channel_id WHERE m.id=?").bind(forwardRoute[1]).first();if(!source)return fail("Message not found.",404);const sourceMember=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(source.server_id,u.id).first();if(!sourceMember)return fail("You cannot access this message.",403);const b=await body(req),target=String(b.target_channel_id||"");const targetChannel=await env.DB.prepare("SELECT c.id,c.server_id FROM channels c JOIN memberships m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=? AND c.kind='text'").bind(target,u.id).first();if(!targetChannel)return fail("Choose a text channel you belong to.",403);const id=uid(),t=now();await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(id,target,u.id,source.content,t).run();await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_forwards(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,source_message_id TEXT,source_username TEXT NOT NULL,created_at INTEGER NOT NULL)").run();await env.DB.prepare("INSERT INTO message_forwards(message_id,source_message_id,source_username,created_at) VALUES(?,?,?,?)").bind(id,source.id,source.username,t).run();return json({ok:true,message:{id,content:source.content,created_at:t}},201);}

async function ensureMessageExtras(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_replies(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,reply_to_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_reactions(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,emoji TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(message_id,user_id,emoji))").run();
}
const messageAction=p.match(/^\/api\/messages\/([\w-]+)(?:\/(edit|reactions))?$/);
if(messageAction){
 const mid=messageAction[1],action=messageAction[2]||"";
 const row=await env.DB.prepare("SELECT m.id,m.channel_id,m.author_id,c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=?").bind(mid).first();
 if(!row)return fail("Message not found.",404);
 const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(row.server_id,u.id).first();
 if(!member)return fail("You cannot access this message.",403);
 await ensureMessageExtras(env);
 if(action==="edit"&&m==="POST"){
  if(row.author_id!==u.id)return fail("You can only edit your own messages.",403);
  const content=String((await body(req)).content||"").trim();
  if(!content||content.length>4000)return fail("Message must be 1–4000 characters.");
  await env.DB.prepare("UPDATE messages SET content=?,edited_at=? WHERE id=?").bind(content,now(),mid).run();return json({ok:true});
 }
 if(action==="reactions"&&m==="POST"){
  const emoji=String((await body(req)).emoji||"");const custom=emoji.match(/^custom:([\w-]+)$/);if(custom){const exists=await env.DB.prepare("SELECT id FROM server_emojis WHERE id=? AND server_id=?").bind(custom[1],row.server_id).first();if(!exists)return fail("Custom emoji not found in this server.",404)}else if(!["👍","❤️","😂","🎉","👀","🔥","😭","💀","😮","😢","👏","✅","😀","🥹","😍","😎","🙏","✨","🚀","💯","👎","🤔"].includes(emoji))return fail("That reaction is not supported.");
  const exists=await env.DB.prepare("SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?").bind(mid,u.id,emoji).first();
  if(exists)await env.DB.prepare("DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?").bind(mid,u.id,emoji).run();
  else await env.DB.prepare("INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)").bind(mid,u.id,emoji,now()).run();
  return json({ok:true,added:!exists});
 }
 if(!action&&m==="DELETE"){
  if(row.author_id!==u.id&&!isOwner(u))return fail("You can only delete your own messages.",403);
  await env.DB.prepare("DELETE FROM messages WHERE id=?").bind(mid).run();return json({ok:true});
 }
}



if(p==="/api/discord/link/status"&&m==="GET"){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_account_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,UNIQUE(server_id,user_id))").run();
 const server=await env.DB.prepare("SELECT id FROM servers WHERE is_system=1 LIMIT 1").first();
 const linked=server?await env.DB.prepare("SELECT discord_user_id FROM discord_account_links WHERE user_id=? AND server_id=?").bind(u.id,server.id).first():null;
 return json({linked:!!linked,discord_user_id:linked?.discord_user_id||null});
}
if(p==="/api/discord/link/start"&&m==="POST"){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_link_codes(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_account_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,UNIQUE(server_id,user_id))").run();
 const server=await env.DB.prepare("SELECT id FROM servers WHERE is_system=1 LIMIT 1").first();if(!server)return fail("Mallow Swamp is not initialized.",503);
 const linked=await env.DB.prepare("SELECT discord_user_id FROM discord_account_links WHERE user_id=? AND server_id=?").bind(u.id,server.id).first();if(linked)return fail("A Discord account is already linked.",409);
 const alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",bytes=crypto.getRandomValues(new Uint8Array(8));let code="";for(const n of bytes)code+=alphabet[n%alphabet.length];
 await env.DB.prepare("DELETE FROM discord_link_codes WHERE user_id=?").bind(u.id).run();
 await env.DB.prepare("INSERT INTO discord_link_codes(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha(code),u.id,now()+600,now()).run();
 return json({code,expires_in:600,instructions:"Send a private DM to Mallow Bot with -mb link "+code});
}

if(p==="/api/bot/command"&&m==="POST"){
 const b=await body(req),channelId=String(b.channel_id||""),content=String(b.content||"").trim();
 if(!channelId||!content||content.length>4000)return fail("A channel and command are required.");
 const member=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=? AND c.kind='text'").bind(channelId,u.id).first();
 if(!member||!await channelPermissionAllowed(env,channelId,u.id,"view_channel")||!await channelPermissionAllowed(env,channelId,u.id,"send_messages"))return fail("You cannot run bot commands in this channel.",403);
 if(!/^(?:-mb|\/mb)\s+[a-z0-9-]+(?:\s+[\s\S]*)?$/i.test(content))return fail("Use -mb help to see the Mallow-Bot command list.");
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_user_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL)").run();
 const system=await env.DB.prepare("SELECT id FROM servers WHERE is_system=1 LIMIT 1").first();
 const linked=system?await env.DB.prepare("SELECT discord_user_id FROM discord_account_links WHERE user_id=? AND server_id=?").bind(u.id,system.id).first():null;
 if(!linked)return fail("Link your Discord account in User Settings → Discord Link before running Mallow-Bot commands.",403);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_command_jobs(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,discord_user_id TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,processed_at INTEGER)").run();
 await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(uid(),channelId,u.id,content,now()).run();
 const mapped=await env.DB.prepare("SELECT discord_channel_id FROM discord_channel_links WHERE mallow_channel_id=? AND server_id=?").bind(channelId,system.id).first();if(!mapped)return fail("Mallow-Bot commands are only available in channels synchronized with the official Discord server.",400);
 const pending=await env.DB.prepare("SELECT COUNT(*) AS n FROM discord_command_jobs WHERE user_id=? AND status IN ('queued','processing')").bind(u.id).first();if(Number(pending?.n||0)>=5)return fail("You have too many commands waiting. Try again in a moment.",429);
 const jobId=uid();await env.DB.prepare("INSERT INTO discord_command_jobs(id,server_id,channel_id,user_id,discord_user_id,content,status,created_at) VALUES(?,?,?,?,?,?,'queued',?)").bind(jobId,system.id,channelId,u.id,linked.discord_user_id,content,now()).run();
 return json({ok:true,accepted:true,queued:true});
}

async function ensureAttachmentTable(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_attachments(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,filename TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,object_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)").run();
}
function attachmentBase64(bytes){
 let binary="";for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
 return btoa(binary);
}
const attachmentUploadRoute=p.match(/^\/api\/channels\/([\w-]+)\/attachments$/);
if(attachmentUploadRoute&&m==="POST"){
 const channelId=attachmentUploadRoute[1],member=await env.DB.prepare("SELECT c.server_id FROM channels c JOIN memberships mm ON mm.server_id=c.server_id WHERE c.id=? AND mm.user_id=?").bind(channelId,u.id).first();
 if(!member||!await channelPermissionAllowed(env,channelId,u.id,"view_channel")||!await channelPermissionAllowed(env,channelId,u.id,"attach_files"))return fail("You cannot upload files to this channel.",403);
 if(!env.GITHUB_TOKEN)return fail("GitHub file storage is not configured yet.",503);
 const form=await req.formData(),file=form.get("file");
 if(!file||typeof file.arrayBuffer!=="function")return fail("Choose a file to upload.");
 if(file.size<1||file.size>25*1024*1024)return fail("Files must be between 1 byte and 25 MB.");
 const filename=String(file.name||"attachment").replace(/[\\/\\0-\\x1f\\x7f]/g,"_").trim().slice(0,180)||"attachment";
 const type=String(file.type||"application/octet-stream").toLowerCase().slice(0,120);
 if(/^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/javascript|text\/javascript)/i.test(type))return fail("This file type cannot be uploaded.",415);
 await ensureAttachmentTable(env);
 const id=uid(),key="mallowcord-uploads/"+channelId+"/"+id+".bin";
 const bytes=new Uint8Array(await file.arrayBuffer());
 const apiUrl="https://api.github.com/repos/WebsiteDevelopmentStudios/MallowCord/contents/"+key.split("/").map(encodeURIComponent).join("/");
 const gh=await fetch(apiUrl,{method:"PUT",headers:{"Authorization":"Bearer "+env.GITHUB_TOKEN,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:JSON.stringify({message:"Store MallowCord attachment",content:attachmentBase64(bytes),branch:"main"})});
 if(!gh.ok){const detail=(await gh.text()).slice(0,500);return fail("GitHub storage upload failed ("+gh.status+"). "+detail,502);}
 try{await env.DB.prepare("INSERT INTO message_attachments(id,channel_id,uploader_id,message_id,filename,content_type,size,object_key,created_at) VALUES(?,?,?,NULL,?,?,?,?,?)").bind(id,channelId,u.id,filename,type,file.size,key,now()).run();}
 catch(e){throw e;}
 return json({attachment:{id,filename,content_type:type,size:file.size}},201);
}
const attachmentDownloadRoute=p.match(/^\/api\/attachments\/([\w-]+)$/);
if(attachmentDownloadRoute&&m==="GET"){
 await ensureAttachmentTable(env);
 const file=await env.DB.prepare("SELECT a.*,c.server_id FROM message_attachments a JOIN channels c ON c.id=a.channel_id JOIN memberships mm ON mm.server_id=c.server_id WHERE a.id=? AND mm.user_id=?").bind(attachmentDownloadRoute[1],u.id).first();
 if(!file)return fail("Attachment not found.",404);
 const rawUrl="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/MallowCord/main/"+file.object_key.split("/").map(encodeURIComponent).join("/");
 const stored=await fetch(rawUrl,{headers:{"Cache-Control":"no-cache"}});
 if(!stored.ok)return fail("File not found in GitHub storage.",404);
 const plain=await stored.arrayBuffer();
 const inline=/^image\/(png|jpeg|gif|webp)$/.test(file.content_type);
 const encoded=encodeURIComponent(file.filename).replace(/['()*]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
 const headers=new Headers({"Content-Type":inline?file.content_type:"application/octet-stream","Content-Length":String(file.size),"Content-Disposition":(inline?"inline":"attachment")+"; filename*=UTF-8''"+encoded,"X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store"});
 return new Response(plain,{headers});
}
x=p.match(/^\/api\/channels\/([\w-]+)\/messages$/);if(x&&m==="GET"){
 const channelId=x[1],mem=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(channelId,u.id).first();
 if(!mem||!await channelPermissionAllowed(env,channelId,u.id,"view_channel")||!await channelPermissionAllowed(env,channelId,u.id,"read_message_history"))return fail("You cannot view this channel.",403);
 await ensureMessageExtras(env);await ensureAccountTables(env);await env.DB.prepare("ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '#99aab5'").run().catch(()=>{});await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_forwards(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,source_message_id TEXT,source_username TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,source_user_id TEXT REFERENCES users(id),username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 const base=await env.DB.prepare("SELECT m.id,m.content,m.created_at,m.edited_at,COALESCE(up.display_name,u.username) AS username,up.avatar_url,up.bio,up.status,up.pronouns,u.id AS author_id,COALESCE((SELECT r.color FROM member_roles mr2 JOIN roles r ON r.id=mr2.role_id WHERE mr2.server_id=? AND mr2.user_id=u.id ORDER BY r.position DESC LIMIT 1),'') AS role_color,pr.reply_to_id,ru.username AS reply_username,rm.content AS reply_content,EXISTS(SELECT 1 FROM message_notifications mn WHERE mn.message_id=m.id AND mn.user_id=? AND mn.kind='mention' AND mn.seen_at IS NULL) AS is_mentioned,EXISTS(SELECT 1 FROM message_notifications mn WHERE mn.message_id=m.id AND mn.user_id=? AND mn.kind='reply' AND mn.seen_at IS NULL) AS is_reply_to_you,(SELECT mf.source_username FROM message_forwards mf WHERE mf.message_id=m.id) AS forwarded_from FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN user_profiles up ON up.user_id=u.id LEFT JOIN message_replies pr ON pr.message_id=m.id LEFT JOIN messages rm ON rm.id=pr.reply_to_id LEFT JOIN users ru ON ru.id=rm.author_id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 75").bind(u.id,u.id,mem.server_id,channelId).all();
 const regular=base.results.reverse();
 const bots=await env.DB.prepare("SELECT id,content,created_at,username,avatar_url,source_user_id FROM bot_messages WHERE channel_id=? ORDER BY created_at DESC LIMIT 75").bind(channelId).all();
 const messages=[...regular.map(msg=>({...msg,is_bot:false,reply_to:msg.reply_to_id?{username:msg.reply_username,content:msg.reply_content}:null,reactions:[]})),...bots.results.map(msg=>({id:msg.id,content:msg.content,created_at:msg.created_at,edited_at:null,username:msg.username,avatar_url:msg.avatar_url,author_id:"mallowcord-bot",is_bot:true,forwarded_from:null,reply_to:null,reactions:[]}))].sort((a,b)=>a.created_at-b.created_at).slice(-75);
 const ids=regular.map(msg=>msg.id),byMessage=new Map(),attachmentsByMessage=new Map();
 await ensureAttachmentTable(env);
 if(ids.length){
  const marks=ids.map(()=>"?").join(",");
  const files=await env.DB.prepare("SELECT id,message_id,filename,content_type,size FROM message_attachments WHERE message_id IN ("+marks+") ORDER BY created_at").bind(...ids).all();
  for(const f of files.results){if(!attachmentsByMessage.has(f.message_id))attachmentsByMessage.set(f.message_id,[]);attachmentsByMessage.get(f.message_id).push({id:f.id,filename:f.filename,content_type:f.content_type,size:f.size});}
 }
 if(ids.length){
  const placeholders=ids.map(()=>"?").join(",");
  const reactions=await env.DB.prepare("SELECT r.message_id,r.emoji,COUNT(*) AS count,MAX(CASE WHEN r.user_id=? THEN 1 ELSE 0 END) AS mine,se.name AS custom_name,se.image_url AS custom_url FROM message_reactions r LEFT JOIN server_emojis se ON r.emoji='custom:'||se.id WHERE r.message_id IN ("+placeholders+") GROUP BY r.message_id,r.emoji,se.name,se.image_url").bind(u.id,...ids).all();
  for(const reaction of reactions.results){if(!byMessage.has(reaction.message_id))byMessage.set(reaction.message_id,[]);byMessage.get(reaction.message_id).push({emoji:reaction.emoji,count:reaction.count,mine:!!reaction.mine,custom_name:reaction.custom_name,custom_url:reaction.custom_url});}
 }
 for(const msg of messages){if(!msg.is_bot){msg.reactions=byMessage.get(msg.id)||[];msg.attachments=attachmentsByMessage.get(msg.id)||[];}else msg.attachments=[];}
 const result={messages};
 if(new URL(req.url).searchParams.get("include_directory")==="1"){
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});
  const roleMentions=(await env.DB.prepare("SELECT id,name,pingable FROM roles WHERE server_id=?").bind(mem.server_id).all()).results;
  const userMentions=(await env.DB.prepare("SELECT u.id,u.username,COALESCE(up.display_name,u.username) AS display_name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN user_profiles up ON up.user_id=u.id WHERE m.server_id=?").bind(mem.server_id).all()).results;
  const channelMentions=(await env.DB.prepare("SELECT id,name,kind FROM channels WHERE server_id=? AND kind='text' ORDER BY position").bind(mem.server_id).all()).results;
  result.role_mentions=roleMentions;result.user_mentions=userMentions;result.channel_mentions=channelMentions;
 }
 return json(result);
}
if(x&&m==="POST"){
 const b=await body(req),content=String(b.content||"").trim(),attachmentIds=Array.isArray(b.attachment_ids)?[...new Set(b.attachment_ids.map(v=>String(v)).filter(v=>/^[\w-]{1,80}$/.test(v)))]:[];
 if((!content&&!attachmentIds.length)||content.length>4000||attachmentIds.length>10)return fail("Add a message or up to 10 attachments.");
 await ensureAttachmentTable(env);
 const mem=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(x[1],u.id).first();if(!mem||!await channelPermissionAllowed(env,x[1],u.id,"view_channel")||!await channelPermissionAllowed(env,x[1],u.id,"send_messages"))return fail("You cannot send messages here.",403);
 for(const attachmentId of attachmentIds){const pending=await env.DB.prepare("SELECT id FROM message_attachments WHERE id=? AND channel_id=? AND uploader_id=? AND message_id IS NULL").bind(attachmentId,x[1],u.id).first();if(!pending)return fail("One of the uploaded files is unavailable. Please attach it again.",400);}
 await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_notifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,message_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('mention','reply')),created_at INTEGER NOT NULL,seen_at INTEGER,UNIQUE(user_id,message_id,kind))").run();
 const roles=(await env.DB.prepare("SELECT id,name,pingable FROM roles WHERE server_id=?").bind(mem.server_id).all()).results;
 const contains=token=>content.toLowerCase().includes(String(token).toLowerCase());
 const notify=new Set(),users=(await env.DB.prepare("SELECT u.id,u.username FROM memberships sm JOIN users u ON u.id=sm.user_id WHERE sm.server_id=?").bind(mem.server_id).all()).results;
 for(const target of users)if(target.id!==u.id&&contains("@"+target.username))notify.add(target.id);
 for(const role of roles){const token=role.name.startsWith("@")?role.name:"@"+role.name;if(!contains(token))continue;if(!role.pingable)return fail("The "+role.name+" role does not allow mentions.",403);const recipients=role.name.toLowerCase()==="@everyone"?users:(await env.DB.prepare("SELECT user_id AS id FROM member_roles WHERE server_id=? AND role_id=?").bind(mem.server_id,role.id).all()).results;for(const target of recipients)if(target.id!==u.id)notify.add(target.id);}
 const mid=uid(),t=now();await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(mid,x[1],u.id,content,t).run();
 for(const attachmentId of attachmentIds)await env.DB.prepare("UPDATE message_attachments SET message_id=? WHERE id=? AND channel_id=? AND uploader_id=? AND message_id IS NULL").bind(mid,attachmentId,x[1],u.id).run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS discord_outbox(id TEXT PRIMARY KEY,discord_channel_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL,processed_at INTEGER,discord_message_id TEXT)").run();
 const dl=await env.DB.prepare("SELECT discord_channel_id FROM discord_channel_links WHERE mallow_channel_id=?").bind(x[1]).first();if(dl){const author=await env.DB.prepare("SELECT COALESCE(up.display_name,u.username) AS username,up.avatar_url FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id WHERE u.id=?").bind(u.id).first();await env.DB.prepare("INSERT OR IGNORE INTO discord_outbox(id,discord_channel_id,message_id,username,avatar_url,content,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(),dl.discord_channel_id,mid,author?.username||u.username,author?.avatar_url||null,content,t).run();}
 let replyRecipient=null;if(b.reply_to_id){const parent=await env.DB.prepare("SELECT id,author_id FROM messages WHERE id=? AND channel_id=?").bind(String(b.reply_to_id),x[1]).first();if(parent){await ensureMessageExtras(env);await env.DB.prepare("INSERT INTO message_replies(message_id,reply_to_id) VALUES(?,?)").bind(mid,parent.id).run();if(parent.author_id!==u.id){notify.add(parent.author_id);replyRecipient=parent.author_id;}}}
 for(const targetId of notify){const kind=targetId===replyRecipient?"reply":"mention";await env.DB.prepare("INSERT OR IGNORE INTO message_notifications(id,user_id,server_id,channel_id,message_id,kind,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(),targetId,mem.server_id,x[1],mid,kind,t).run();}
 return json({message:{id:mid,content,created_at:t,username:u.username,author_id:u.id}},201);
}
if(p==="/api/integrations/mallowbot/users"&&(m==="GET"||m==="POST")){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(m==="GET"){const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,ownerRow?.id,id2,"mallowbot_create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
let integrationMod=p.match(/^\/api\/integrations\/mallowbot\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(integrationMod&&m==="POST"){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const target=integrationMod[1],action=integrationMod[2],b=await body(req),ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(!ownerRow)return fail("Owner not initialized.",503);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),target).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),target).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),target).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(target).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();await audit(env,ownerRow.id,target,"mallowbot_"+action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/users"&&m==="GET"){if(!isOwner(u))return fail("Owner access required.",403);const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}
if(p==="/api/admin/users"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,u.id,id2,"create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
x=p.match(/^\/api\/admin\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(x&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);if(x[1]===u.id)return fail("You cannot moderate your owner account.");const target=await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(x[1]).first();if(!target)return fail("User not found.",404);const action=x[2],b=await body(req);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),x[1]).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(x[1]).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(x[1]).run();await audit(env,u.id,x[1],action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/ip-ban"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),target=String(b.ip||"").trim();if(!target)return fail("IP address required.");await env.DB.prepare("INSERT INTO bans(id,ip_hash,reason,created_by,created_at) VALUES(?,?,?,?,?)").bind(uid(),await sha(target+env.IP_HASH_SECRET),String(b.reason||"Global IP ban").slice(0,300),u.id,now()).run();await audit(env,u.id,null,"global_ip_ban");return json({ok:true});}
if(p==="/api/admin/errors"&&(m==="GET"||m==="DELETE")){
 if(!isOwner(u))return fail("Owner access required.",403);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS worker_error_logs(id TEXT PRIMARY KEY,method TEXT NOT NULL,path TEXT NOT NULL,message TEXT NOT NULL,stack TEXT,origin TEXT,user_agent TEXT,created_at INTEGER NOT NULL)").run();
 if(m==="DELETE"){await env.DB.prepare("DELETE FROM worker_error_logs").run();return json({ok:true});}
 const a=await env.DB.prepare("SELECT id,method,path,message,stack,origin,created_at FROM worker_error_logs ORDER BY created_at DESC LIMIT 200").all();
 return json({errors:a.results});
}
if(p==="/api/admin/audit"&&m==="GET"&&isOwner(u)){const a=await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all();return json({events:a.results});}
if(!p.startsWith("/api/")&&env.FRONTEND_ORIGIN){const target=new URL(p,env.FRONTEND_ORIGIN);target.search=new URL(req.url).search;return fetch(new Request(target.toString(),req));}
return fail("Not found.",404);}
export default {async fetch(req,env){const origin=req.headers.get("Origin")||"";const allowed=origin===env.FRONTEND_ORIGIN;const cors={"Access-Control-Allow-Origin":allowed?origin:"null","Access-Control-Allow-Credentials":"true","Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-MallowBot-Key","Vary":"Origin"};if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});try{const response=await handle(req,env);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}catch(e){const errorPath=new URL(req.url).pathname,errorMessage=String(e&&e.message||"Unknown Worker error"),errorStack=String(e&&e.stack||e||"").slice(0,12000);console.error("MallowCord Worker request failed",req.method,errorPath,errorStack);try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS worker_error_logs(id TEXT PRIMARY KEY,method TEXT NOT NULL,path TEXT NOT NULL,message TEXT NOT NULL,stack TEXT,origin TEXT,user_agent TEXT,created_at INTEGER NOT NULL)").run();await env.DB.prepare("INSERT INTO worker_error_logs(id,method,path,message,stack,origin,user_agent,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(uid(),req.method,errorPath,errorMessage,errorStack,origin,req.headers.get("User-Agent")||"",Date.now()).run();}catch(logError){console.error("Could not persist MallowCord error log",logError&&logError.message||logError)}const response=json({error:"Internal server error.",detail:errorMessage,path:errorPath},500);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:500,headers});}}};