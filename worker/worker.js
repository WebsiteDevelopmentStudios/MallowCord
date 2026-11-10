const COOKIE="mallowcord_device",DAYS=30;
const now=()=>Math.floor(Date.now()/1000),uid=()=>crypto.randomUUID();
const json=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...h}});
const fail=(e,s=400)=>json({error:e},s),hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
const sha=async v=>hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,"0")).join("");
const setCookie=v=>COOKIE+"="+v+"; Path=/; HttpOnly; Secure; SameSite=None; Max-Age="+(DAYS*86400);
const clearCookie=()=>COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0";
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
if(p==="/api/auth/username"&&m==="POST"){const name=String((await body(req)).username||"").trim();if(!/^[A-Za-z0-9_]{3,24}$/.test(name))return fail("Username must be 3–24 characters.");try{await env.DB.prepare("UPDATE users SET username=?,username_key=?,updated_at=? WHERE id=?").bind(name,name.toLowerCase(),now(),u.id).run();}catch{return fail("That username is already taken.",409);}return json({username:name});}
if(p==="/api/auth/recovery/rotate"&&m==="POST"&&u.account_type==="basic")return json({recovery_code:await recovery(env,u.id)});
if(p==="/api/servers"&&m==="GET"){const a=await env.DB.prepare("SELECT s.id,s.name,s.icon_url,s.is_system,m.joined_at FROM memberships m JOIN servers s ON s.id=m.server_id WHERE m.user_id=? ORDER BY s.is_system DESC,s.name").bind(u.id).all();return json({servers:a.results});}
if(p==="/api/servers"&&m==="POST"){if(u.account_type==="basic")return fail("Full-access accounts are required to create servers.",403);const name=String((await body(req)).name||"").trim().slice(0,50);if(name.length<2)return fail("Server name must be at least 2 characters.");const s=uid(),r=uid(),rm=uid(),c=uid(),t=now();await env.DB.batch([env.DB.prepare("INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)").bind(s,name,u.id,t),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@everyone',1,0)").bind(r,s),env.DB.prepare("INSERT INTO roles(id,server_id,name,is_system,position) VALUES(?,?, '@Member',1,1)").bind(rm,s),env.DB.prepare("INSERT INTO channels(id,server_id,name,kind,position) VALUES(?,?, 'general','text',0)").bind(c,s),env.DB.prepare("INSERT INTO memberships(server_id,user_id,joined_at) VALUES(?,?,?)").bind(s,u.id,t),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u.id,r),env.DB.prepare("INSERT INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)").bind(s,u.id,rm)]);return json({server:{id:s,name}},201);}

/* Server administration: channels, roles, members, stats and onboarding */
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
  const a=await env.DB.prepare("SELECT id,name,is_system,position FROM roles WHERE server_id=? ORDER BY position DESC,name").bind(sid).all();
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


/* Message replies, reactions, edits and deletes */
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
  const emoji=String((await body(req)).emoji||"");
  if(!["👍","❤️","😂","🎉","👀","🔥","😭","💀","😮","😢","👏","✅"].includes(emoji))return fail("That reaction is not supported.");
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

x=p.match(/^\/api\/channels\/([\w-]+)\/messages$/);if(x&&m==="GET"){const mem=await env.DB.prepare("SELECT 1 FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(x[1],u.id).first();if(!mem)return fail("You cannot view this channel.",403);await ensureMessageExtras(env);
const a=await env.DB.prepare("SELECT m.id,m.content,m.created_at,m.edited_at,u.username,u.id AS author_id,pr.reply_to_id,ru.username AS reply_username,rm.content AS reply_content FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN message_replies pr ON pr.message_id=m.id LEFT JOIN messages rm ON rm.id=pr.reply_to_id LEFT JOIN users ru ON ru.id=rm.author_id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 75").bind(x[1]).all();
const results=await Promise.all(a.results.reverse().map(async msg=>{
 const rr=await env.DB.prepare("SELECT emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM message_reactions WHERE message_id=? GROUP BY emoji").bind(u.id,msg.id).all();
 return {...msg,reply_to:msg.reply_to_id?{username:msg.reply_username,content:msg.reply_content}:null,reactions:rr.results};
}));
return json({messages:results});}
if(x&&m==="POST"){const b=await body(req),content=String(b.content||"").trim();if(!content||content.length>4000)return fail("Message must be 1–4000 characters.");const mem=await env.DB.prepare("SELECT 1 FROM memberships m JOIN channels c ON c.server_id=m.server_id WHERE c.id=? AND m.user_id=?").bind(x[1],u.id).first();if(!mem)return fail("You cannot send messages here.",403);const mid=uid(),t=now();await env.DB.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)").bind(mid,x[1],u.id,content,t).run();if(b.reply_to_id){const parent=await env.DB.prepare("SELECT id FROM messages WHERE id=? AND channel_id=?").bind(String(b.reply_to_id),x[1]).first();if(parent){await ensureMessageExtras(env);await env.DB.prepare("INSERT INTO message_replies(message_id,reply_to_id) VALUES(?,?)").bind(mid,parent.id).run();}}return json({message:{id:mid,content,created_at:t,username:u.username,author_id:u.id}},201);}
if(p==="/api/integrations/mallowbot/users"&&(m==="GET"||m==="POST")){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(m==="GET"){const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,ownerRow?.id,id2,"mallowbot_create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
let integrationMod=p.match(/^\/api\/integrations\/mallowbot\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(integrationMod&&m==="POST"){if(!env.MALLOWBOT_SERVICE_KEY||req.headers.get("X-MallowBot-Key")!==env.MALLOWBOT_SERVICE_KEY)return fail("Integration authentication failed.",401);const target=integrationMod[1],action=integrationMod[2],b=await body(req),ownerRow=await env.DB.prepare("SELECT id FROM users WHERE account_type='owner' LIMIT 1").first();if(!ownerRow)return fail("Owner not initialized.",503);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),target).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),target).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),target).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(target).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target).run();await audit(env,ownerRow.id,target,"mallowbot_"+action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/users"&&m==="GET"){if(!isOwner(u))return fail("Owner access required.",403);const a=await env.DB.prepare("SELECT id,username,account_type,status,timeout_until,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json({users:a.results});}
if(p==="/api/admin/users"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),name=String(b.username||"").trim(),pw=String(b.password||"");if(!/^[A-Za-z0-9_]{3,24}$/.test(name)||pw.length<12)return fail("Use a valid username and password of at least 12 characters.");const id2=uid(),t=now();try{await env.DB.prepare("INSERT INTO users(id,username,username_key,account_type,password_hash,created_at,updated_at) VALUES(?,?,?,'full',?,?,?)").bind(id2,name,name.toLowerCase(),await passwordHash(pw),t,t).run();}catch{return fail("That username is already taken.",409);}await joinSwamp(env,id2);await audit(env,u.id,id2,"create_full_account");return json({user:{id:id2,username:name,account_type:"full"}},201);}
x=p.match(/^\/api\/admin\/users\/([\w-]+)\/(timeout|ban|unban|delete)$/);if(x&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);if(x[1]===u.id)return fail("You cannot moderate your owner account.");const target=await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(x[1]).first();if(!target)return fail("User not found.",404);const action=x[2],b=await body(req);if(action==="timeout"){const secs=Math.max(60,Math.min(2592000,Number(b.seconds)||600));await env.DB.prepare("UPDATE users SET status='timed_out',timeout_until=?,updated_at=? WHERE id=?").bind(now()+secs,now(),x[1]).run();}if(action==="ban")await env.DB.prepare("UPDATE users SET status='banned',updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="unban")await env.DB.prepare("UPDATE users SET status='active',timeout_until=NULL,updated_at=? WHERE id=?").bind(now(),x[1]).run();if(action==="delete")await env.DB.prepare("DELETE FROM users WHERE id=?").bind(x[1]).run();if(action==="ban"||action==="delete")await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(x[1]).run();await audit(env,u.id,x[1],action,JSON.stringify(b));return json({ok:true});}
if(p==="/api/admin/ip-ban"&&m==="POST"){if(!isOwner(u))return fail("Owner access required.",403);const b=await body(req),target=String(b.ip||"").trim();if(!target)return fail("IP address required.");await env.DB.prepare("INSERT INTO bans(id,ip_hash,reason,created_by,created_at) VALUES(?,?,?,?,?)").bind(uid(),await sha(target+env.IP_HASH_SECRET),String(b.reason||"Global IP ban").slice(0,300),u.id,now()).run();await audit(env,u.id,null,"global_ip_ban");return json({ok:true});}
if(p==="/api/admin/audit"&&m==="GET"&&isOwner(u)){const a=await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all();return json({events:a.results});}
if(!p.startsWith("/api/")&&env.FRONTEND_ORIGIN){const target=new URL(p,env.FRONTEND_ORIGIN);target.search=new URL(req.url).search;return fetch(new Request(target.toString(),req));}
return fail("Not found.",404);}
export default {async fetch(req,env){const origin=req.headers.get("Origin")||"";const allowed=origin===env.FRONTEND_ORIGIN;const cors={"Access-Control-Allow-Origin":allowed?origin:"null","Access-Control-Allow-Credentials":"true","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-MallowBot-Key","Vary":"Origin"};if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});try{const response=await handle(req,env);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}catch(e){const response=json({error:"Internal server error.",detail:env.ENVIRONMENT==="development"?e.message:undefined},500);const headers=new Headers(response.headers);if(allowed)for(const [k,v] of Object.entries(cors))headers.set(k,v);return new Response(response.body,{status:500,headers});}}};