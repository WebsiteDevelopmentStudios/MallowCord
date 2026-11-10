const API_BASE="https://mallowcord-api.wowgrayhaha.workers.dev/api";
const $=s=>document.querySelector(s);
let me=null,serverId=null,channelId=null,currentChannel=null,poll=null,currentServer=null,serverRoles=[],canManageServer=false,replyingTo=null,contextMessage=null;
async function api(path,opts={}){const r=await fetch(API_BASE+path,{credentials:"include",headers:{"content-type":"application/json",...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Request failed");return d}
function toast(s){const t=$("#toast");t.textContent=s;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600)}
function status(s){$("#authStatus").textContent=s}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function revealCode(c){$("#recoveryCode").textContent=c;$("#recoveryBox").classList.remove("hidden")}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));["register","login","recover"].forEach(k=>$("#"+k+"Form").classList.toggle("hidden",k!==b.dataset.tab));status("");$("#recoveryBox").classList.add("hidden")}));
$("#registerForm").onsubmit=async e=>{e.preventDefault();try{const d=await api("/auth/register",{method:"POST",body:JSON.stringify({username:e.target.username.value})});me=d.user;revealCode(d.recovery_code);status("Account created. Copy or write down your recovery code, then select Continue.")}catch(x){status(x.message)}};
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector("button[type=submit],button:not([type])"),data=new FormData(form),username=String(data.get("username")||"").trim(),password=String(data.get("password")||"");status("Signing in…");if(button){button.disabled=true;button.textContent="Signing in…"}try{const d=await api("/auth/login",{method:"POST",body:JSON.stringify({username,password})});me=d.user;status("Signed in. Loading MallowCord…");await enterApp()}catch(x){status("Sign-in failed: "+(x?.message||"Unknown error"))}finally{if(button){button.disabled=false;button.textContent="Sign in"}}});
$("#recoverForm").onsubmit=async e=>{e.preventDefault();try{const d=await api("/auth/recover",{method:"POST",body:JSON.stringify({username:e.target.username.value,recovery_code:e.target.recovery_code.value})});me=d.user;revealCode(d.recovery_code);status("Device recovered. Save your new recovery code, then select Continue.")}catch(x){status(x.message)}};
$("#copyRecovery").onclick=async()=>{try{await navigator.clipboard.writeText($("#recoveryCode").textContent);toast("Recovery code copied")}catch{status("Clipboard access was blocked. Select and copy the code manually.")}};
$("#continueRecovery").onclick=()=>enterApp();
async function enterApp(){try{if(!me)me=(await api("/auth/me")).user;$("#auth").classList.add("hidden");$("#app").classList.remove("hidden");$("#currentUsername").textContent=me.username;$("#userAvatar").textContent=me.username[0].toUpperCase();$("#accountType").textContent=me.account_type==="basic"?"Basic account":"Full access";$("#addServer").style.display=me.account_type==="basic"?"none":"grid";await loadServers()}catch(e){$("#auth").classList.remove("hidden");$("#app").classList.add("hidden");status("Signed in, but MallowCord could not load: "+(e?.message||"Unknown error"))}}
async function loadServers(){const d=await api("/servers");const list=d.servers||[];const rail=document.querySelector(".servers");rail.innerHTML="";for(const s of list){const b=document.createElement("button");b.type="button";b.className="server-icon"+(s.id===serverId?" active":"");b.title=s.name;b.dataset.serverId=s.id;b.textContent=(s.name||"?")[0].toUpperCase();if(s.icon_url){const im=document.createElement("img");im.src=s.icon_url;im.alt=s.name;im.onerror=()=>im.remove();b.textContent="";b.append(im)}b.onclick=()=>selectServer(s);rail.append(b)}const divider=document.createElement("div");divider.className="server-divider";rail.append(divider);const add=document.createElement("button");add.id="addServer";add.type="button";add.className="server-icon add";add.title="Create server";add.textContent="+";add.style.display=me.account_type==="basic"?"none":"grid";add.onclick=createServer;rail.append(add);if(!list.length){toast("You have not joined a server yet.");return}const selected=list.find(x=>x.id===serverId)||list.find(x=>x.is_system)||list[0];await selectServer(selected)}
async function selectServer(s){serverId=s.id;currentServer=s;channelId=null;currentChannel=null;$("#workspaceName").textContent=s.name;$("#channelTitle").textContent="Select a channel";$("#messages").innerHTML="";$("#channelList").innerHTML="";document.querySelectorAll(".server-icon").forEach(b=>b.classList.toggle("active",b.dataset.serverId===s.id));try{const meta=await api("/servers/"+serverId+"/settings");canManageServer=!!meta.can_manage}catch{canManageServer=false}$("#createChannelBtn").style.display=canManageServer?"grid":"none";await loadChannels();checkOnboarding().catch(e=>console.warn("Onboarding:",e))}
async function loadChannels(){const d=await api("/servers/"+serverId+"/channels");const box=$("#channelList");box.innerHTML="";if(!d.channels.length){box.innerHTML='<div class="empty-state">No channels yet.</div>';return}d.channels.forEach(c=>{const el=document.createElement("button");el.type="button";el.className="channel";el.dataset.id=c.id;el.innerHTML='<span class="channel-kind">'+(c.kind==="voice"?"◖))":"#")+'</span>'+esc(c.name);el.onclick=()=>selectChannel(c);box.append(el)});if(d.channels[0])selectChannel(d.channels[0])}
function selectChannel(c){channelId=c.id;currentChannel=c;$("#channelTitle").textContent=c.name;document.querySelectorAll(".channel").forEach(x=>x.classList.toggle("active",x.dataset.id===c.id));const voice=c.kind==="voice";$("#messages").classList.toggle("hidden",voice);$("#messageForm").classList.toggle("hidden",voice);$("#welcome").classList.toggle("hidden",voice);let notice=$("#voiceRoomNotice");if(!notice){notice=document.createElement("div");notice.id="voiceRoomNotice";notice.className="voice-room-notice";notice.innerHTML='<div class="voice-room-symbol">◖))</div><h2>Voice room</h2><p>This voice room is ready. Live voice calling is not connected yet.</p>';$(".chat").append(notice)}notice.classList.toggle("hidden",!voice);if(poll)clearInterval(poll);if(voice){channelId=null;$("#messages").innerHTML="";return}loadMessages();poll=setInterval(loadMessages,5000)}
function renderMarkdown(raw){
 const tick=String.fromCharCode(96),parts=String(raw??"").split(/(\x60{3}[\s\S]*?\x60{3})/g);
 return parts.map(part=>{
  if(part.startsWith(tick.repeat(3))&&part.endsWith(tick.repeat(3))){const body=part.slice(3,-3).replace(/^[a-zA-Z0-9_-]+\n/,"");return "<pre><code>"+esc(body)+"</code></pre>"}
  let safe=esc(part);
  safe=safe.replace(/\x60([^\x60\n]+)\x60/g,"<code>$1</code>");
  safe=safe.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>");
  safe=safe.replace(/__([^_\n]+)__/g,"<u>$1</u>");
  safe=safe.replace(/~~([^~\n]+)~~/g,"<del>$1</del>");
  safe=safe.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>");
  safe=safe.replace(/(^|[^_])_([^_\n]+)_(?!_)/g,"$1<em>$2</em>");
  return safe.split("\n").map(line=>{
   if(/^### /.test(line))return "<h3>"+line.slice(4)+"</h3>";
   if(/^## /.test(line))return "<h2>"+line.slice(3)+"</h2>";
   if(/^# /.test(line))return "<h1>"+line.slice(2)+"</h1>";
   if(/^&gt; /.test(line))return "<blockquote>"+line.slice(5)+"</blockquote>";
   if(/^[-*] /.test(line))return "<div class='md-list-line'>• "+line.slice(2)+"</div>";
   return line;
  }).join("<br>");
 }).join("");
}
function closeMessageMenu(){$("#messageContextMenu")?.classList.add("hidden")}
function openMessageMenu(message,x,y){
 contextMessage=message;const menu=$("#messageContextMenu");
 menu.innerHTML='<button data-action="reply">↩ Reply</button><div class="context-label">Add reaction</div><div class="context-emojis">'+["👍","❤️","😂","🎉","👀","🔥","😭","💀"].map(e=>'<button data-action="react" data-emoji="'+e+'">'+e+'</button>').join("")+'</div>'+(message.author_id===me.id?'<button data-action="edit">✎ Edit message</button><button class="context-danger" data-action="delete">Delete message</button>':'')+'<button data-action="copy">Copy text</button><button data-action="copy-id">Copy message ID</button>';
 menu.classList.remove("hidden");const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";menu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px";
}
async function loadMessages(){
 if(!channelId)return;
 try{
  const d=await api("/channels/"+channelId+"/messages"),box=$("#messages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;
  box.innerHTML=(d.messages||[]).map(m=>{
   const reply=m.reply_to?'<div class="message-reply-preview">↪ Replying to <b>'+esc(m.reply_to.username)+'</b>: '+esc(m.reply_to.content)+'</div>':"";
   const reactions=(m.reactions||[]).map(r=>'<button class="reaction-chip '+(r.mine?"mine":"")+'" data-message="'+m.id+'" data-emoji="'+esc(r.emoji)+'">'+esc(r.emoji)+' <span>'+r.count+'</span></button>').join("");
   return '<article class="message" data-message-id="'+m.id+'"><div class="avatar">'+esc((m.username||"?")[0].toUpperCase())+'</div><div class="message-body">'+reply+'<div class="message-head"><b>'+esc(m.username)+'</b><small>'+new Date(m.created_at*1000).toLocaleString()+(m.edited_at?' · edited':"")+'</small></div><div class="message-content">'+renderMarkdown(m.content)+'</div><div class="message-reactions">'+reactions+'</div></div></article>';
  }).join("");
  box.querySelectorAll(".message").forEach(el=>{const m=(d.messages||[]).find(x=>x.id===el.dataset.messageId);el.addEventListener("contextmenu",e=>{e.preventDefault();openMessageMenu(m,e.clientX,e.clientY)})});
  if(bottom)box.scrollTop=box.scrollHeight;
 }catch(e){toast(e.message)}
}
$("#messageForm").onsubmit=async e=>{e.preventDefault();const input=e.target.content;if(!input.value.trim()||!channelId)return;try{await api("/channels/"+channelId+"/messages",{method:"POST",body:JSON.stringify({content:input.value,reply_to_id:replyingTo?.id||null})});input.value="";clearReply();await loadMessages()}catch(x){toast(x.message)}};

function clearReply(){replyingTo=null;$("#replyingToBar")?.classList.add("hidden")}
function beginReply(m){replyingTo=m;const bar=$("#replyingToBar");bar.innerHTML='Replying to <b>'+esc(m.username)+'</b>: '+esc(m.content.slice(0,140))+'<button type="button" id="cancelReply">×</button>';bar.classList.remove("hidden");$("#cancelReply").onclick=clearReply;$("#messageForm [name=content]").focus();closeMessageMenu()}
document.addEventListener("click",e=>{
 const action=e.target.closest("#messageContextMenu [data-action]");
 if(action&&contextMessage){
  const m=contextMessage,kind=action.dataset.action;closeMessageMenu();
  if(kind==="reply")beginReply(m);
  if(kind==="copy")navigator.clipboard?.writeText(m.content).then(()=>toast("Message copied")).catch(()=>toast("Clipboard unavailable"));
  if(kind==="copy-id")navigator.clipboard?.writeText(m.id).then(()=>toast("Message ID copied")).catch(()=>toast("Clipboard unavailable"));
  if(kind==="react")toggleReaction(m.id,action.dataset.emoji);
  if(kind==="edit"){const value=prompt("Edit your message",m.content);if(value!==null)api("/messages/"+m.id+"/edit",{method:"POST",body:JSON.stringify({content:value})}).then(loadMessages).catch(e=>toast(e.message))}
  if(kind==="delete"&&confirm("Delete this message?"))api("/messages/"+m.id,{method:"DELETE"}).then(loadMessages).catch(e=>toast(e.message));
  return;
 }
 if(!e.target.closest("#messageContextMenu"))closeMessageMenu();
 const chip=e.target.closest(".reaction-chip");if(chip)toggleReaction(chip.dataset.message,chip.dataset.emoji);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeMessageMenu();clearReply()}});
document.addEventListener("scroll",closeMessageMenu,true);
async function toggleReaction(id,emoji){try{await api("/messages/"+id+"/reactions",{method:"POST",body:JSON.stringify({emoji})});await loadMessages()}catch(e){toast(e.message)}}

$("#refreshBtn").onclick=loadMessages;
$("#createChannelBtn").onclick=createChannel;
async function createChannel(){if(!serverId)return;const name=prompt("Channel name (for example: announcements)");if(!name)return;const kind=confirm("Create a voice room? Choose Cancel for a text channel.")?"voice":"text";try{const d=await api("/servers/"+serverId+"/channels",{method:"POST",body:JSON.stringify({name,kind})});toast((kind==="voice"?"Voice room":"Text channel")+" created.");await loadChannels();const found=(await api("/servers/"+serverId+"/channels")).channels.find(c=>c.id===d.channel.id);if(found)selectChannel(found);if(kind==="voice")toast("Voice room created. Live voice calling is not connected yet.")}catch(e){toast(e.message)}}
async function createServer(){const name=prompt("New server name");if(!name)return;try{const d=await api("/servers",{method:"POST",body:JSON.stringify({name})});toast("Server created.");await loadServers();const all=await api("/servers");const s=all.servers.find(x=>x.id===d.server.id);if(s)await selectServer(s)}catch(e){toast(e.message)}}
$("#addServer").onclick=createServer;
$("#serverMenuBtn").onclick=()=>openServerSettings("overview");
$("#closeServerModal").onclick=()=>$("#serverModal").classList.add("hidden");
document.querySelectorAll(".settings-tab").forEach(b=>b.onclick=()=>openServerSettings(b.dataset.settingsTab));
async function openServerSettings(tab="overview"){if(!serverId)return;$("#serverModal").classList.remove("hidden");document.querySelectorAll(".settings-tab").forEach(b=>b.classList.toggle("active",b.dataset.settingsTab===tab));const pane=$("#serverSettingsContent");pane.innerHTML='<div class="settings-loading">Loading…</div>';$("#serverSettingsSubtitle").textContent=currentServer?.name||"Server";try{if(tab==="overview"){const d=await api("/servers/"+serverId+"/settings");const s=d.server;pane.innerHTML='<form id="serverOverviewForm" class="settings-form"><label>Server name<input name="name" maxlength="50" required value="'+esc(s.name)+'"></label><label>Server icon URL<input name="icon_url" type="url" placeholder="https://…" value="'+esc(s.icon_url||"")+'"></label><p class="settings-note">Use a direct HTTPS image URL for the server icon.</p>'+(d.can_manage?'<button class="primary settings-save">Save changes</button>':'<p class="settings-note">Only this server owner can edit server details.</p>')+'</form>'}
if(tab==="stats"){const d=await api("/servers/"+serverId+"/stats"),s=d.stats;pane.innerHTML='<div class="stats-grid">'+statCard("Members",s.members)+statCard("Channels",s.channels)+statCard("Messages",s.messages)+statCard("Roles",s.roles)+'</div><p class="settings-note">Created '+new Date(s.created_at*1000).toLocaleString()+'</p>'}
if(tab==="roles"){const d=await api("/servers/"+serverId+"/roles");serverRoles=d.roles||[];pane.innerHTML=(d.can_manage?'<form id="createRoleForm" class="inline-create"><input name="name" placeholder="New role name" minlength="2" maxlength="32" required><button class="primary">Create role</button></form>':'')+'<div class="settings-list">'+serverRoles.map(r=>'<div class="settings-list-row"><div><b>'+esc(r.name)+'</b><small>'+(r.is_system?"Built-in role":"Custom role")+'</small></div>'+(d.can_manage&&!r.is_system?'<div class="row-actions"><button class="secondary edit-role" data-id="'+r.id+'">Rename</button><button class="danger-small delete-role" data-id="'+r.id+'">Delete</button></div>':'')+'</div>').join("")+'</div><p class="settings-note">Built-in @everyone and @Member roles are protected.</p>'}
if(tab==="members"){const [d,rd]=await Promise.all([api("/servers/"+serverId+"/members"),api("/servers/"+serverId+"/roles")]);serverRoles=rd.roles||[];pane.innerHTML='<div class="settings-list">'+(d.members||[]).map(mem=>'<div class="member-setting"><div class="member-setting-main"><b>'+esc(mem.username)+'</b><small>'+esc(mem.account_type)+' · '+esc(mem.status)+' · '+esc(mem.roles||"")+'</small></div>'+(d.can_manage?'<div class="member-role-control"><select class="member-role-select" data-user="'+mem.id+'">'+serverRoles.filter(r=>r.name!=="@everyone").map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join("")+'</select><button class="secondary assign-role" data-user="'+mem.id+'">Assign</button></div>':'')+'</div>').join("")+'</div>'}
if(tab==="onboarding"){const d=await api("/servers/"+serverId+"/onboarding"),c=d.config;pane.innerHTML='<form id="onboardingSettingsForm" class="settings-form"><label class="toggle-line"><input type="checkbox" name="enabled" '+(c.enabled?"checked":"")+'> Enable server onboarding</label><label>Welcome message<textarea name="welcome_text" rows="3" maxlength="1000" placeholder="Welcome to our community…">'+esc(c.welcome_text||"")+'</textarea></label><label>Server rules<textarea name="rules_text" rows="5" maxlength="3000" placeholder="Be respectful…">'+esc(c.rules_text||"")+'</textarea></label>'+(d.can_manage?'<button class="primary settings-save">Save onboarding</button>':'<p class="settings-note">Only the server owner can edit onboarding.</p>')+'</form><p class="settings-note">Members who have not completed onboarding will see this welcome and rules screen when they enter the server.</p>'}
}catch(e){pane.innerHTML='<p class="settings-error">'+esc(e.message)+'</p>'}}
function statCard(label,value){return '<div class="stat-card"><small>'+label+'</small><strong>'+Number(value||0).toLocaleString()+'</strong></div>'}
$("#serverSettingsContent").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;if(f.id==="serverOverviewForm"){try{const d=await api("/servers/"+serverId+"/settings",{method:"POST",body:JSON.stringify({name:f.name.value,icon_url:f.icon_url.value})});currentServer=d.server;$("#workspaceName").textContent=d.server.name;$("#serverSettingsSubtitle").textContent=d.server.name;toast("Server settings saved.");await loadServers()}catch(x){toast(x.message)}}
if(f.id==="createRoleForm"){try{await api("/servers/"+serverId+"/roles",{method:"POST",body:JSON.stringify({name:f.name.value})});toast("Role created.");openServerSettings("roles")}catch(x){toast(x.message)}}
if(f.id==="onboardingSettingsForm"){try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({enabled:f.enabled.checked,welcome_text:f.welcome_text.value,rules_text:f.rules_text.value})});toast("Onboarding settings saved.")}catch(x){toast(x.message)}}});
$("#serverSettingsContent").addEventListener("click",async e=>{const edit=e.target.closest(".edit-role"),del=e.target.closest(".delete-role"),assign=e.target.closest(".assign-role");if(edit){const role=serverRoles.find(r=>r.id===edit.dataset.id),name=prompt("Rename role",role?.name||"");if(!name)return;try{await api("/servers/"+serverId+"/roles/"+edit.dataset.id,{method:"POST",body:JSON.stringify({name})});toast("Role renamed.");openServerSettings("roles")}catch(x){toast(x.message)}}if(del){if(!confirm("Delete this role? Members will lose it."))return;try{await api("/servers/"+serverId+"/roles/"+del.dataset.id,{method:"DELETE"});toast("Role deleted.");openServerSettings("roles")}catch(x){toast(x.message)}}if(assign){const sel=$("#serverSettingsContent .member-role-select[data-user='"+assign.dataset.user+"']");if(!sel?.value)return;try{await api("/servers/"+serverId+"/members/"+assign.dataset.user+"/roles",{method:"POST",body:JSON.stringify({role_id:sel.value})});toast("Role assigned.");openServerSettings("members")}catch(x){toast(x.message)}}});
async function checkOnboarding(){if(!serverId)return;const d=await api("/servers/"+serverId+"/onboarding");if(!d.config.enabled||d.completed)return;$("#onboardingTitle").textContent="Welcome to "+(currentServer?.name||"the server");$("#onboardingWelcome").textContent=d.config.welcome_text||"Welcome!";$("#onboardingRules").textContent=d.config.rules_text||"Please be respectful.";$("#onboardingModal").classList.remove("hidden")}
$("#finishOnboarding").onclick=async()=>{try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({complete:true})});$("#onboardingModal").classList.add("hidden");toast("You're all set.")}catch(e){toast(e.message)}};
$("#settingsBtn").onclick=()=>{$("#modal").classList.remove("hidden");$("#usernameForm").username.value=me.username};
$("#closeModal").onclick=()=>$("#modal").classList.add("hidden");
$("#usernameForm").onsubmit=async e=>{e.preventDefault();try{const d=await api("/auth/username",{method:"POST",body:JSON.stringify({username:e.target.username.value})});me.username=d.username;$("#currentUsername").textContent=me.username;$("#userAvatar").textContent=me.username[0].toUpperCase();toast("Username updated")}catch(x){toast(x.message)}};
$("#rotateRecovery").onclick=async()=>{try{const d=await api("/auth/recovery/rotate",{method:"POST"});$("#rotatedCode").textContent=d.recovery_code;toast("New recovery code created. Save it now.")}catch(x){toast(x.message)}};
$("#logout").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};
(async()=>{try{me=(await api("/auth/me")).user;await enterApp()}catch{}})();