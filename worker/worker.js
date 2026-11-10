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
async function bootstrap(env,secret){if(!env.BOOTSTRAP_SECRET||secret!==env.BOOTSTRAP_SECRET)throw Error("Invalid bootstrap secret.");if(await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first())return {already_initialized:true};if(!env.OWNER_PASSWORD||env.OWNER_PASSWORD.length<12)throw Error("Set OWNER_PASSWORD to at least 12 characters.");const t=now(),u=uid(),name=env.OWNER_USERNAME||"Blemmished";await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'owner',?,?,?)").bind(u,name,name.toLowerCase(),await passwordHash(env.OWNER_PASSWORD),t,t).run();const s=uid(),r1=uid(),r2=uid(),ch=uid();await env.DB.batch([env.DB.prepare("INSERT INTO servers(id,name,owner_id,icon_url,is_system,created_at) VALUES(?,?,?,?,1,?)").bind(s,"Mallow Swamp",u,env.MALLOWBOT_ICON_URL||null,t),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@everyone',1,0)").bind(r1,s),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@Member',1,1)").bind(r2,s),env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?, 'general','text',0)").bind(ch,s),env.DB.prepare("INSERT INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(s,u,t),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u,r1),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u,r2)]);return {initialized:true,owner:name,server:"Mallow Swamp"};}
async function handle(req,env){const p=new URL(req.url).pathname,m=req.method;
if(p==="/api/health")return json({ok:true,service:"mallowcord",time:now()});
if(p!=="/api/bootstrap"&&env.DB){const blocked=await env.DB.prepare("SELECT id FROM bans WHERE ip_hash=? AND server_id IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").bind(await ipDigest(req,env),now()).first();if(blocked)return fail("Access to MallowCord is blocked.",403);}
if(p==="/api/bootstrap"&&m==="POST"){try{return json(await bootstrap(env,(await body(req)).secret));}catch(e){return fail(e.message,403);}}
if(p==="/api/integrations/mallowbot/users"&&(m==="GET"||m==="POST")){
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

if(p==="/api/auth/register"&&m==="POST"){const b=await body(req),name=String(b.username||"").trim();if(!/^[A-Za-z0-9_]{3,24}$/.test(name))return fail("Username must be 3–24 letters, numbers or underscores.");if(!await env.DB.prepare("SELECT id FROM servers WHERE is_system=1 LIMIT 1").first())return fail("Mallow Swamp is not initialized yet.",503);const t=now(),u=uid();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,created_at,updated_at) VALUES(?,?,?,'basic',?,?)").bind(u,name,name.toLowerCase(),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,u);const code=await recovery(env,u);return json({user:{id:u,username:name,account_type:"basic"},recovery_code:code},201,{"set-cookie":await session(req,env,u)});}
if(p==="/api/auth/login"&&m==="POST"){const b=await body(req),name=String(b.username||"").trim().toLowerCase(),u=await env.DB.prepare("SELECT * FROM users WHERE username_key=?").bind(name).first();if(!u||u.status!=="active")return fail("Invalid sign-in details.",401);if(u.account_type==="basic")return fail("Basic accounts use device cookies. Use the recovery screen on a new device.",409);if(!await passwordCheck(String(b.password||""),u.password_hash))return fail("Invalid sign-in details.",401);return json({user:{id:u.id,username:u.username,account_type:u.account_type}},200,{"set-cookie":await session(req,env,u.id)});}
if(p==="/api/auth/recover"&&m==="POST"){const b=await body(req),name=String(b.username||"").trim().toLowerCase(),code=String(b.recovery_code||"").replace(/-/g,"").toUpperCase(),u=await env.DB.prepare("SELECT * FROM users WHERE username_key=? AND account_type='basic' AND status='active'").bind(name).first();if(!u)return fail("Username or recovery code is incorrect.",401);const c=await env.DB.prepare("SELECT id FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL").bind(u.id,await sha(code)).first();if(!c)return fail("Username or recovery code is incorrect.",401);await env.DB.prepare("UPDATE recovery_codes SET used_at=? WHERE id=?").bind(now(),c.id).run();await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(u.id).run();const next=await recovery(env,u.id);return json({user:{id:u.id,username:u.username,account_type:"basic"},recovery_code:next},200,{"set-cookie":await session(req,env,u.id)});}
if(p==="/api/auth/logout"&&m==="POST"){const u=await userFor(req,env);if(u)await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(u.session_id).run();return json({ok:true},200,{"set-cookie":clearCookie()});}
const u=await userFor(req,env);
if(p==="/api/auth/me"&&m==="GET")return u?json({user:{id:u.id,username:u.username,account_type:u.account_type}}):fail("Not signed in.",401);
if(!u)return fail("Sign in required.",401);
const banned=await env.DB.prepare("SELECT id FROM bans WHERE ip_hash=? AND server_id IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1").bind(await ipDigest(req,env),now()).first();if(banned)return fail("Access to MallowCord is blocked.",403);
if(u.timed_out&&p.startsWith("/api/")&&!["/api/auth/me","/api/auth/logout"].includes(p))return fail("Your account is timed out.",403);

/* Account profile, preferences, password and verified contact methods */
async function ensureAccountTables(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,display_name TEXT,avatar_url TEXT,email TEXT,email_verified_at INTEGER,phone TEXT,phone_verified_at INTEGER,updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,settings_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS contact_verifications(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,channel TEXT NOT NULL,target TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)").run();
}
if(p==="/api/account/profile"&&(m==="GET"||m==="POST")){
 await ensureAccountTables(env);
 if(m==="GET"){
  const profile=await env.DB.prepare("SELECT display_name,avatar_url,bio,status,pronouns,email,email_verified_at,phone,phone_verified_at FROM user_profiles WHERE user_id=?").bind(u.id).first();
  return json({profile:profile||{display_name:null,avatar_url:null,bio:null,status:'online',pronouns:null,email:null,email_verified_at:null,phone:null,phone_verified_at:null},username:u.username,account_type:u.account_type});
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
if(p==="/api/account/password"&&m==="POST"){
 if(u.account_type==="basic")return fail("Basic accounts use device sign-in and recovery codes. Password login is available on full-access accounts.",403);
 const b=await body(req),old=String(b.current_password||""),next=String(b.new_password||"");
 const stored=await env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(u.id).first();
 if(!await passwordCheck(old,stored?.password_hash))return fail("Your current password is incorrect.",401);
 if(next.length<12||next.length>256)return fail("New password must be at least 12 characters.");
 if(next===old)return fail("Choose a password different from your current one.");
 await env.DB.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").bind(await passwordHash(next),now(),u.id).run();
 await audit(env,u.id,u.id,"change_password");
 return json({ok:true});
}
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
if(p==="/api/auth/recovery/rotate"&&m==="POST"&&u.account_type==="basic")return json({recovery_code:await recovery(env,u.id)});
if(p==="/api/servers"&&m==="GET"){const a=await env.DB.prepare("SELECT s.id,s.name,COALESCE(s.icon_url,CASE WHEN s.is_system=1 THEN ? END) AS icon_url,s.is_system,m.joined_at FROM memberships m JOIN servers s ON s.id=m.server_id WHERE m.user_id=? ORDER BY s.is_system DESC,s.name").bind(env.MALLOWBOT_ICON_URL||"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",u.id).all();return json({servers:a.results});}
if(p==="/api/servers"&&m==="POST"){if(u.account_type==="basic")return fail("Full-access accounts are required to create servers.",403);const name=String((await body(req)).name||"").trim().slice(0,50);if(name.length<2)return fail("Server name must be at least 2 characters.");const s=uid(),r=uid(),rm=uid(),c=uid(),t=now();await env.DB.batch([env.DB.prepare("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)").bind(s,name,u.id,t),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@everyone',1,0)").bind(r,s),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@Member',1,1)").bind(rm,s),env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?, 'general','text',0)").bind(c,s),env.DB.prepare("INSERT INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(s,u.id,t),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u.id,r),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u.id,rm)]);return json({server:{id:s,name}},201);}

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
  const a=await env.DB.prepare("SELECT u.id,u.username,u.account_type,u.status,m.joined_at,COALESCE((SELECT group_concat(r.name, ', ') FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=m.server_id AND mr.user_id=m.user_id),'@everyone') AS roles FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.joined_at").bind(sid).all();
  return json({members:a.results,can_manage:manager});
 }
 if(section==="roles"&&m==="GET"){
  await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});
  const a=await env.DB.prepare("SELECT id,name,is_system,position,pingable FROM roles WHERE server_id=? ORDER BY position DESC,name").bind(sid).all();
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
 if(m==="POST"){
  const b=await body(req);
  if(typeof b.pingable==="boolean"){
   await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});
   await env.DB.prepare("UPDATE roles SET pingable=? WHERE id=? AND server_id=?").bind(b.pingable?1:0,rid,sid).run();
   return json({ok:true,pingable:b.pingable});
  }
 }
 if(role.is_system)return fail("System roles cannot be changed or deleted.",403);
 if(m==="DELETE"){await env.DB.prepare("DELETE FROM roles WHERE id=? AND server_id=?").bind(rid,sid).run();return json({ok:true});}
 const name=String((await body(req)).name||"").trim().slice(0,32);
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

let x=p.match(/^\/api\/servers\/([\w-]+)\/channels$/);if(x&&m==="GET"){const mem=await env.DB.prepare("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?").bind(x[1],u.id).first();if(!mem)return fail("Not a server member.",403);const a=await env.DB.prepare("SELECT id,name,kind,position FROM channels WHERE server_id=? ORDER BY position").bind(x[1]).all();return json({channels:a.results});}

if(x&&m==="POST"){
 const sid=x[1],sv=await env.DB.prepare("SELECT owner_id FROM servers WHERE id=?").bind(sid).first();
 if(!sv)return fail("Server not found.",404);
 if(!isOwner(u)&&sv.owner_id!==u.id)return fail("Server owner access required.",403);
 const b=await body(req),name=String(b.name||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,50),kind=b.kind==="voice"?"voice":"text";
 if(name.length<2)return fail("Channel name must be at least 2 characters.");
 const position=Number((await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM channels WHERE server_id=?").bind(sid).first()).n),id=uid();
 try{await env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?,?,?,?)").bind(id,sid,name,kind,position).run();}catch{return fail("A channel with that name could not be created.",409);}
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


if(p==="/api/bot/command"&&m==="POST"){
 const b=await body(req),channelId=String(b.channel_id||""),content=String(b.content||"").trim();
 if(!channelId||!content||content.length>4000)return fail("A channel and command are required.");
 const member=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=? AND c.kind='text'").bind(channelId,u.id).first();
 if(!member)return fail("You cannot run bot commands in this channel.",403);
 const match=content.match(/^(?:-mb|\/mb)\s+([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
 if(!match)return fail("Use -mb help to see the Mallow-Bot command list.");
 const command=match[1].toLowerCase(),t=now();
 const catalog="Mallow-Bot commands\n\nXP & levels\n- -mb xp\n- -mb level\n- -mb leaderboard\n\nMallow Coins\n- -mb balance\n- -mb daily\n- -mb gamble\n- -mb coinflip\n- -mb slots\n- -mb roulette\n- -mb dice\n- -mb blackjack\n- -mb work\n- -mb pay\n- -mb rob\n\nFun & social\n- -mb vibecheck\n- -mb ship\n- -mb fortune\n- -mb wyr\n- -mb youtube\n\nModeration & tickets\n- -mb purge\n- -mb dm\n- -mb ticket\n- -mb ticket-panel\n- -mb ticket-close\n- -mb timeout-minutes\n\nUtilities & media\n- -mb uptime\n- -mb update\n- -mb countdown\n- -mb movie\n- -mb channel\n- -mb set-log\n- -mb sync\n\nPremium\n- -mb embed\n- -mb snipe\n- -mb sticky\n- -mb backup\n- -mb custom-command\n- -mb vanity\n- -mb premium-status\n\nThe full command set currently runs inside Discord. This MallowCord server is not connected to a Discord guild and member identity yet, so commands that read server data or perform moderation cannot execute here.";
 let reply;
 if(command==="help"||command==="commands")reply=catalog;
 else reply="I received "+content+", but this command needs a linked Discord server and member identity. Run -mb commands to see the available commands. MallowCord does not yet have that Discord link configured.";
 await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(uid(),channelId,u.id,content,t).run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,source_user_id TEXT REFERENCES users(id),username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("INSERT INTO bot_messages(id,channel_id,source_user_id,username,avatar_url,content,created_at) VALUES(?,?,?,?,?,?,?)").bind(uid(),channelId,u.id,"Mallow Bot",env.MALLOWBOT_ICON_URL||"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",reply,t+1).run();
 return json({ok:true,accepted:true});
}

x=p.match(/^\/api\/channels\/([\w-]+)\/messages$/);if(x&&m==="GET"){
 const channelId=x[1],mem=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(channelId,u.id).first();
 if(!mem)return fail("You cannot view this channel.",403);
 await ensureMessageExtras(env);await ensureAccountTables(env);
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS message_forwards(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,source_message_id TEXT,source_username TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS bot_messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,source_user_id TEXT REFERENCES users(id),username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
 const base=await env.DB.prepare("SELECT m.id,m.content,m.created_at,m.edited_at,COALESCE(up.display_name,u.username) AS username,up.avatar_url,up.bio,up.status,up.pronouns,u.id AS author_id,pr.reply_to_id,ru.username AS reply_username,rm.content AS reply_content,(SELECT mf.source_username FROM message_forwards mf WHERE mf.message_id=m.id) AS forwarded_from FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN user_profiles up ON up.user_id=u.id LEFT JOIN message_replies pr ON pr.message_id=m.id LEFT JOIN messages rm ON rm.id=pr.reply_to_id LEFT JOIN users ru ON ru.id=rm.author_id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 75").bind(channelId).all();
 const regular=base.results.reverse();
 const bots=await env.DB.prepare("SELECT id,content,created_at,username,avatar_url,source_user_id FROM bot_messages WHERE channel_id=? ORDER BY created_at DESC LIMIT 75").bind(channelId).all();
 const messages=[...regular.map(msg=>({...msg,is_bot:false,reply_to:msg.reply_to_id?{username:msg.reply_username,content:msg.reply_content}:null,reactions:[]})),...bots.results.map(msg=>({id:msg.id,content:msg.content,created_at:msg.created_at,edited_at:null,username:msg.username,avatar_url:msg.avatar_url,author_id:"mallowcord-bot",is_bot:true,forwarded_from:null,reply_to:null,reactions:[]}))].sort((a,b)=>a.created_at-b.created_at).slice(-75);
 const ids=regular.map(msg=>msg.id),byMessage=new Map();
 if(ids.length){
  const placeholders=ids.map(()=>"?").join(",");
  const reactions=await env.DB.prepare("SELECT r.message_id,r.emoji,COUNT(*) AS count,MAX(CASE WHEN r.user_id=? THEN 1 ELSE 0 END) AS mine,se.name AS custom_name,se.image_url AS custom_url FROM message_reactions r LEFT JOIN server_emojis se ON r.emoji='custom:'||se.id WHERE r.message_id IN ("+placeholders+") GROUP BY r.message_id,r.emoji,se.name,se.image_url").bind(u.id,...ids).all();
  for(const reaction of reactions.results){if(!byMessage.has(reaction.message_id))byMessage.set(reaction.message_id,[]);byMessage.get(reaction.message_id).push({emoji:reaction.emoji,count:reaction.count,mine:!!reaction.mine,custom_name:reaction.custom_name,custom_url:reaction.custom_url});}
 }
 for(const msg of messages){if(!msg.is_bot)msg.reactions=byMessage.get(msg.id)||[];}
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
if(x&&m==="POST"){const b=await body(req),content=String(b.content||"").trim();if(!content||content.length>4000)return fail("Message must be 1–4000 characters.");const mem=await env.DB.prepare("SELECT c.server_id FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(x[1],u.id).first();if(!mem)return fail("You cannot send messages here.",403);await env.DB.prepare("ALTER TABLE roles ADD COLUMN pingable INTEGER NOT NULL DEFAULT 1").run().catch(()=>{});const rolesToCheck=(await env.DB.prepare("SELECT name,pingable FROM roles WHERE server_id=?").bind(mem.server_id).all()).results;for(const role of rolesToCheck){if(role.name&&content.toLowerCase().includes((role.name.startsWith("@")?role.name:"@"+role.name).toLowerCase())&&!role.pingable)return fail("The "+role.name+" role does not allow mentions.",403);}const mid=uid(),t=now();await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(mid,x[1],u.id,content,t).run();if(b.reply_to_id){const parent=await env.DB.prepare("SELECT id FROM messages WHERE id=? AND channel_id=?").bind(String(b.reply_to_id),x[1]).first();if(parent){await ensureMessageExtras(env);await env.DB.prepare("INSERT INTO message_replies(message_id,reply_to_id) VALUES(?,?)").bind(mid,parent.id).run();}}return json({message:{id:mid,content,created_at:t,username:u.username,author_id:u.id}},201);}
if(p==="/api/integrations/mallowbot/users"&&(m==="GET"||m==="POST")){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(m==="GET"){const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,ownerRow?.id,id2,"mallowbot_create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
let integrationMod=p.match(/^\/api\/integrations\/mallowbot\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(integrationMod&&m==="POST"){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const target=integrationMod[1],action=integrationMod[2],b=await body(req),ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(!ownerRow)return fail("Owner not initialized.",503);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),target).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),target).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),target).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(target).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();await audit(env,ownerRow.id,target,"mallowbot_"+action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/users"&&m==="GET"){if(!isOwner(u))return fail("Owner access required.",403);const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}
if(p==="/api/admin/users"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,u.id,id2,"create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
x=p.match(/^\/api\/admin\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(x&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);if(x[1]===u.id)return fail("You cannot moderate your owner account.");const target=await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(x[1]).first();if(!target)return fail("User not found.",404);const action=x[2],b=await body(req);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),x[1]).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(x[1]).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(x[1]).run();await audit(env,u.id,x[1],action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/ip-ban"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),target=String(b.ip||"").trim();if(!target)return fail("IP address required.");await env.DB.prepare("INSERT INTO bans(id,ip_hash,reason,created_by,created_at) VALUES(?,?,?,?,?)").bind(uid(),await sha(target+env.IP_HASH_SECRET),String(b.reason||"Global IP ban").slice(0,300),u.id,now()).run();await audit(env,u.id,null,"global_ip_ban");return json({ok:true});}
if(p==="/api/admin/audit"&&m==="GET"&&isOwner(u)){const a=await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all();return json({events:a.results});}
if(!p.startsWith("/api/")&&env.FRONTEND_ORIGIN){const target=new URL(p,env.FRONTEND_ORIGIN);target.search=new URL(req.url).search;return fetch(new Request(target.toString(),req));}
return fail("Not found.",404);}
export default {async fetch(req,env){const origin=req.headers.get("Origin")||"";const allowed=origin===env.FRONTEND_ORIGIN;const cors={"Access-Control-Allow-Origin":allowed?origin:"null","Access-Control-Allow-Credentials":"true","Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-MallowBot-Key","Vary":"Origin"};if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});try{const response=await handle(req,env);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}catch(e){const response=json({error:"Internal server error.",detail:env.ENVIRONMENT==="development"?e.message:undefined},500);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:500,headers});}}};