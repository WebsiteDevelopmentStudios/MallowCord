const API_BASE="https://mallowcord-api.wowgrayhaha.workers.dev/api";
const preloadChecks=new Map();
const PRELOAD_HIDDEN_KEY="mallowcord.preloadDiagnostics.hidden";
function preloadIsHidden(){try{return localStorage.getItem(PRELOAD_HIDDEN_KEY)==="1"}catch{return false}}
function renderPreloadShow(){
 let tab=document.getElementById("mallowPreloadShow");
 if(tab)return;
 tab=document.createElement("button");tab.id="mallowPreloadShow";tab.textContent="Preload log";
 tab.style.cssText="position:fixed;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:9000;background:#1b2633;color:white;border:1px solid #425064;border-radius:8px;padding:8px 10px;cursor:pointer";
 tab.onclick=()=>{try{localStorage.removeItem(PRELOAD_HIDDEN_KEY)}catch{}tab.remove();renderPreloadPanel()};
 document.body.append(tab);
}
function preloadCheck(name,state,detail=""){
 preloadChecks.set(name,{state,detail,time:new Date().toLocaleTimeString()});
 renderPreloadPanel();
}
function renderPreloadPanel(){
 // Diagnostics are an owner-only developer aid; never expose internal request details to members.
 if(!me||me.account_type!=="owner"){
  document.getElementById("mallowPreloadPanel")?.remove();
  document.getElementById("mallowPreloadShow")?.remove();
  return;
 }
 if(preloadIsHidden()){
  document.getElementById("mallowPreloadPanel")?.remove();
  renderPreloadShow();
  return;
 }
 document.getElementById("mallowPreloadShow")?.remove();
 let panel=document.getElementById("mallowPreloadPanel");
 if(!panel){
  panel=document.createElement("section");panel.id="mallowPreloadPanel";
  panel.style.cssText="position:fixed;right:8px;top:calc(8px + env(safe-area-inset-top));bottom:auto;z-index:9000;width:min(390px,calc(100vw - 16px));max-height:min(42dvh,360px);overflow:hidden;background:#111820;color:#e8edf4;border:1px solid #425064;border-radius:12px;box-shadow:0 12px 42px #0009;font:13px/1.45 system-ui,sans-serif";
  document.body.append(panel);
 }
 const rows=[...preloadChecks.entries()];
 const ok=rows.filter(([,v])=>v.state==="ok").length,fail=rows.filter(([,v])=>v.state==="fail").length,pending=rows.filter(([,v])=>v.state==="pending").length;
 const icon=s=>s==="ok"?"✓":s==="fail"?"✕":s==="pending"?"…":"—";
 const color=s=>s==="ok"?"#55d98a":s==="fail"?"#ff7272":s==="pending"?"#f4c66a":"#a8b2c1";
 panel.innerHTML='<header style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:#1b2633"><b style="flex:1">MallowCord preload diagnostics</b><button id="mallowPreloadHide" style="background:#344355;color:white;border:0;border-radius:6px;padding:5px 9px;cursor:pointer">Hide</button></header><div style="padding:10px 14px;border-bottom:1px solid #344355"><b style="color:'+(fail?'#ff7272':pending?'#f4c66a':'#55d98a')+'">'+(fail?fail+" failed":pending?pending+" still loading":rows.length&&ok===rows.length?"Preload checks passed":"Waiting for preload")+'</b><span style="color:#a8b2c1"> · '+ok+'/'+rows.length+' passed</span><div style="color:#a8b2c1;font-size:11px;margin-top:3px">Checks the initial app/server data requests. It does not claim every DM or message history is cached.</div></div><div style="padding:6px 14px 12px;overflow:auto;max-height:calc(min(42dvh,360px) - 115px)">'+(rows.length?rows.map(([name,v])=>'<div style="display:flex;gap:9px;padding:5px 0;border-bottom:1px solid #263342"><b style="color:'+color(v.state)+';width:14px">'+icon(v.state)+'</b><span style="flex:1;min-width:0"><b>'+esc(name)+'</b>'+(v.detail?'<div style="color:'+(v.state==="fail"?"#ff9999":"#a8b2c1")+';overflow-wrap:anywhere">'+esc(v.detail)+'</div>':"")+'</span><small style="color:#8997a8">'+esc(v.time)+'</small></div>').join(""):'No checks started yet.')+'</div>';
 panel.querySelector("#mallowPreloadHide").onclick=()=>{try{localStorage.setItem(PRELOAD_HIDDEN_KEY,"1")}catch{}panel.remove();renderPreloadShow()};
}
async function preloadRun(name,fn){
 preloadCheck(name,"pending","Loading…");
 try{const result=await fn();if(result!==false&&preloadChecks.get(name)?.state!=="fail")preloadCheck(name,"ok","Loaded successfully");return result}
 catch(error){preloadCheck(name,"fail",error?.message||String(error));throw error}
}
const $=s=>document.querySelector(s);

// Bind the settings launcher before the rest of the app initializes. Delegation
// keeps the button functional even if a later startup listener fails.
document.addEventListener("click",event=>{
 const target=event.target instanceof Element?event.target:null;if(!target)return;
 if(target.closest("#closeModal")){event.preventDefault();document.querySelector("#modal")?.classList.add("hidden");return}
 const nav=target.closest(".account-nav");
 if(nav){event.preventDefault();showAccountPage(nav.dataset.page).catch(error=>{console.error("Settings page failed:",error);const root=document.querySelector("#accountSettingsContent");if(root)root.innerHTML='<div class="settings-error">'+String(error?.message||"Could not load this settings page.")+'</div>'});return}
 const button=target.closest("#settingsBtn");
 if(!button)return;
 event.preventDefault();
 if(typeof openAccountSettings==="function")openAccountSettings().catch(error=>{
  console.error("Could not open account settings:",error);
  const modal=document.querySelector("#modal");
  const content=document.querySelector("#accountSettingsContent");
  if(modal)modal.classList.remove("hidden");
  if(content)content.innerHTML='<div class="settings-error">'+String(error?.message||"Could not open settings.")+'</div>';
 });
});
document.addEventListener("keydown",event=>{if(event.key==="Escape")document.querySelector("#modal")?.classList.add("hidden")});
const memberDirectoryCache=new Map();
let socialPeople=[],selectedAttachments=[],me=null,serverId=null,channelId=null,currentChannel=null,poll=null,currentServer=null,serverRoles=[],canManageServer=false,replyingTo=null,contextMessage=null,editingMessage=null,serverEmojis=[],mentionDirectory={roles:[],users:[],channels:[]},composerMatches=[],composerMatchIndex=0,mentionDirectoryServerId=null,lastMessagesSignature="",messagesLoading=false,memberPoll=null,notificationPoll=null,notificationsLoading=false,notificationSettings={channels:new Set(),servers:new Set()};
async function api(path,opts={}){const headers={...(opts.headers||{})};const sessionToken=localStorage.getItem("mallowcord_session_token");if(sessionToken&&!Object.keys(headers).some(k=>k.toLowerCase()==="authorization"))headers.Authorization="Bearer "+sessionToken;if(!(opts.body instanceof FormData)&&!Object.keys(headers).some(k=>k.toLowerCase()==="content-type"))headers["content-type"]="application/json";const r=await fetch(API_BASE+path,{credentials:"include",...opts,headers});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error((d.error||"Request failed")+(d.path?" ["+d.path+"]":"")+(d.detail?" — "+d.detail:""));return d}

// OAuth handoff runs immediately after the API helper, before the rest of the UI
// initializes. This prevents unrelated UI startup errors from swallowing the login code.
(async()=>{
 const params=new URLSearchParams(location.search);
 const code=params.get("oauth_code");
 const loginError=params.get("login_error");
 if(code){
  try{
   const result=await api("/auth/exchange",{method:"POST",body:JSON.stringify({code})});
   if(result.session_token)localStorage.setItem("mallowcord_session_token",result.session_token);
   history.replaceState(null,"",location.pathname+location.hash);
   me=result.user;
   await enterApp();
  }catch(e){
   history.replaceState(null,"",location.pathname+location.hash);
   status("Sign-in failed: "+(e?.message||"Please try again."));
   console.error("MallowCord OAuth exchange failed:",e);
  }
  return;
 }
 if(loginError){
  history.replaceState(null,"",location.pathname+location.hash);
  status("Sign-in with "+(loginError==="google"?"Google":"Discord")+" failed. Please try again.");
  return;
 }
 try{me=(await api("/auth/me")).user;await enterApp()}catch{}
})();

let realtimeSocket=null,realtimeReconnectTimer=null,realtimeConnectTimer=null,realtimeRetry=1000,memberRefreshTimer=null,bridgeMessagePoll=null;
function realtimeConnected(){return typeof WebSocket!=="undefined"&&realtimeSocket?.readyState===WebSocket.OPEN}
function startRealtimeFallback(){
 if(channelId&&!poll&&!bridgeMessagePoll)poll=setInterval(()=>{if(document.visibilityState==="visible")loadMessages()},20000);
 if(activeDmId&&!dmPoll)dmPoll=setInterval(()=>{if(document.visibilityState==="visible")loadDmMessages()},20000);
 if(serverId&&!memberPoll)memberPoll=setInterval(()=>{if(document.visibilityState==="visible")loadMemberList()},60000);
 if(serverId&&!notificationPoll)notificationPoll=setInterval(()=>{if(document.visibilityState==="visible")loadNotifications()},45000);
}
function stopRealtimeFallback(){
 if(poll)clearInterval(poll);poll=null;
 if(dmPoll)clearInterval(dmPoll);dmPoll=null;
 if(memberPoll)clearInterval(memberPoll);memberPoll=null;
 if(notificationPoll)clearInterval(notificationPoll);notificationPoll=null;
}
function scheduleMemberRefresh(){if(memberRefreshTimer)clearTimeout(memberRefreshTimer);memberRefreshTimer=setTimeout(()=>{memberRefreshTimer=null;if(serverId)loadMemberList()},250)}
function connectRealtime(){
 if(!me||typeof WebSocket==="undefined"){startRealtimeFallback();return}
 if(realtimeSocket&&(realtimeSocket.readyState===WebSocket.OPEN||realtimeSocket.readyState===WebSocket.CONNECTING))return;
 try{
  const endpoint=new URL(API_BASE+"/realtime");endpoint.protocol=endpoint.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(endpoint.toString());realtimeSocket=socket;
  socket.onopen=()=>{if(socket!==realtimeSocket)return;if(realtimeConnectTimer)clearTimeout(realtimeConnectTimer);realtimeConnectTimer=null;realtimeRetry=1000;stopRealtimeFallback();preloadCheck("Realtime connection","ok","WebSocket handshake completed")};
  socket.onmessage=event=>{
   let message;try{message=JSON.parse(event.data)}catch{return}
   if(message.type==="resync.required"){if(channelId)loadMessages();if(activeDmId)loadDmMessages();if(serverId)loadMemberList();loadNotifications();return}
   if(message.type?.startsWith("message.")&&message.channel_id===channelId)loadMessages();
   if(message.type==="dm.message.created"){if(message.conversation_id===activeDmId)loadDmMessages();if(!$("#socialModal").classList.contains("hidden"))loadSocial()}
   if(message.type==="notifications.updated")loadNotifications();
   if(message.type==="user.presence.updated"&&message.server_id===serverId)scheduleMemberRefresh();
   if(message.type==="server.sync.updated"&&message.server_id===serverId){loadChannels();scheduleMemberRefresh()}
  };
  socket.onerror=()=>{if(socket!==realtimeSocket)return;preloadCheck("Realtime connection","pending","WebSocket transport error; waiting for the close code");try{socket.close()}catch{}};
  realtimeConnectTimer=setTimeout(()=>{if(socket!==realtimeSocket||socket.readyState!==WebSocket.CONNECTING)return;preloadCheck("Realtime connection","pending","WebSocket handshake timed out after 10 seconds; reconnecting with polling fallback");try{socket.close()}catch{}},10000);
  socket.onclose=event=>{if(socket!==realtimeSocket)return;if(realtimeConnectTimer)clearTimeout(realtimeConnectTimer);realtimeConnectTimer=null;const reason=event.reason?": "+event.reason:"";const detail="WebSocket closed (code "+event.code+(event.wasClean?", clean":", abnormal")+")"+reason+"; reconnecting with polling fallback";preloadCheck("Realtime connection","pending",detail);realtimeSocket=null;startRealtimeFallback();if(!me)return;if(realtimeReconnectTimer)clearTimeout(realtimeReconnectTimer);realtimeReconnectTimer=setTimeout(connectRealtime,realtimeRetry);realtimeRetry=Math.min(realtimeRetry*2,30000)};
 }catch(error){console.warn("MallowCord realtime connection:",error.message);startRealtimeFallback()}
}
let presenceHeartbeatTimer=null;
async function sendPresenceHeartbeat(){
 if(!me||document.visibilityState!=="visible")return;
 try{await api("/presence/heartbeat",{method:"POST",body:"{}"})}catch(e){console.warn("Presence heartbeat:",e.message)}
}
function startPresenceHeartbeat(){
 if(presenceHeartbeatTimer)clearInterval(presenceHeartbeatTimer);
 sendPresenceHeartbeat();
 presenceHeartbeatTimer=setInterval(sendPresenceHeartbeat,60000);
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){sendPresenceHeartbeat();connectRealtime();if(channelId)loadMessages();if(activeDmId)loadDmMessages();if(serverId)loadMemberList();loadNotifications()}});

function toast(s){const t=$("#toast");t.textContent=s;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600)}
function status(s){$("#authStatus").textContent=s}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function enterApp(){preloadChecks.clear();renderPreloadPanel();try{if(!me)me=(await preloadRun("Account session",()=>api("/auth/me"))).user;$("#auth").classList.add("hidden");$("#app").classList.remove("hidden");startPresenceHeartbeat();connectRealtime();$("#currentUsername").textContent=me.username;$("#userAvatar").textContent=me.username[0].toUpperCase();$("#accountType").textContent=me.account_type==="basic"?"Basic account":"Full access";await Promise.all([preloadRun("Account profile",async()=>{const p=await api("/account/profile");accountProfile=p?.profile&&typeof p.profile==="object"?p.profile:{};applyProfile()}),preloadRun("Account preferences",async()=>{try{const s=await api("/account/preferences");accountPreferences=normalizePreferences(s?.settings??s?.preferences??s);applyPreferences()}catch(e){accountPreferences=normalizePreferences({});try{applyPreferences()}catch(applyError){console.warn("Default preference application:",applyError)}preloadCheck("Account preferences","fail",(e?.message||String(e))+" (using local defaults)");console.error("MallowCord preferences load failed:",e);return false}})]);await preloadRun("Server list and initial server data",()=>loadServers());preloadCheck("Realtime connection",realtimeConnected()?"ok":"pending",realtimeConnected()?"WebSocket connected":"Waiting for realtime socket");}catch(e){preloadCheck("App startup","fail",(e?.stack||e?.message||String(e)).slice(0,900));console.error("MallowCord app startup failed:",e);$("#auth").classList.remove("hidden");$("#app").classList.add("hidden");status("Signed in, but MallowCord could not load: "+(e?.message||"Unknown error"))}}
async function loadNotificationSettings(){try{const d=await api("/notification-settings");notificationSettings.channels=new Set((d.settings||[]).filter(x=>x.scope_type==="channel"&&x.muted).map(x=>x.scope_id));notificationSettings.servers=new Set((d.settings||[]).filter(x=>x.scope_type==="server"&&x.muted).map(x=>x.scope_id));}catch(e){preloadCheck("Notification preferences","fail",e.message);console.warn("Notification settings:",e.message);return false}return true}
async function setNotificationMuted(scope,id,muted){await api("/notification-settings",{method:"POST",body:JSON.stringify({scope_type:scope,scope_id:id,muted})});const set=scope==="channel"?notificationSettings.channels:notificationSettings.servers;if(muted)set.add(id);else set.delete(id);await loadNotifications();toast((scope==="channel"?"Channel":"Server")+(muted?" muted.":" unmuted."))}
async function clearItemNotifications(scope,id){await api("/notifications/clear",{method:"POST",body:JSON.stringify({scope_type:scope,scope_id:id})});await loadNotifications();toast("Message pings cleared.")}
function closeItemMenu(){$("#itemContextMenu")?.classList.add("hidden")}
function openItemMenu(scope,id,label,x,y){const muted=(scope==="channel"?notificationSettings.channels:notificationSettings.servers).has(id),menu=$("#itemContextMenu");menu.dataset.scope=scope;menu.dataset.id=id;menu.innerHTML='<div class="context-label">'+esc(label)+'</div><button type="button" data-action="mute">'+(muted?"Unmute":"Mute")+' '+(scope==="channel"?"channel":"server")+'</button><button type="button" data-action="clear">Clear message pings</button>';menu.classList.remove("hidden");const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";menu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px"}
async function loadNotifications(){if(notificationsLoading||!me)return;notificationsLoading=true;try{const data=await api("/notifications"),rows=data.unread||[],bc=new Map(),bs=new Map();preloadCheck("Unread notification counts","ok","Loaded successfully");for(const r of rows){bc.set(r.channel_id,(bc.get(r.channel_id)||0)+Number(r.count||0));bs.set(r.server_id,(bs.get(r.server_id)||0)+Number(r.count||0));}document.querySelectorAll("#channelList .channel").forEach(el=>{const n=bc.get(el.dataset.id)||0;let b=el.querySelector(".unread-count");if(n){if(!b){b=document.createElement("span");b.className="unread-count";el.append(b)}b.textContent=n>99?"99+":String(n);el.classList.add("has-unread")}else{b?.remove();el.classList.remove("has-unread")}});document.querySelectorAll(".servers .server-icon[data-server-id]").forEach(el=>{const n=bs.get(el.dataset.serverId)||0;let b=el.querySelector(".server-unread-count");if(n){if(!b){b=document.createElement("span");b.className="server-unread-count";el.append(b)}b.textContent=n>99?"99+":String(n)}else b?.remove()})}catch(e){preloadCheck("Unread notification counts","fail",e.message);console.warn("Notifications:",e.message)}finally{notificationsLoading=false}}
async function loadServers(){const d=await api("/servers");const list=d.servers||[];const rail=document.querySelector(".servers");rail.innerHTML='<button id="dmHomeBtn" type="button" class="server-icon dm-home-button" title="Direct Messages" aria-label="Direct Messages"><img src="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png" alt="MallowBot"></button><div class="server-divider"></div>';$("#dmHomeBtn").onclick=openSocial;for(const s of list){const b=document.createElement("button");b.type="button";b.className="server-icon"+(s.id===serverId?" active":"");b.title=s.name;b.dataset.serverId=s.id;b.textContent=(s.name||"?")[0].toUpperCase();if(s.icon_url){const im=document.createElement("img");im.src=s.icon_url;im.alt=s.name;im.onerror=()=>im.remove();b.textContent="";b.append(im)}b.onclick=()=>selectServer(s);b.addEventListener("contextmenu",e=>{e.preventDefault();openItemMenu("server",s.id,s.name,e.clientX,e.clientY)});rail.append(b)}const divider=document.createElement("div");divider.className="server-divider";rail.append(divider);const add=document.createElement("button");add.id="addServer";add.type="button";add.className="server-icon add";add.title="Create server";add.textContent="+";add.style.display="none";add.onclick=()=>toast("Server creation is temporarily disabled. Server invitations are coming soon.");rail.append(add);if(!list.length){toast("You have not joined a server yet.");return}const selected=list.find(x=>x.id===serverId)||list.find(x=>x.is_system)||list[0];await selectServer(selected)}
async function selectServer(s){$("#app").classList.remove("dm-mode");$("#socialModal").classList.add("hidden");if(memberPoll)clearInterval(memberPoll);memberPoll=null;serverId=s.id;mentionDirectoryServerId=null;lastMessagesSignature="";currentServer=s;channelId=null;if(bridgeMessagePoll)clearInterval(bridgeMessagePoll);bridgeMessagePoll=null;currentChannel=null;$("#workspaceName").textContent=s.name;$("#channelTitle").textContent="Select a channel";$("#messages").innerHTML="";$("#channelList").innerHTML="";document.querySelectorAll(".server-icon").forEach(b=>b.classList.toggle("active",b.dataset.serverId===s.id));const selectedId=serverId;for(const task of ["Server settings","Channels and channel emojis","Server members and bot accounts","Notification preferences"])preloadCheck(task,"pending","Loading…");const [meta]=await Promise.all([preloadRun("Server settings",()=>api("/servers/"+selectedId+"/settings").catch(e=>{preloadCheck("Server settings","fail",e.message);return {can_manage:false}})),preloadRun("Channels and channel emojis",()=>loadChannels()),preloadRun("Server members and bot accounts",()=>loadMemberList()),preloadRun("Notification preferences",()=>loadNotificationSettings())]);if(serverId!==selectedId)return;const failedInitial=["Server settings","Channels and channel emojis","Server members and bot accounts","Notification preferences"].filter(name=>preloadChecks.get(name)?.state==="fail");preloadCheck("Initial server preload",failedInitial.length?"fail":"ok",failedInitial.length?"Failed: "+failedInitial.join(", "):"Server settings, channels, members and notification preferences finished");canManageServer=!!meta.can_manage;$("#createChannelBtn").style.display=canManageServer?"grid":"none";loadNotifications();if(notificationPoll)clearInterval(notificationPoll);notificationPoll=null;if(!realtimeConnected())notificationPoll=setInterval(()=>{if(document.visibilityState==="visible")loadNotifications()},45000);if(!realtimeConnected())memberPoll=setInterval(()=>{if(document.visibilityState==="visible")loadMemberList()},60000);checkOnboarding().catch(e=>console.warn("Onboarding:",e))}
async function loadMemberList(){
 if(!serverId)return;
 const requestedServerId=serverId,box=$("#memberList");
 const cachedHtml=memberDirectoryCache.get(requestedServerId);
 if(cachedHtml&&serverId===requestedServerId)box.innerHTML=cachedHtml;
 try{
  const d=await api("/servers/"+requestedServerId+"/members");
  if(serverId!==requestedServerId)return;
  const members=d.members||[];
  const isBot=m=>m.is_bot===true||m.is_bot===1||m.is_bot==="1"||String(m.is_bot).toLowerCase()==="true";
  const discord=members.filter(m=>String(m.id).startsWith("discord:"));
  const discordBots=members.filter(isBot);
  const discordHumans=discord.filter(m=>!isBot(m));
  const native=members.filter(m=>!String(m.id).startsWith("discord:")&&!isBot(m));
  const hasOfficialBot=discordBots.some(m=>/mallow.?bot/i.test((m.username||"")+" "+(m.display_name||"")));
  $("#memberCountLabel").textContent="MEMBERS — "+(members.length+(hasOfficialBot?0:1));
  const roleData=m=>{try{return JSON.parse(m.roles_json||"[]")}catch{return []}},
   button=m=>{
    const label=m.display_name||m.username||"User";
    const avatar=m.avatar_url?'<img src="'+esc(m.avatar_url)+'" alt="">':esc(label[0].toUpperCase());
    const state=m.presence||"offline";
    const highest=roleData(m).sort((x,y)=>(y.position||0)-(x.position||0))[0];
    const nameColor=highest?.color&&/^#[0-9a-f]{6}$/i.test(highest.color)?highest.color:"";
    const botTag=isBot(m)?' <span class="bot-tag">BOT</span>':"";
    return '<button type="button" class="member member-profile-trigger" data-user-id="'+esc(m.id)+'"><span class="avatar status-avatar" data-status="'+esc(state)+'">'+avatar+'</span><span class="member-copy"><b'+(nameColor?' style="color:'+esc(nameColor)+'"':"")+'>'+esc(label)+botTag+'</b><small class="member-username">'+esc(m.username||"")+'</small></span></button>';
   },
   group=(name,rows)=>rows.length?'<div class="member-group-title">'+esc(name)+' <span>'+rows.length+'</span></div>'+rows.map(button).join(""):"",
   roleGroups=()=>{
    const map=new Map();
    for(const member of native){
     const rs=roleData(member).slice().sort((x,y)=>(Number(y.position)||0)-(Number(x.position)||0)),highest=rs[0];
     if(!highest){if(!map.has("@everyone"))map.set("@everyone",[]);map.get("@everyone").push(member);continue}
     if(!map.has(highest.id))map.set(highest.id,{role:highest,members:[]});
     map.get(highest.id).members.push(member);
    }
    return [...map.values()].sort((x,y)=>(y.role?.position??-1)-(x.role?.position??-1));
   };
  const roleMarkup=roleGroups().map(item=>Array.isArray(item)?group("@everyone",item):'<div class="member-group-title" style="color:'+esc(item.role.color||"#99aab5")+'">'+esc(item.role.name)+' <span>'+item.members.length+'</span></div>'+item.members.map(button).join("")).join("");
  const officialBot='<button type="button" class="member mallowbot-member member-profile-trigger" data-bot-profile="1"><span class="avatar"><img src="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png" alt="MallowBot"></span><span class="member-copy"><b>MallowBot <span class="bot-tag">BOT</span></b><small>Official MallowCord bot</small></span></button>';
  const mallowBotRecord=discordBots.find(m=>/mallow.?bot/i.test((m.username||"")+" "+(m.display_name||"")));
  const otherBots=discordBots.filter(m=>m!==mallowBotRecord);
  const botEntry=mallowBotRecord?button(mallowBotRecord):officialBot;
  const botGroup='<div class="member-group-title bot-group-title">Bots <span>'+(otherBots.length+1)+'</span></div>'+botEntry+otherBots.map(button).join("");
  box.innerHTML=roleMarkup+botGroup+group("Discord Members — online",discordHumans.filter(m=>["online","idle","dnd"].includes(m.presence)))+group("Discord Members — offline",discordHumans.filter(m=>!["online","idle","dnd"].includes(m.presence)));
  memberDirectoryCache.set(requestedServerId,box.innerHTML);return true;
 }catch(e){preloadCheck("Server members and bot accounts","fail",e.message);console.warn("Member list:",e.message);return false}
}
function renderChannelLabel(name){
 let source=String(name??""),images=[];
 const placeholder=html=>{const key="MALLOWCHANNELIMAGE"+images.length+"END";images.push(html);return key};
 const channelImage=(emojiName,url)=>{
  const image=customEmojiImage(emojiName,url);
  return image?image.replace("inline-custom-emoji","inline-custom-emoji channel-custom-emoji"):"";
 };
 const insertEmoji=(emojiName,url)=>{
  const image=channelImage(emojiName,url);
  return image?placeholder(image):null;
 };
 // Recover Discord's actual custom-emoji token, including animated emoji and HTML-escaped tokens.
 source=source.replace(/(?:&lt;|<)(a?):([A-Za-z0-9_*.-]{2,40}):(\d+)(?:&gt;|>)/gi,(all,animated,emojiName,id)=>{
  return insertEmoji(emojiName,"https://cdn.discordapp.com/emojis/"+id+(animated?".gif":".png"))||all;
 });
 // Recover legacy markdown image syntax and its CDN URL even when the name lookup is unavailable.
 source=source.replace(/(?:!?\[([^\]]*)\])\((https:\/\/cdn\.discordapp\.com\/emojis\/(\d+)\.(?:png|webp|gif)(?:\?[^\s)]*)?)\)/gi,(all,label,url,id)=>{
  const nameMatch=String(label).match(/:([^:]+):/);
  return insertEmoji(nameMatch?.[1]||"",url)||placeholder('<img class="inline-custom-emoji channel-custom-emoji" src="'+esc(url)+'" alt="Custom emoji" title="Custom emoji" loading="lazy">');
 });
 // Recover orphaned alt text left behind by older malformed renderers.
 source=source.replace(/(?:Custom emoji\s*)?["']?\s*alt\s*=\s*["']?:([^"']+):["']?\s*>?/gi,(all,emojiName)=>{
  return insertEmoji(emojiName)||all;
 });
 // Convert regular shortcodes after escaping all remaining channel-name text.
 source=esc(source).replace(/:([A-Za-z0-9_*.-]{2,40}):/g,(all,emojiName)=>{
  return insertEmoji(emojiName)||all;
 });
 return source.replace(/MALLOWCHANNELIMAGE(\d+)END/g,(all,index)=>images[Number(index)]||"");
}
async function loadChannels(){
 const [d,emojiData]=await Promise.all([
  api("/servers/"+serverId+"/channels"),
  api("/servers/"+serverId+"/emojis").catch(()=>({emojis:[]}))
 ]);
 serverEmojis=emojiData.emojis||[];
 const box=$("#channelList");box.innerHTML="";
 if(!d.channels.length){box.innerHTML='<div class="empty-state">No channels yet.</div>';mentionDirectory.channels=[];return}
 let lastCategory=null;
 const toggleSection=heading=>{
  const collapsed=heading.getAttribute("aria-expanded")!=="false";
  heading.setAttribute("aria-expanded",String(!collapsed));
  heading.classList.toggle("collapsed",collapsed);
  let node=heading.nextElementSibling;
  while(node&&!node.classList.contains("channel-category-label")){node.hidden=collapsed;node=node.nextElementSibling}
 };
 d.channels.forEach(ch=>{
  const category=ch.section_name||ch.category_name||"";
  if(category!==lastCategory&&category){
   const heading=document.createElement("button");heading.type="button";heading.className="channel-category-label";heading.setAttribute("aria-expanded","true");
   heading.innerHTML='<span class="channel-category-chevron">⌄</span><span>'+esc(category.toUpperCase())+'</span>';
   heading.addEventListener("click",()=>toggleSection(heading));box.append(heading);
  }
  lastCategory=category;
  const el=document.createElement("button");el.type="button";el.className="channel"+(ch.discord_channel_id?" discord-linked-channel":"");el.dataset.id=ch.id;
  if(ch.discord_channel_id){el.dataset.discordChannelId=ch.discord_channel_id;el.title="Synced with Discord #"+ch.name;}
  el.innerHTML='<span class="channel-kind">'+(ch.kind==="voice"?'<svg class="channel-voice-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a9 9 0 0 1 0 11"></path></svg>':"#")+'</span><span class="channel-name">'+renderChannelLabel(ch.name)+'</span>'+(ch.discord_channel_id?'<span class="discord-channel-mark" title="Linked to Discord" aria-label="Linked to Discord">D</span>':"");
  el.onclick=()=>selectChannel(ch);el.addEventListener("contextmenu",e=>{e.preventDefault();openItemMenu("channel",ch.id,"#"+ch.name,e.clientX,e.clientY)});box.append(el);
 });
 mentionDirectory.channels=d.channels||[];if(d.channels[0])selectChannel(d.channels[0]);
}
const channelDrafts=new Map();
function saveChannelDraft(id){
 const input=$("#messageForm [name=content]");
 if(!id||!input||editingMessage)return;
 const value=input.value;
 if(value)channelDrafts.set(String(id),value);else channelDrafts.delete(String(id));
}
function restoreChannelDraft(id){
 const input=$("#messageForm [name=content]");
 if(!input)return;
 input.value=channelDrafts.get(String(id))||"";
 input.placeholder="Message #"+(currentChannel?.name||"channel");
 hideComposerSuggestions();
}
function selectChannel(c){
 if(channelId&&channelId!==c.id)saveChannelDraft(channelId);
 if(bridgeMessagePoll)clearInterval(bridgeMessagePoll);bridgeMessagePoll=null;
 channelId=c.id;currentChannel=c;
 if(!editingMessage)restoreChannelDraft(c.id);
 lastMessagesSignature="";$("#channelTitle").innerHTML=renderChannelLabel(c.name);document.querySelectorAll(".channel").forEach(x=>x.classList.toggle("active",x.dataset.id===c.id));const voice=c.kind==="voice";$("#messages").classList.toggle("hidden",voice);$("#messageForm").classList.toggle("hidden",voice);$("#welcome").classList.toggle("hidden",voice);let notice=$("#voiceRoomNotice");if(!notice){notice=document.createElement("div");notice.id="voiceRoomNotice";notice.className="voice-room-notice";notice.innerHTML='<div class="voice-room-symbol">◖))</div><h2>Voice room</h2><p>This voice room is ready. Live voice calling is not connected yet.</p>';$(".chat").append(notice)}notice.classList.toggle("hidden",!voice);if(poll)clearInterval(poll);poll=null;messagesLoading=false;if(voice){channelId=null;$("#messages").innerHTML="";return}lastMessagesSignature="";loadMessages();
 // Discord-originated messages are written by the bridge, not by the browser WebSocket.
 // Keep a lightweight channel refresh active even when the socket handshake succeeds.
 bridgeMessagePoll=setInterval(()=>{if(document.visibilityState==="visible"&&channelId===c.id)loadMessages()},10000);
 if(!realtimeConnected())poll=setInterval(()=>{if(document.visibilityState==="visible")loadMessages()},20000)}
function normalizedEmojiName(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"")}
function customEmojiImage(name,fallbackUrl){
 const key=normalizedEmojiName(name),item=serverEmojis.find(x=>normalizedEmojiName(x.name)===key);
 const url=item?.image_url||(fallbackUrl&&/^https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.(?:png|webp|gif)(?:\?[^\s"'<>]*)?$/i.test(fallbackUrl)?fallbackUrl:"");
 return url?'<img class="inline-custom-emoji" src="'+esc(url)+'" alt=":'+esc(name)+':" title=":'+esc(name)+':" loading="lazy" draggable="false" oncontextmenu="return false">':"";
}
function renderMarkdown(raw){
 const tick=String.fromCharCode(96),parts=String(raw??"").split(/(\x60{3}[\s\S]*?\x60{3})/g);
 return parts.map(part=>{
  if(part.startsWith(tick.repeat(3))&&part.endsWith(tick.repeat(3))){const body=part.slice(3,-3).replace(/^[a-zA-Z0-9_-]+\n/,"");return "<pre><code>"+esc(body)+"</code></pre>"}
  let safe=esc(part),markdownImages=[];
  const placeholder=html=>{const key="MALLOWIMAGEPLACEHOLDER"+markdownImages.length+"END";markdownImages.push(html);return key};
  // Convert escaped image tags from legacy Discord/custom-emoji markup into safe inline emoji images.
  safe=safe.replace(/&lt;img\b[\s\S]*?&gt;/gi,(tag)=>{
   const src=tag.match(/\bsrc=&quot;(https:\/\/[^&]+?)&quot;/i)?.[1]?.replace(/&amp;/g,"&");
   const alt=tag.match(/\balt=&quot;:([^&]*?):&quot;/i)?.[1]||"";
   const image=customEmojiImage(alt,src);
   return image?placeholder(image):"";
  });
  // Repair malformed markdown-style image fragments, including the trailing alt attribute.
  safe=safe.replace(/(?:image)?\[([^\]]*)\]\((https:\/\/[^)\s]+)\)(?:&quot;?\s*alt=&quot;:([^"&]*?):&quot;?&gt;?)?/gi,(all,label,url,altName)=>{
   const name=altName||label.replace(/^Custom emoji$/i,"");
   const image=customEmojiImage(name,url);
   if(image)return placeholder(image);
   if(/cdn\.discordapp\.com\/emojis\/\d+\.(?:png|webp|gif)/i.test(url))return placeholder('<img class="inline-custom-emoji" src="'+esc(url)+'" alt="Custom emoji" loading="lazy" draggable="false" oncontextmenu="return false">');
   return placeholder('<a class="message-link" href="'+url+'" target="_blank" rel="noopener noreferrer">'+url+'</a>');
  });
  // Recover names left behind by old broken <img> conversions; punctuation differences are normalized.
  safe=safe.replace(/(?:Custom emoji\s*)?&quot;?\s*alt=&quot;:([^"&]*?):&quot;?\s*&gt;?/gi,(all,name)=>{
   const image=customEmojiImage(name);
   return image?placeholder(image):"";
  });
  safe=safe.replace(/:([a-zA-Z0-9_*.-]{2,40}):/g,(all,name)=>{
   const image=customEmojiImage(name);
   return image?placeholder(image):all;
  });
  safe=safe.replace(/https:\/\/[^\s<>"']+/gi,url=>{
   const clean=url.replace(/[),.!?]+$/,""),tail=url.slice(clean.length);
   if(/^https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.(?:png|webp|gif)(?:\?.*)?$/i.test(clean))
    return placeholder('<img class="inline-custom-emoji" src="'+clean+'" alt="Custom emoji" loading="lazy" draggable="false" oncontextmenu="return false">')+tail;
   if(/\.(gif|png|jpe?g|webp)(\?.*)?$/i.test(clean.toLowerCase())){
    const type=/\.gif(\?.*)?$/i.test(clean)?"gif":"image";
    return '<a class="message-link" href="'+clean+'" target="_blank" rel="noopener noreferrer">'+clean+'</a><a class="message-embed-link" href="'+clean+'" target="_blank" rel="noopener noreferrer"><img class="message-embed '+type+'-embed" src="'+clean+'" alt="'+(type==="gif"?"GIF":"Image")+'" loading="lazy"></a>'+tail;
   }
   return '<a class="message-link" href="'+clean+'" target="_blank" rel="noopener noreferrer">'+clean+'</a>'+tail;
  });
  const mentionItems=[...(mentionDirectory.roles||[]).filter(r=>r.pingable!==0).sort((x,y)=>y.name.length-x.name.length).map(r=>({name:r.name.startsWith("@")?r.name:"@"+r.name,type:"role"})),...(mentionDirectory.users||[]).sort((x,y)=>y.username.length-x.username.length).map(u=>({name:"@"+u.username,type:"user"}))];
  for(const item of mentionItems){const token=item.name;safe=safe.replace(new RegExp("(^|[^A-Za-z0-9_])("+token+")(?![A-Za-z0-9_])","gi"),(all,prefix,value)=>prefix+'<span class="mention mention-'+item.type+'">'+value+"</span>");}
  for(const ch of (mentionDirectory.channels||[]).slice().sort((x,y)=>y.name.length-x.name.length)){const token="#"+ch.name;safe=safe.replace(new RegExp("(^|\\s)("+token+")(?![A-Za-z0-9_-])","gi"),(all,prefix,value)=>prefix+'<button type="button" class="channel-mention" data-channel-id="'+esc(ch.id)+'">'+value+"</button>");}
  safe=safe.replace(/\x60([^\x60\n]+)\x60/g,"<code>$1</code>");
  safe=safe.replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>");
  safe=safe.replace(/__([^_\n]+)__/g,"<u>$1</u>");
  safe=safe.replace(/~~([^~\n]+)~~/g,"<del>$1</del>");
  safe=safe.replace(/\|\|([^|\n]+)\|\|/g,'<span class="message-spoiler">$1</span>');
  safe=safe.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,"$1<em>$2</em>");
  safe=safe.replace(/(^|[^_])_([^_\n]+)_(?!_)/g,"$1<em>$2</em>");
  return safe.split("\n").map(line=>{
   if(/^### /.test(line))return "<h3>"+line.slice(4)+"</h3>";
   if(/^## /.test(line))return "<h2>"+line.slice(3)+"</h2>";
   if(/^# /.test(line))return "<h1>"+line.slice(2)+"</h1>";
   if(/^&gt; /.test(line))return "<blockquote>"+line.slice(5)+"</blockquote>";
   if(/^[-*] /.test(line))return "<div class='md-list-line'>• "+line.slice(2)+"</div>";
   return line;
  }).join("<br>").replace(/MALLOWIMAGEPLACEHOLDER(\d+)END/g,(all,index)=>markdownImages[Number(index)]||"");
 }).join("");
}
function closeMessageMenu(){$("#messageContextMenu")?.classList.add("hidden")}
function openMessageMenu(message,x,y){
 contextMessage=message;const menu=$("#messageContextMenu");
 menu.innerHTML='<button data-action="reply">↩ Reply</button><button data-action="forward">Forward message</button><div class="context-label">Add reaction</div><div class="context-emojis">'+["👍","❤️","😂","🎉","👀","🔥","😭","💀"].map(e=>'<button data-action="react" data-emoji="'+e+'">'+e+'</button>').join("")+serverEmojis.map(e=>'<button data-action="react" data-emoji="custom:'+e.id+'" title=":'+esc(e.name)+':"><img src="'+esc(e.image_url)+'" alt="'+esc(e.name)+'"></button>').join("")+'</div>'+(message.author_id===me.id?'<button data-action="edit">✎ Edit message</button><button class="context-danger" data-action="delete">Delete message</button>':'')+'<button data-action="copy">Copy text</button><button data-action="copy-id">Copy message ID</button>';
 menu.classList.remove("hidden");const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";menu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px";
}
async function loadMessages(){
 if(!channelId||messagesLoading)return;
 messagesLoading=true;
 const requestedChannel=channelId,includeDirectory=mentionDirectoryServerId!==serverId,box=$("#messages"),distanceFromBottom=Math.max(0,box.scrollHeight-box.scrollTop-box.clientHeight),wasAtBottom=distanceFromBottom<90;
 try{
  const d=await api("/channels/"+requestedChannel+"/messages"+(includeDirectory?"?include_directory=1":""));
  if(requestedChannel!==channelId)return;
  if(d.role_mentions||d.user_mentions||d.channel_mentions){mentionDirectory={roles:d.role_mentions||[],users:d.user_mentions||[],channels:d.channel_mentions||[]};mentionDirectoryServerId=serverId;}
  const messages=d.messages||[],signature=JSON.stringify(messages);
  if(signature===lastMessagesSignature)return;
  lastMessagesSignature=signature;
  api("/notifications/read",{method:"POST",body:JSON.stringify({channel_id:requestedChannel})}).then(loadNotifications).catch(()=>{});
  const groups=[];
  for(const m of messages){
   const last=groups[groups.length-1],same=last&&last.author_id===m.author_id&&last.username===m.username&&(m.created_at-last.lastTime)<=300;
   if(same&&last.is_bot===!!m.is_bot){last.items.push(m);last.lastTime=m.created_at}else groups.push({author_id:m.author_id,username:m.username,avatar_url:m.avatar_url,role_color:m.role_color||"",is_bot:!!m.is_bot,items:[m],lastTime:m.created_at});
  }
  box.innerHTML=groups.map(g=>{
   const avatar=g.avatar_url?'<img src="'+esc(g.avatar_url)+'" alt="">':esc((g.username||"?")[0].toUpperCase());
   const entries=g.items.map(m=>{
    const reply=m.reply_to?'<div class="message-reply-preview">↪ Replying to <b>'+esc(m.reply_to.username)+'</b>: '+esc(m.reply_to.content)+'</div>':"";
    const attachments=(m.attachments||[]).map(f=>{const url=API_BASE+"/attachments/"+encodeURIComponent(f.id),image=/^image\/(png|jpeg|gif|webp|avif)$/.test(f.content_type)||/\.(png|jpe?g|gif|webp|avif)$/i.test(f.filename||"");return image?'<a class="message-attachment image-attachment" href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" alt="'+esc(f.filename)+'" loading="lazy"><span>'+esc(f.filename)+'</span></a>':'<a class="message-attachment file-attachment" href="'+url+'" target="_blank" rel="noopener"><span class="attachment-file-icon">↧</span><span><b>'+esc(f.filename)+'</b><small>'+Math.max(1,Math.round(f.size/1024))+' KB</small></span></a>'}).join("");
    const reactions=(m.reactions||[]).map(r=>'<button class="reaction-chip '+(r.mine?"mine":"")+'" data-message="'+m.id+'" data-emoji="'+esc(r.emoji)+'">'+(r.custom_url?'<img src="'+esc(r.custom_url)+'" alt="">':esc(r.emoji))+' <span>'+r.count+'</span></button>').join("");
    const time=new Date(m.created_at*1000).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
    return '<div class="message-entry '+(m.is_mentioned?'is-mentioned ':'')+(m.is_reply_to_you?'is-reply-to-you':'')+'" data-message-id="'+m.id+'">'+(m.forwarded_from?'<div class="forwarded-label">Forwarded from <b>'+esc(m.forwarded_from)+'</b></div>':"")+reply+(m.content?'<div class="message-content">'+renderMarkdown(m.content)+'</div>':"")+attachments+'<small class="message-time-inline" title="'+new Date(m.created_at*1000).toLocaleString()+'">'+time+(m.edited_at?' · edited':"")+'</small><div class="message-reactions">'+reactions+'</div></div>';
   }).join("");
   const first=g.items[0],stamp=new Date(first.created_at*1000).toLocaleString();
   return '<article class="message-group '+(g.is_bot?"bot-message-group":"")+'"><button type="button" class="avatar profile-avatar-trigger status-avatar" data-user-id="'+esc(g.author_id)+'" data-status="'+esc(g.items[0].status||"online")+'" aria-label="View '+esc(g.username)+' profile">'+avatar+'</button><div class="message-group-body"><div class="message-head"><b'+(g.role_color&&/^#[0-9a-f]{6}$/i.test(g.role_color)?' style="color:'+esc(g.role_color)+'"':"")+'>'+esc(g.username)+'</b>'+(g.is_bot?'<span class="bot-tag">BOT</span>':"")+'<small>'+stamp+'</small></div>'+entries+'</div></article>';
  }).join("");
  box.querySelectorAll(".message-entry").forEach(el=>{const m=messages.find(x=>x.id===el.dataset.messageId);if(m&&!m.is_bot)el.addEventListener("contextmenu",e=>{e.preventDefault();openMessageMenu(m,e.clientX,e.clientY)})});
  requestAnimationFrame(()=>{if(wasAtBottom){box.scrollTop=box.scrollHeight}else{box.scrollTop=Math.max(0,box.scrollHeight-box.clientHeight-distanceFromBottom)}});
 }catch(e){toast(e.message)}finally{messagesLoading=false}
}
$("#messageForm").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,input=form.querySelector('[name="content"]'),button=form.querySelector('button[type="submit"]');let value=input.value.trim();if((!value&&!selectedAttachments.length)||!channelId||form.dataset.sending==="true")return;const targetChannel=channelId,edit=editingMessage;value=expandComposerCommand(value);if(!value&&!selectedAttachments.length)return;form.dataset.sending="true";if(button){button.disabled=true;button.textContent=edit?"Saving…":"Sending…"}input.value="";hideComposerSuggestions();let sent=false;const optimistic=document.createElement("article");optimistic.className="message-group optimistic-message";optimistic.innerHTML='<span class="avatar">'+esc((me?.username||"U")[0].toUpperCase())+'</span><div class="message-group-body"><div class="message-head"><b>'+esc(me?.username||"You")+'</b><small>Sending…</small></div><div class="message-content">'+renderMarkdown(value)+'</div></div>';if(!edit&&!selectedAttachments.length&&!(value.toLowerCase().startsWith("-mb ")||value.toLowerCase().startsWith("/mb "))){$("#messages").append(optimistic);$("#messages").scrollTop=$("#messages").scrollHeight;}try{if(!edit&&!selectedAttachments.length&&/^(?:-mb|\/mb)\s+/i.test(value)){await api("/bot/command",{method:"POST",body:JSON.stringify({channel_id:targetChannel,content:value})});sent=true;clearReply();await loadMessages()}else if(edit){await api("/messages/"+edit.id+"/edit",{method:"POST",body:JSON.stringify({content:value})});sent=true;cancelMessageEdit();toast("Message edited")}else{const uploaded=[];for(const item of selectedAttachments){if(!item.id){const data=new FormData();const ext=(item.file.name.split(".").pop()||"").toLowerCase(),mimeByExt={gif:"image/gif",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",avif:"image/avif"};const uploadBlob=item.file.type&&item.file.type!=="application/octet-stream"?item.file:new Blob([item.file],{type:mimeByExt[ext]||"application/octet-stream"});data.append("file",uploadBlob,item.file.name);const result=await api("/channels/"+targetChannel+"/attachments",{method:"POST",body:data});item.id=result.attachment.id}uploaded.push(item.id)}await api("/channels/"+targetChannel+"/messages",{method:"POST",body:JSON.stringify({content:value,reply_to_id:replyingTo?.id||null,attachment_ids:uploaded})});sent=true;channelDrafts.delete(String(targetChannel));clearReply();selectedAttachments=[];renderAttachmentPreview()}optimistic.remove();await loadMessages();requestAnimationFrame(()=>{const messageBox=$("#messages");messageBox.scrollTop=messageBox.scrollHeight})}catch(x){optimistic.remove();if(!sent&&!input.value){input.value=value;if(targetChannel)channelDrafts.set(String(targetChannel),value)}toast(x.message)}finally{form.dataset.sending="false";if(button){button.disabled=false;button.textContent=editingMessage?"Save":"Send"}}};

function openForwardPicker(message){const modal=$("#forwardModal"),list=$("#forwardChannelList");if(!modal||!list){toast("Forward menu is unavailable.");return}list.innerHTML=(mentionDirectory.channels||[]).filter(c=>c.kind!=="voice").map(c=>'<button type="button" class="forward-channel-option" data-channel-id="'+esc(c.id)+'"><span>#</span>'+esc(c.name)+'</button>').join("")||'<p class="settings-note">No text channels available.</p>';modal.dataset.messageId=message.id;modal.classList.remove("hidden");closeMessageMenu()}
$("#closeForwardModal").onclick=()=>$("#forwardModal").classList.add("hidden");
$("#forwardChannelList").addEventListener("click",async e=>{const b=e.target.closest("[data-channel-id]");if(!b)return;try{await api("/messages/"+$("#forwardModal").dataset.messageId+"/forward",{method:"POST",body:JSON.stringify({target_channel_id:b.dataset.channelId})});$("#forwardModal").classList.add("hidden");toast("Message forwarded.");if(b.dataset.channelId===channelId)await loadMessages()}catch(x){toast(x.message)}});
function beginMessageEdit(m){editingMessage=m;const input=$("#messageForm [name=content]"),bar=$("#messageEditBar"),button=$("#messageForm button[type=submit]");input.value=m.content;input.placeholder="Edit message…";bar.classList.remove("hidden");button.textContent="Save";input.focus();input.setSelectionRange(input.value.length,input.value.length);closeMessageMenu()}
function cancelMessageEdit(){editingMessage=null;const input=$("#messageForm [name=content]"),bar=$("#messageEditBar"),button=$("#messageForm button[type=submit]");input.value="";input.placeholder="Message #"+(currentChannel?.name||"channel");bar.classList.add("hidden");button.textContent="Send"}
$("#cancelMessageEdit").onclick=cancelMessageEdit;
function clearReply(){replyingTo=null;$("#replyingToBar")?.classList.add("hidden")}
function beginReply(m){replyingTo=m;const bar=$("#replyingToBar");bar.innerHTML='Replying to <b>'+esc(m.username)+'</b>: '+esc(m.content.slice(0,140))+'<button type="button" id="cancelReply">×</button>';bar.classList.remove("hidden");$("#cancelReply").onclick=clearReply;$("#messageForm [name=content]").focus();closeMessageMenu()}

let activeDmId=null,activeDmUser=null,dmPoll=null;
async function loadSocial(){
 const [f,d]=await Promise.all([api("/friends"),api("/dms")]);
 const renderUser=(person,actions)=>'<div class="social-person"><button type="button" data-social-profile="'+esc(person.user_id||person.id)+'"><img class="social-user-avatar" src="'+esc(person.avatar_url||"")+'" alt=""><i class="presence-dot '+esc(person.presence||"offline")+'"></i><span>'+esc(person.display_name||person.username||"User")+'<small>@'+esc(person.username||"")+'</small></span></button><span class="social-actions">'+actions+'</span></div>';
 $("#friendRequests").innerHTML=(f.incoming||[]).map(x=>renderUser(x,'<button type="button" data-friend-action="accept" data-user-id="'+esc(x.user_id)+'">Accept</button><button type="button" data-friend-action="decline" data-user-id="'+esc(x.user_id)+'">Decline</button>')).join("")+(f.outgoing||[]).map(x=>renderUser(x,'<small>Pending</small>')).join("")||'<p class="settings-note">No pending requests.</p>';
 $("#friendList").innerHTML=(f.friends||[]).map(x=>renderUser(x,'<button type="button" data-open-dm="'+esc(x.id)+'">Message</button><button type="button" data-friend-action="remove" data-user-id="'+esc(x.id)+'">Remove</button>')).join("")||'<p class="settings-note">No friends yet.</p>';
 socialPeople=[...(f.friends||[]),...(d.conversations||[])].filter((p,i,a)=>a.findIndex(x=>String(x.user_id||x.id)===String(p.user_id||p.id))===i);$("#dmList").innerHTML=(d.conversations||[]).map(x=>'<button type="button" data-open-dm="'+esc(x.user_id)+'"><img class="social-user-avatar" src="'+esc(x.avatar_url||"")+'" alt=""><i class="presence-dot '+esc(x.presence||"offline")+'"></i><span>'+esc(x.display_name||x.username||"User")+'<small>'+esc(x.last_message||"No messages yet")+'</small></span></button>').join("")||'<p class="settings-note">No conversations yet.</p>';
}
async function openSocial(){try{$("#app").classList.add("dm-mode");$("#dmWindow").classList.remove("dm-conversation-open");$("#dmProfilePanel").classList.add("hidden");$("#socialModal").classList.remove("hidden");document.querySelectorAll(".servers .server-icon").forEach(b=>b.classList.toggle("active",b.id==="dmHomeBtn"));await loadSocial()}catch(e){toast(e.message)}}
$("#startConversationBtn").onclick=()=>$("#addFriendForm [name=username]")?.focus();
async function openDm(userId){try{stopDmTyping();if(dmTypingPoll)clearInterval(dmTypingPoll);$("#dmWindow").classList.add("dm-conversation-open");const conversationButton=Array.from(document.querySelectorAll("#dmList [data-open-dm]")).find(el=>el.dataset.openDm===String(userId));const conversationName=conversationButton?.querySelector("span")?.childNodes?.[0]?.textContent?.trim()||"Direct Message";$("#dmHeaderTitle").textContent=conversationName;const d=await api("/dms/open",{method:"POST",body:JSON.stringify({user_id:userId})});activeDmId=d.conversation.id;activeDmUser=userId;$("#dmEmpty").classList.add("hidden");await loadDmProfile(userId);$("#dmMessages").classList.remove("hidden");$("#dmForm").classList.remove("hidden");await loadDmMessages();if(dmTypingPoll)clearInterval(dmTypingPoll);dmTypingPoll=setInterval(refreshDmTyping,3000);refreshDmTyping();if(dmPoll)clearInterval(dmPoll);dmPoll=null;if(!realtimeConnected())dmPoll=setInterval(()=>{if(document.visibilityState==="visible")loadDmMessages()},20000);$("#dmForm [name=content]").focus()}catch(e){toast(e.message)}}
async function loadDmProfile(userId){
 const panel=$("#dmProfilePanel");if(!panel)return;
 const cached=socialPeople.find(p=>String(p.user_id||p.id)===String(userId))||{};
 let p={...cached};
 try{const d=await api("/users/"+encodeURIComponent(userId)+"/profile?server_id="+encodeURIComponent(serverId||""));if(d.profile)p={...p,...d.profile,roles:d.roles||[]}}catch(e){console.warn("DM profile:",e.message)}
 const name=p.display_name||p.username||"User",status=p.status||p.presence||"offline";
 $("#dmProfileAvatar").innerHTML=p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="">':esc(name[0].toUpperCase());
 $("#dmProfileName").textContent=name;$("#dmProfileUsername").textContent="@"+(p.username||"");
 $("#dmProfileStatus").textContent=profileStatusLabel(status);$("#dmProfileStatus").dataset.status=status;
 $("#dmProfileAbout").textContent=p.bio||p.about||"No about me has been added yet.";
 const roles=Array.isArray(p.roles)?p.roles:[];
 $("#dmProfileRoles").innerHTML=roles.map(r=>'<span class="dm-profile-role" style="--role-color:'+esc(r.color||"#9aa3af")+'">'+esc(r.name)+'</span>').join("");
 panel.classList.remove("hidden");
}
let dmTypingPoll=null,dmTypingLastSent=0,dmTypingIdleTimer=null,dmTypingValue="",dmTypingActive=false;
async function sendDmTyping(typing){
 if(!activeDmId)return;
 const nowMs=Date.now();if(typing&&nowMs-dmTypingLastSent<3000)return;
 dmTypingLastSent=nowMs;dmTypingActive=typing;
 try{await api("/dms/"+activeDmId+"/typing",{method:"POST",body:JSON.stringify({typing})})}catch(e){console.debug("DM typing:",e.message)}
}
async function refreshDmTyping(){
 if(!activeDmId)return;
 try{const d=await api("/dms/"+activeDmId+"/typing");const indicator=$("#dmTypingIndicator");if(d.typing){indicator.textContent=(d.typing.display_name||d.typing.username||"User")+" is typing…";indicator.classList.remove("hidden")}else{indicator.classList.add("hidden")}}catch(e){console.debug("DM typing refresh:",e.message)}
}
function stopDmTyping(){
 if(dmTypingIdleTimer)clearTimeout(dmTypingIdleTimer);dmTypingIdleTimer=null;
 dmTypingValue="";if(dmTypingActive)sendDmTyping(false);
}
async function loadDmMessages(){if(!activeDmId)return;try{const d=await api("/dms/"+activeDmId+"/messages"),box=$("#dmMessages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;box.innerHTML=(d.messages||[]).map(m=>'<div class="dm-message '+(m.author_id===me.id?"mine":"")+'"><small>'+esc(m.display_name||m.username)+' · '+new Date(m.created_at*1000).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+'</small>'+renderMarkdown(m.content)+'</div>').join("");if(bottom)box.scrollTop=box.scrollHeight}catch(e){console.warn("DM refresh:",e.message)}}
$("#friendsBtn").onclick=openSocial;
$("#dmBackToList").onclick=()=>{stopDmTyping();if(dmTypingPoll)clearInterval(dmTypingPoll);dmTypingPoll=null;$("#dmTypingIndicator").classList.add("hidden");$("#dmWindow").classList.remove("dm-conversation-open");activeDmId=null;if(dmPoll)clearInterval(dmPoll);dmPoll=null;$("#dmProfilePanel").classList.add("hidden")};
$("#closeSocialModal").onclick=()=>{$("#socialModal").classList.add("hidden");$("#dmWindow").classList.remove("dm-conversation-open");$("#app").classList.remove("dm-mode");if(dmPoll)clearInterval(dmPoll);dmPoll=null;activeDmId=null;document.querySelectorAll(".servers .server-icon").forEach(b=>b.classList.toggle("active",b.dataset.serverId===serverId))};
$("#dmHomeBtn")?.addEventListener("click",openSocial);
$("#addFriendForm").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;try{const d=await api("/friends/request",{method:"POST",body:JSON.stringify({username:form.username.value})});toast(d.message||"Friend request sent.");form.reset();await loadSocial()}catch(x){toast(x.message)}};
$("#dmForm [name=content]").addEventListener("input",()=>{if(!activeDmId)return;dmTypingValue=$("#dmForm [name=content]").value;if(!dmTypingValue.trim()){stopDmTyping();return}sendDmTyping(true);if(dmTypingIdleTimer)clearTimeout(dmTypingIdleTimer);dmTypingIdleTimer=setTimeout(stopDmTyping,5000)});
$("#dmForm [name=content]").addEventListener("blur",stopDmTyping);
$("#dmForm").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,input=form.elements.content,value=input.value.trim();if(!value||!activeDmId)return;const conversation=activeDmId;stopDmTyping();input.value="";const pending=document.createElement("div");pending.className="dm-message mine optimistic-message";pending.innerHTML='<small>'+esc(me?.username||"You")+' · Sending…</small>'+renderMarkdown(value);$("#dmMessages").append(pending);$("#dmMessages").scrollTop=$("#dmMessages").scrollHeight;try{await api("/dms/"+conversation+"/messages",{method:"POST",body:JSON.stringify({content:value})});pending.remove();await loadDmMessages()}catch(x){pending.remove();input.value=value;toast(x.message)}};
$("#socialModal").addEventListener("click",async e=>{const action=e.target.closest("[data-friend-action]"),dm=e.target.closest("[data-open-dm]"),profile=e.target.closest("[data-social-profile]");try{if(action){await api("/friends/"+encodeURIComponent(action.dataset.userId)+"/"+action.dataset.friendAction,{method:"POST",body:"{}"});toast("Friend list updated.");await loadSocial()}else if(dm)await openDm(dm.dataset.openDm);else if(profile){$("#socialModal").classList.add("hidden");openUserProfile(profile.dataset.socialProfile)}}catch(x){toast(x.message)}});
function profileStatusLabel(s){return({online:"Online",idle:"Away",dnd:"Do Not Disturb",invisible:"Invisible"})[s]||"Offline"}
function renderProfilePopover(p,own=false){
 const root=$("#profilePopover"),name=p.display_name||p.username||"User",status=p.status||"online",avatar=p.avatar_url?'<img class="profile-popover-avatar" src="'+esc(p.avatar_url)+'" alt="">':'<div class="profile-popover-avatar status-avatar" data-status="'+esc(status)+'">'+esc(name[0].toUpperCase())+'</div>';
 const roles=(p.roles||[]).map(r=>'<span class="profile-role-chip" style="color:'+esc(r.color||"#99aab5")+';border-color:'+esc(r.color||"#99aab5")+'">'+esc(r.name)+'</span>').join("");
 let actions="";
 if(own)actions='<div class="profile-popover-actions"><button type="button" id="profileEditButton">Edit profile</button><button type="button" id="profileStatusButton">Change status</button></div>';
 else if(p.user_id)actions='<div class="profile-popover-actions">'+(p.friend_status==="friends"?'<button type="button" id="profileMessageButton" data-user-id="'+esc(p.user_id)+'">Message</button><button type="button" id="profileRemoveFriendButton" data-user-id="'+esc(p.user_id)+'">Remove friend</button>':p.friend_status==="incoming"?'<button type="button" id="profileAcceptFriendButton" data-user-id="'+esc(p.user_id)+'">Accept request</button><button type="button" id="profileDeclineFriendButton" data-user-id="'+esc(p.user_id)+'">Decline</button>':p.friend_status==="outgoing"?'<button type="button" disabled>Request sent</button>':'<button type="button" id="profileAddFriendButton" data-username="'+esc(p.username||"")+'">Add friend</button>')+'</div>';
 root.innerHTML='<div class="profile-popover-cover"></div><div class="profile-popover-body">'+avatar+'<div class="profile-popover-name">'+esc(name)+'</div>'+(p.username?'<div class="profile-popover-username">'+esc(p.username)+'</div>':'')+(p.pronouns?'<div class="profile-popover-pronouns">'+esc(p.pronouns)+'</div>':'')+'<div class="profile-popover-status"><span class="presence-dot '+esc(status)+'"></span>'+profileStatusLabel(status)+'</div>'+(p.bio?'<div class="profile-popover-about">'+esc(p.bio)+'</div>':'')+(roles?'<div class="profile-role-list">'+roles+'</div>':'')+actions+'</div>';
 root.classList.remove("hidden");
}
async function openUserProfile(userId){
 try{
  if(!userId||userId==="undefined")throw Error("This profile is unavailable.");
  if(userId===me.id){if(!accountProfile||!Object.keys(accountProfile).length){const d=await api("/account/profile");accountProfile=d.profile||{}}renderProfilePopover({...accountProfile,username:me.username},true);return}
  const d=await api("/users/"+encodeURIComponent(userId)+"/profile?server_id="+encodeURIComponent(serverId||""));if(!d.profile)throw Error("This profile is unavailable.");renderProfilePopover({...d.profile,roles:d.roles||[],friend_status:d.friend_status||"none",user_id:userId},false);
 }catch(e){toast(e.message)}
}

$("#profilePopover").addEventListener("click",async e=>{if(e.target.closest("#profileEditButton")){$("#profilePopover").classList.add("hidden");openAccountSettings()}if(e.target.closest("#profileStatusButton")){$("#profilePopover").classList.add("hidden");openAccountSettings();setTimeout(()=>showAccountPage("account-info"),0)}const add=e.target.closest("#profileAddFriendButton"),accept=e.target.closest("#profileAcceptFriendButton"),decline=e.target.closest("#profileDeclineFriendButton"),remove=e.target.closest("#profileRemoveFriendButton"),message=e.target.closest("#profileMessageButton");try{if(add){await api("/friends/request",{method:"POST",body:JSON.stringify({username:add.dataset.username})});toast("Friend request sent.");$("#profilePopover").classList.add("hidden")}if(accept){await api("/friends/"+accept.dataset.userId+"/accept",{method:"POST",body:"{}"});toast("Friend request accepted.");openUserProfile(accept.dataset.userId)}if(decline){await api("/friends/"+decline.dataset.userId+"/decline",{method:"POST",body:"{}"});toast("Friend request declined.");$("#profilePopover").classList.add("hidden")}if(remove){await api("/friends/"+remove.dataset.userId+"/remove",{method:"POST",body:"{}"});toast("Friend removed.");openUserProfile(remove.dataset.userId)}if(message){$("#profilePopover").classList.add("hidden");openSocial().then(()=>openDm(message.dataset.userId))}}catch(x){toast(x.message)}});
document.addEventListener("click",e=>{
 const itemAction=e.target.closest("#itemContextMenu [data-action]");if(itemAction){const menu=$("#itemContextMenu"),scope=menu.dataset.scope,id=menu.dataset.id,action=itemAction.dataset.action;closeItemMenu();if(action==="mute"){const set=scope==="channel"?notificationSettings.channels:notificationSettings.servers;setNotificationMuted(scope,id,!set.has(id)).catch(x=>toast(x.message))}else if(action==="clear")clearItemNotifications(scope,id).catch(x=>toast(x.message));return}
 if(!e.target.closest("#itemContextMenu"))closeItemMenu();
 const channelMention=e.target.closest(".channel-mention");if(channelMention){const target=(mentionDirectory.channels||[]).find(c=>c.id===channelMention.dataset.channelId);if(target)selectChannel(target);return}
 const action=e.target.closest("#messageContextMenu [data-action]");
 if(action&&contextMessage){
  const m=contextMessage,kind=action.dataset.action;closeMessageMenu();
  if(kind==="reply")beginReply(m);
  if(kind==="forward")openForwardPicker(m);
  if(kind==="copy")navigator.clipboard?.writeText(m.content).then(()=>toast("Message copied")).catch(()=>toast("Clipboard unavailable"));
  if(kind==="copy-id")navigator.clipboard?.writeText(m.id).then(()=>toast("Message ID copied")).catch(()=>toast("Clipboard unavailable"));
  if(kind==="react")toggleReaction(m.id,action.dataset.emoji);
  if(kind==="edit")beginMessageEdit(m)
  if(kind==="delete")showCreatePanel("Delete message",'<p>Are you sure you want to delete this message?</p>',async()=>{await api("/messages/"+m.id,{method:"DELETE"});await loadMessages();toast("Message deleted.")},"Delete");
  return;
 }
 if(!e.target.closest("#messageContextMenu"))closeMessageMenu();
 const chip=e.target.closest(".reaction-chip");if(chip)toggleReaction(chip.dataset.message,chip.dataset.emoji);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeMessageMenu();closeItemMenu();clearReply();$("#profilePopover")?.classList.add("hidden")}});
document.addEventListener("click",e=>{const profile=$("#profilePopover");if(!profile||profile.classList.contains("hidden"))return;if(e.target.closest("#profilePopover")||e.target.closest("#userProfileTrigger,.member-profile-trigger,.profile-avatar-trigger"))return;profile.classList.add("hidden")});
document.addEventListener("scroll",closeMessageMenu,true);document.addEventListener("scroll",closeItemMenu,true);
document.addEventListener("click",e=>{const target=e.target.closest("#userProfileTrigger,.member-profile-trigger,.profile-avatar-trigger");if(!target)return;e.stopPropagation();if(target.id==="userProfileTrigger"){const root=$("#profilePopover");if(!root.classList.contains("hidden"))root.classList.add("hidden");else openUserProfile(me.id);}else if(target.dataset.userId)openUserProfile(target.dataset.userId);else if(target.dataset.botProfile)renderProfilePopover({username:"MallowBot",display_name:"MallowBot",avatar_url:"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",bio:"Official MallowCord bot",status:"online",pronouns:""});},{capture:true});
async function toggleReaction(id,emoji){try{await api("/messages/"+id+"/reactions",{method:"POST",body:JSON.stringify({emoji})});await loadMessages()}catch(e){toast(e.message)}}

$("#openEmojiPicker").onclick=()=>{const box=$("#emojiPicker");if(!box.classList.contains("hidden")){box.classList.add("hidden");return}box.innerHTML='<div class="emoji-picker-grid">'+["😀","😂","🥹","😍","😎","😭","💀","🔥","❤️","👍","👎","🎉","👀","🤔","🙏","✨","🚀","💯"].map(e=>'<button type="button" data-insert-emoji="'+e+'">'+e+'</button>').join("")+serverEmojis.map(e=>'<button type="button" data-insert-custom=":'+esc(e.name)+':" title=":'+esc(e.name)+':"><img src="'+esc(e.image_url)+'" alt="'+esc(e.name)+'"></button>').join("")+'</div>';box.classList.remove("hidden")};$("#emojiPicker").addEventListener("click",e=>{const b=e.target.closest("[data-insert-emoji],[data-insert-custom]");if(!b)return;const input=$("#messageForm [name=content]"),v=b.dataset.insertEmoji||b.dataset.insertCustom;input.setRangeText(v,input.selectionStart,input.selectionEnd,"end");input.focus()});document.addEventListener("click",e=>{if(!e.target.closest("#emojiPicker")&&!e.target.closest("#openEmojiPicker"))$("#emojiPicker").classList.add("hidden")});
$("#attachFilesBtn").onclick=()=>{if(editingMessage)return toast("Finish editing before attaching files.");$("#attachmentInput").click()};
$("#attachmentInput").addEventListener("change",e=>{for(const file of [...e.target.files]){if(file.size>25*1024*1024){toast(file.name+" is over the 25 MB limit.");continue}if(selectedAttachments.length>=10){toast("You can attach up to 10 files.");break}selectedAttachments.push({file,id:null})}e.target.value="";renderAttachmentPreview()});
function renderAttachmentPreview(){const root=$("#attachmentPreview");if(!root)return;root.innerHTML=selectedAttachments.map((item,i)=>'<div class="attachment-pending"><span>'+esc(item.file.name)+'</span><small>'+Math.max(1,Math.round(item.file.size/1024))+' KB</small><button type="button" data-remove-attachment="'+i+'" aria-label="Remove '+esc(item.file.name)+'">×</button></div>').join("");root.classList.toggle("hidden",!selectedAttachments.length)}
$("#attachmentPreview").addEventListener("click",e=>{const b=e.target.closest("[data-remove-attachment]");if(!b)return;selectedAttachments.splice(Number(b.dataset.removeAttachment),1);renderAttachmentPreview()});
$("#refreshBtn").onclick=loadMessages;
function hideComposerSuggestions(){const box=$("#composerSuggestions");if(box)box.classList.add("hidden");composerMatches=[];composerMatchIndex=0}
function expandComposerCommand(value){const commands={"/shrug":"¯\\_(ツ)_/¯","/tableflip":"(╯°□°）╯︵ ┻━┻","/unflip":"┬─┬ ノ( ゜-゜ノ)"};const first=value.trim().split(" ")[0].toLowerCase();if(commands[first])return commands[first]+value.slice(first.length);if(first==="/me"&&value.length>4)return "*"+me.username+" "+value.slice(4).trim()+"*";if(first==="/spoiler"&&value.length>9)return "||"+value.slice(9).trim()+"||";return value}
function activeComposerToken(input){const pos=input.selectionStart??input.value.length,left=input.value.slice(0,pos),bot=left.match(/(?:^|\s)-mb(?:\s+([^\s]*))?$/i);if(bot){const q=bot[1]||"",start=left.toLowerCase().lastIndexOf("-mb");return{trigger:"bot",query:q,start,end:pos}}const start=Math.max(left.lastIndexOf(" "),left.lastIndexOf("\n"),left.lastIndexOf("\t"))+1,word=left.slice(start);return word&&["@","#","/"].includes(word[0])?{trigger:word[0],query:word.slice(1),start,end:pos}:null}
function updateComposerSuggestions(){const input=$("#messageForm [name=content]"),box=$("#composerSuggestions"),token=activeComposerToken(input);if(!token){hideComposerSuggestions();return}let items=[];const q=token.query.toLowerCase();if(token.trigger==="/"){items=[{kind:"command",label:"/shrug",detail:"Send a shrug",insert:"/shrug "},{kind:"command",label:"/me",detail:"Action message",insert:"/me "},{kind:"command",label:"/spoiler",detail:"Hide text as a spoiler",insert:"/spoiler "},{kind:"command",label:"/tableflip",detail:"Send a table flip",insert:"/tableflip "},{kind:"command",label:"/unflip",detail:"Put the table back",insert:"/unflip "},{kind:"bot-command",label:"/mb commands",detail:"Mallow-Bot command reference",insert:"-mb commands"}].filter(x=>x.label.slice(1).toLowerCase().startsWith(q))}else if(token.trigger==="bot"){items=["help","commands","uptime","update","sync","countdown","xp","level","leaderboard","balance","daily","gamble","coinflip","slots","roulette","dice","blackjack","work","pay","rob","vibecheck","ship","fortune","wyr","purge","dm","ticket","ticket-panel","ticket-close","youtube","movie","channel","set-log","timeout-minutes","embed","snipe","sticky","backup","custom-command","vanity","premium-status"].map(name=>({kind:"bot-command",label:"-mb "+name,detail:(name==="help"||name==="commands")?"Mallow-Bot command list":"Requires a linked Discord server",insert:"-mb "+name+" "})).filter(x=>x.label.toLowerCase().includes("-mb "+q)).slice(0,16)}else if(token.trigger==="@"){items=[...(mentionDirectory.users||[]).map(u=>({kind:"user",label:"@"+u.username,detail:u.display_name||"Member",insert:"@"+u.username+" "})),...(mentionDirectory.roles||[]).filter(r=>r.pingable!==0).map(r=>({kind:"role",label:r.name.startsWith("@")?r.name:"@"+r.name,detail:"Role",insert:(r.name.startsWith("@")?r.name:"@"+r.name)+" "}))].filter(x=>x.label.slice(1).toLowerCase().includes(q)).slice(0,12)}else if(token.trigger==="#"){items=(mentionDirectory.channels||[]).filter(c=>c.kind!=="voice"&&c.name.toLowerCase().includes(q)).map(c=>({kind:"channel",label:"#"+c.name,detail:"Text channel",insert:"#"+c.name+" ",id:c.id})).slice(0,12)}composerMatches=items;composerMatchIndex=0;if(!items.length){hideComposerSuggestions();return}box.innerHTML=items.map((x,i)=>'<button type="button" class="composer-suggestion '+(i===0?"active":"")+'" data-index="'+i+'">'+(x.kind==="bot-command"?'<img class="bot-command-icon" src="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png" alt="">':'<span class="suggestion-kind">'+(x.kind==="command"?" / ":x.kind==="channel"?"#":"@")+'</span>')+'<span class="suggestion-label">'+esc(x.label)+'</span><small>'+esc(x.detail)+'</small></button>').join("");box.classList.remove("hidden")}
function chooseComposerSuggestion(index){const input=$("#messageForm [name=content]"),token=activeComposerToken(input),item=composerMatches[index];if(!token||!item)return;input.setRangeText(item.insert,token.start,token.end,"end");hideComposerSuggestions();input.focus();updateComposerSuggestions()}
$("#messageForm [name=content]").addEventListener("input",()=>{
 if(channelId&&!editingMessage){const value=$("#messageForm [name=content]").value;if(value)channelDrafts.set(String(channelId),value);else channelDrafts.delete(String(channelId))}
 updateComposerSuggestions();
});
$("#messageForm [name=content]").addEventListener("keydown",e=>{if(!composerMatches.length)return;if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();composerMatchIndex=(composerMatchIndex+(e.key==="ArrowDown"?1:-1)+composerMatches.length)%composerMatches.length;$("#composerSuggestions").querySelectorAll(".composer-suggestion").forEach((b,i)=>b.classList.toggle("active",i===composerMatchIndex))}else if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();chooseComposerSuggestion(composerMatchIndex)}else if(e.key==="Escape")hideComposerSuggestions()});
$("#composerSuggestions").addEventListener("mousedown",e=>{const b=e.target.closest("[data-index]");if(b){e.preventDefault();chooseComposerSuggestion(Number(b.dataset.index))}});

function showCreatePanel(title,fields,submitWork,actionLabel="Create"){
 let panel=$("#createPanel");
 if(!panel){panel=document.createElement("div");panel.id="createPanel";panel.className="create-panel hidden";panel.innerHTML='<section class="create-panel-card"><button type="button" class="close" id="closeCreatePanel">×</button><h2 id="createPanelTitle"></h2><form id="createPanelForm"><div id="createPanelFields"></div><div class="create-panel-actions"><button type="button" class="secondary" id="cancelCreatePanel">Cancel</button><button type="submit" class="primary">'+esc(actionLabel)+'</button></div></form></section>';document.body.append(panel);$("#closeCreatePanel").onclick=()=>panel.classList.add("hidden");$("#cancelCreatePanel").onclick=()=>panel.classList.add("hidden");}
 $("#createPanelTitle").textContent=title;$("#createPanelFields").innerHTML=fields;$("#createPanelForm").querySelector('[type="submit"]').textContent=actionLabel;panel.classList.remove("hidden");
 $("#createPanelForm").onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget).entries()),button=e.currentTarget.querySelector('[type="submit"]');button.disabled=true;try{await submitWork(data);panel.classList.add("hidden")}catch(err){toast(err.message)}finally{button.disabled=false}};
}
$("#createChannelBtn").onclick=createChannel;
async function createChannel(){
 if(!serverId)return;
 try{
  const [rd,sd]=await Promise.all([api("/servers/"+serverId+"/roles"),api("/servers/"+serverId+"/sections")]);
  const roles=rd.roles||[],sections=sd.sections||[],roleOptions=roles.filter(r=>r.name!=="@everyone").map(r=>'<option value="'+esc(r.id)+'">'+esc(r.name)+'</option>').join("");
  const sectionOptions='<option value="">No section</option>'+sections.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join("");
  showCreatePanel("Create channel",'<label>Channel name<input name="name" placeholder="announcements" minlength="2" maxlength="50" required></label><label>Channel type<select name="kind"><option value="text">Text channel</option><option value="voice">Voice channel</option></select></label><label>Server section<select name="section_id">'+sectionOptions+'</select></label><label class="toggle-line"><input type="checkbox" name="private" value="yes"> Private staff channel</label><label>Staff role<select name="staff_role_id"><option value="">Choose a role</option>'+roleOptions+'</select></label>',async data=>{
   const kind=data.kind==="voice"?"voice":"text";
   if(data.private==="yes"&&(!roles.find(r=>r.name==="@everyone")||!data.staff_role_id))throw Error("Choose a staff role to create a private channel.");
   const d=await api("/servers/"+serverId+"/channels",{method:"POST",body:JSON.stringify({name:data.name,kind,section_id:data.section_id||null})});
   if(data.private==="yes"){
    const everyone=roles.find(r=>r.name==="@everyone"),staff=data.staff_role_id;
    await api("/channels/"+d.channel.id+"/permissions",{method:"POST",body:JSON.stringify({target_type:"role",target_id:everyone.id,allow:[],deny:["view_channel"]})});
    await api("/channels/"+d.channel.id+"/permissions",{method:"POST",body:JSON.stringify({target_type:"role",target_id:staff,allow:["view_channel","send_messages","read_message_history","attach_files","embed_links"],deny:[]})});
   }
   await loadChannels();const found=(await api("/servers/"+serverId+"/channels")).channels.find(ch=>ch.id===d.channel.id);if(found)selectChannel(found);toast((data.private==="yes"?"Private staff channel":kind==="voice"?"Voice room":"Text channel")+" created.");
  });
 }catch(e){toast(e.message)}
}
async function createServer(){
 showCreatePanel("Create server",'<label>Server name<input name="name" placeholder="My server" minlength="2" maxlength="50" required></label>',async data=>{
  const d=await api("/servers",{method:"POST",body:JSON.stringify({name:data.name})});await loadServers();const all=await api("/servers"),server=all.servers.find(s=>s.id===d.server.id);if(server)await selectServer(server);toast("Server created.");
 });
}
$("#addServer").onclick=createServer;
$("#serverMenuBtn").onclick=()=>openServerSettings("overview");
$("#closeServerModal").onclick=()=>$("#serverModal").classList.add("hidden");
document.querySelectorAll(".settings-tab").forEach(b=>b.onclick=()=>openServerSettings(b.dataset.settingsTab));
async function openServerSettings(tab="overview"){if(!serverId)return;$("#serverModal").classList.remove("hidden");document.querySelectorAll(".settings-tab").forEach(b=>b.classList.toggle("active",b.dataset.settingsTab===tab));const pane=$("#serverSettingsContent");pane.innerHTML='<div class="settings-loading">Loading…</div>';$("#serverSettingsSubtitle").textContent=currentServer?.name||"Server";try{if(tab==="overview"){const d=await api("/servers/"+serverId+"/settings");const s=d.server;pane.innerHTML='<form id="serverOverviewForm" class="settings-form"><label>Server name<input name="name" maxlength="50" required value="'+esc(s.name)+'"></label><label>Server icon URL<input name="icon_url" type="url" placeholder="https://…" value="'+esc(s.icon_url||"")+'"></label><p class="settings-note">Use a direct HTTPS image URL for the server icon.</p>'+(d.can_manage?'<button class="primary settings-save">Save changes</button>':'<p class="settings-note">Only this server owner can edit server details.</p>')+'</form>'}
if(tab==="emojis"){const d=await api("/servers/"+serverId+"/emojis");pane.innerHTML=(d.can_manage?'<form id="createEmojiForm" class="inline-create emoji-create-form"><input name="name" placeholder="emoji_name" pattern="[A-Za-z0-9_]{2,32}" maxlength="32" required><input name="image_file" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><input name="image_url" type="url" placeholder="Or paste HTTPS image URL"><button class="primary">Add emoji</button></form>':'')+'<p class="settings-note">Add a direct HTTPS image URL. Type :emoji_name: in messages to use it.</p><div class="server-emoji-grid">'+(d.emojis||[]).map(e=>'<div class="server-emoji-item"><img src="'+esc(e.image_url)+'" alt=""><b>:'+esc(e.name)+':</b>'+(d.can_manage?'<button class="danger-small delete-emoji" data-id="'+e.id+'">Remove</button>':'')+'</div>').join("")+'</div>'}
if(tab==="stats"){const d=await api("/servers/"+serverId+"/stats"),s=d.stats;pane.innerHTML='<div class="stats-grid">'+statCard("Members",s.members)+statCard("Channels",s.channels)+statCard("Messages",s.messages)+statCard("Roles",s.roles)+'</div><p class="settings-note">Created '+new Date(s.created_at*1000).toLocaleString()+'</p>'}
if(tab==="sections"){const d=await api("/servers/"+serverId+"/sections");pane.innerHTML=(d.can_manage?'<form id="createSectionForm" class="inline-create"><input name="name" placeholder="New section name" minlength="2" maxlength="40" required><button class="primary">Create section</button></form>':'')+'<div class="settings-list">'+(d.sections||[]).map(x=>'<div class="settings-list-row"><div><b>'+esc(x.name)+'</b><small>Section · position '+x.position+'</small></div>'+(d.can_manage?'<div class="row-actions"><button class="secondary rename-section" data-id="'+esc(x.id)+'" data-name="'+esc(x.name)+'">Rename</button><button class="danger-small delete-section" data-id="'+esc(x.id)+'">Delete</button></div>':'')+'</div>').join('')+'</div><p class="settings-note">Choose a section when creating a channel. Deleting a section moves its channels to the uncategorized list.</p>'}
if(tab==="roles"){const d=await api("/servers/"+serverId+"/roles");serverRoles=d.roles||[];pane.innerHTML=(d.can_manage?'<form id="createRoleForm" class="inline-create"><input name="name" placeholder="New role name" minlength="2" maxlength="32" required><button class="primary">Create role</button></form>':'')+'<div class="settings-list">'+serverRoles.map(r=>'<div class="settings-list-row"><div><b style="color:'+esc(r.color||"#99aab5")+'">'+esc(r.name)+'</b><small>'+(r.is_system?"Built-in role":"Custom role")+'</small></div>'+(d.can_manage?'<div class="row-actions"><label class="role-color-setting">Color <input type="color" class="role-color-input" data-id="'+r.id+'" value="'+esc(/^#[0-9a-f]{6}$/i.test(r.color||"")?r.color:"#99aab5")+'"></label><label class="role-ping-toggle"><input type="checkbox" class="role-ping-setting" data-id="'+r.id+'" '+(r.pingable!==0?"checked":"")+ '> Allow mentions</label>'+(!r.is_system?'<button class="secondary edit-role" data-id="'+r.id+'">Rename</button><button class="danger-small delete-role" data-id="'+r.id+'">Delete</button>':'')+'</div>':'')+'</div>').join("")+'</div><p class="settings-note">Built-in @everyone and @Member roles are protected.</p>'}
if(tab==="members"){const [d,rd]=await Promise.all([api("/servers/"+serverId+"/members"),api("/servers/"+serverId+"/roles")]);serverRoles=rd.roles||[];pane.innerHTML='<div class="settings-list">'+(d.members||[]).map(mem=>'<div class="member-setting"><div class="member-setting-main"><b>'+esc(mem.username)+'</b><small>'+esc(mem.account_type)+' · '+esc(mem.status)+' · '+esc(mem.roles||"")+'</small></div>'+(d.can_manage?'<div class="member-role-control"><select class="member-role-select" data-user="'+mem.id+'">'+serverRoles.filter(r=>r.name!=="@everyone").map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join("")+'</select><button class="secondary assign-role" data-user="'+mem.id+'">Assign</button></div>':'')+'</div>').join("")+'</div>'}
if(tab==="onboarding"){const d=await api("/servers/"+serverId+"/onboarding"),c=d.config;pane.innerHTML='<form id="onboardingSettingsForm" class="settings-form"><label class="toggle-line"><input type="checkbox" name="enabled" '+(c.enabled?"checked":"")+'> Enable server onboarding</label><label>Welcome message<textarea name="welcome_text" rows="3" maxlength="1000" placeholder="Welcome to our community…">'+esc(c.welcome_text||"")+'</textarea></label><label>Server rules<textarea name="rules_text" rows="5" maxlength="3000" placeholder="Be respectful…">'+esc(c.rules_text||"")+'</textarea></label>'+(d.can_manage?'<button class="primary settings-save">Save onboarding</button>':'<p class="settings-note">Only the server owner can edit onboarding.</p>')+'</form><p class="settings-note">Members who have not completed onboarding will see this welcome and rules screen when they enter the server.</p>'}
}catch(e){pane.innerHTML='<p class="settings-error">'+esc(e.message)+'</p>'}}
function statCard(label,value){return '<div class="stat-card"><small>'+label+'</small><strong>'+Number(value||0).toLocaleString()+'</strong></div>'}
$("#serverSettingsContent").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;if(f.id==="serverOverviewForm"){try{const d=await api("/servers/"+serverId+"/settings",{method:"POST",body:JSON.stringify({name:f.name.value,icon_url:f.icon_url.value})});currentServer=d.server;$("#workspaceName").textContent=d.server.name;$("#serverSettingsSubtitle").textContent=d.server.name;toast("Server settings saved.");await loadServers()}catch(x){toast(x.message)}}
if(f.id==="createSectionForm"){try{await api("/servers/"+serverId+"/sections",{method:"POST",body:JSON.stringify({name:f.name.value})});toast("Section created.");openServerSettings("sections");await loadChannels()}catch(x){toast(x.message)}}
if(f.id==="createRoleForm"){try{await api("/servers/"+serverId+"/roles",{method:"POST",body:JSON.stringify({name:f.name.value})});toast("Role created.");openServerSettings("roles")}catch(x){toast(x.message)}}
if(f.id==="createEmojiForm"){try{let image_url=f.image_url.value.trim();const file=f.image_file.files?.[0];if(file){if(file.size>256*1024)throw Error("Emoji images must be 256 KB or smaller.");if(!["image/png","image/jpeg","image/gif","image/webp"].includes(file.type))throw Error("Use a PNG, JPG, GIF or WebP image.");image_url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error("Could not read that image."));reader.readAsDataURL(file)})}if(!image_url)throw Error("Choose an image file or paste an HTTPS image URL.");await api("/servers/"+serverId+"/emojis",{method:"POST",body:JSON.stringify({name:f.name.value,image_url})});toast("Custom emoji added.");openServerSettings("emojis")}catch(x){toast(x.message)}}
if(f.id==="onboardingSettingsForm"){try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({enabled:f.enabled.checked,welcome_text:f.welcome_text.value,rules_text:f.rules_text.value})});toast("Onboarding settings saved.")}catch(x){toast(x.message)}}});
$("#serverSettingsContent").addEventListener("change",async e=>{const color=e.target.closest(".role-color-input");if(color){color.disabled=true;try{await api("/servers/"+serverId+"/roles/"+color.dataset.id,{method:"POST",body:JSON.stringify({color:color.value})});toast("Role color updated.");await loadMemberList()}catch(x){toast(x.message)}finally{color.disabled=false}}const toggle=e.target.closest(".role-ping-setting");if(toggle){toggle.disabled=true;try{await api("/servers/"+serverId+"/roles/"+toggle.dataset.id,{method:"POST",body:JSON.stringify({pingable:toggle.checked})});toast("Role mention permission updated.");}catch(x){toggle.checked=!toggle.checked;toast(x.message)}finally{toggle.disabled=false}}});
$("#serverSettingsContent").addEventListener("click",async e=>{const emojiDel=e.target.closest(".delete-emoji");if(emojiDel){showCreatePanel("Remove custom emoji",'<p>Remove this emoji from the server?</p>',async()=>{await api("/servers/"+serverId+"/emojis/"+emojiDel.dataset.id,{method:"DELETE"});toast("Emoji removed.");openServerSettings("emojis")},"Remove")}
 const renameSection=e.target.closest(".rename-section"),deleteSection=e.target.closest(".delete-section");
 if(renameSection){showCreatePanel("Rename section",'<label>Section name<input name="name" minlength="2" maxlength="40" required value="'+esc(renameSection.dataset.name)+'"></label>',async data=>{await api("/servers/"+serverId+"/sections/"+renameSection.dataset.id,{method:"PATCH",body:JSON.stringify({name:data.name})});toast("Section renamed.");openServerSettings("sections");await loadChannels()},"Save")}
 if(deleteSection){showCreatePanel("Delete section",'<p>Channels in this section will remain in the server but become uncategorized.</p>',async()=>{await api("/servers/"+serverId+"/sections/"+deleteSection.dataset.id,{method:"DELETE"});toast("Section deleted.");openServerSettings("sections");await loadChannels()},"Delete")}
 const edit=e.target.closest(".edit-role"),del=e.target.closest(".delete-role"),assign=e.target.closest(".assign-role");if(edit){const role=serverRoles.find(r=>r.id===edit.dataset.id);showCreatePanel("Rename role",'<label>Role name<input name="name" minlength="2" maxlength="32" required value="'+esc(role?.name||"")+'"></label>',async data=>{await api("/servers/"+serverId+"/roles/"+edit.dataset.id,{method:"POST",body:JSON.stringify({name:data.name})});toast("Role renamed.");openServerSettings("roles")},"Save")}if(del)showCreatePanel("Delete role",'<p>Members will lose this role. This cannot be undone.</p>',async()=>{await api("/servers/"+serverId+"/roles/"+del.dataset.id,{method:"DELETE"});toast("Role deleted.");openServerSettings("roles")},"Delete");if(assign){const sel=$("#serverSettingsContent .member-role-select[data-user='"+assign.dataset.user+"']");if(!sel?.value)return;try{await api("/servers/"+serverId+"/members/"+assign.dataset.user+"/roles",{method:"POST",body:JSON.stringify({role_id:sel.value})});toast("Role assigned.");openServerSettings("members")}catch(x){toast(x.message)}}});
async function checkOnboarding(){if(!serverId)return;const d=await api("/servers/"+serverId+"/onboarding");if(!d.config.enabled||d.completed)return;$("#onboardingTitle").textContent="Welcome to "+(currentServer?.name||"the server");$("#onboardingWelcome").textContent=d.config.welcome_text||"Welcome!";$("#onboardingRules").textContent=d.config.rules_text||"Please be respectful.";$("#onboardingModal").classList.remove("hidden")}
$("#finishOnboarding").onclick=async()=>{try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({complete:true})});$("#onboardingModal").classList.add("hidden");toast("You're all set.")}catch(e){toast(e.message)}};

var accountProfile={},accountPreferences={},activeAccountPage="account-info";
var preferenceDefaults={
 privacy:{showOnlineStatus:true,showProfile:true,allowAnalytics:false,personalizedActivity:false},
 messaging:{allowMessagesFrom:"members",allowFriendRequests:true,readReceipts:true},
 notifications:{desktopNotifications:true,messageSounds:true,mentionsOnly:false,emailNotifications:false},
 voice:{inputMode:"voice_activity",noiseSuppression:true,echoCancellation:true,autoGainControl:true},
 appearance:{theme:"dark",compactMode:false,showAvatars:true,fontScale:"100%"},
 accessibility:{reducedMotion:false,highContrast:false,largerText:false,screenReaderLabels:true},
 system:{spellcheck:true,hardwareAcceleration:true,confirmBeforeClosing:true},
 language:{language:"English (US)",timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",dateFormat:"MM/DD/YYYY"},
 games:{showRegisteredGames:true,shareGameActivity:false},
 activity:{shareCurrentActivity:false,showRecentActivity:false},
 clips:{saveClips:false,clipQuality:"1080p"},
 overlay:{enableOverlay:false,overlayPosition:"top-right"}
};
function normalizePreferences(raw){const defaults=(typeof preferenceDefaults==="object"&&preferenceDefaults&&!Array.isArray(preferenceDefaults))?preferenceDefaults:{};const source=(raw&&typeof raw==="object"&&!Array.isArray(raw))?raw:{};const result={};for(const key of Object.keys(defaults)){const base=defaults[key]&&typeof defaults[key]==="object"&&!Array.isArray(defaults[key])?defaults[key]:{};const value=source[key]&&typeof source[key]==="object"&&!Array.isArray(source[key])?source[key]:{};result[key]=Object.assign({},base,value);}return result;}
var accountPageMeta={
 "account-info":["Account Info","Change your username, display name, profile picture and contact details."],
 "discord-link":["Discord Link","Connect your MallowCord account to your Discord identity to use Mallow-Bot commands."],
 security:["Sign-in & Security","Manage your connected sign-in and active device session."],
 status:["Account Status","Review the current standing and details of your account."],
 family:["Family Center","Family safety and supervision tools."],
 privacy:["Data & Privacy","Control profile visibility and how MallowCord uses your information."],
 messaging:["Messaging Permissions","Choose who can message you and how conversations behave."],
 notifications:["Notifications","Manage alerts, sounds and notification preferences."],
 voice:["Voice & Video","Configure voice preferences for supported voice rooms."],
 appearance:["Appearance","Customize the look and feel of MallowCord."],
 accessibility:["Accessibility","Adjust motion, contrast and reading preferences."],
 system:["System","Configure browser and application behavior."],
 language:["Language & Time","Choose your display language, timezone and date format."],
 games:["Registered Games","Manage games associated with your MallowCord account."],
 activity:["Activity Privacy","Control whether your activity is visible to others."],
 clips:["Clips","Manage game clip preferences."],
 overlay:["Game Overlay","Configure the in-game overlay when supported."],
 apps:["Connected Apps","Review third-party connections to your account."],
 "d1-usage":["D1 Usage","Monitor Cloudflare D1 account usage without querying MallowCord's database."],
 "error-logs":["Error Logs","Review server-side errors captured by the MallowCord API."]
};
async function openAccountSettings(){
 const owner=me?.account_type==="owner";$("#ownerToolsTitle").hidden=!owner;$("#ownerD1Usage").hidden=!owner;$("#ownerErrorLogs").hidden=!owner;
 $("#modal").classList.remove("hidden");
 $("#accountSettingsContent").innerHTML='<div class="settings-loading">Loading account settings…</div>';
 try{
  const [p,s]=await Promise.all([api("/account/profile"),api("/account/preferences")]);
  accountProfile=p?.profile&&typeof p.profile==="object"?p.profile:{};accountPreferences=normalizePreferences(s?.settings);
  await showAccountPage("account-info");
 }catch(e){$("#accountSettingsContent").innerHTML='<div class="settings-error">'+esc(e.message)+'</div>'}
}
function settingField(label,key,type="checkbox",options=[]){
 const value=accountPreferences[activeAccountPage]?.[key];
 if(type==="select")return '<label class="account-field">'+esc(label)+'<select data-pref="'+key+'">'+options.map(o=>'<option value="'+esc(o[0])+'" '+(String(value)===o[0]?"selected":"")+'>'+esc(o[1])+'</option>').join("")+'</select></label>';
 return '<label class="account-toggle"><span>'+esc(label)+'</span><input type="checkbox" data-pref="'+key+'" '+(value?"checked":"")+'></label>';
}
function prefPage(key,fields,note="Changes are saved to your MallowCord account."){
 return '<div class="account-panel"><p class="account-note">'+esc(note)+'</p><div class="account-fields">'+fields.join("")+'</div><button class="primary account-save" id="savePreferences">Save changes</button></div>';
}
function d1FormatNumber(value){return Math.max(0,Number(value)||0).toLocaleString("en-US")}
function d1FormatBytes(value){
 const n=Math.max(0,Number(value)||0);
 if(n<1024)return n+" B";
 if(n<1024*1024)return (n/1024).toFixed(1)+" KB";
 if(n<1024*1024*1024)return (n/1024/1024).toFixed(2)+" MB";
 return (n/1024/1024/1024).toFixed(2)+" GB";
}
function d1UsageMeter(label,used,limit,unit){
 const pct=limit>0?Math.min(100,Math.max(0,used/limit*100)):0;
 const format=value=>unit==="bytes"?d1FormatBytes(value):d1FormatNumber(value);
 return '<section class="d1-usage-card"><div class="d1-usage-heading"><b>'+esc(label)+'</b><strong>'+esc(format(used))+' <small>/ '+esc(format(limit))+'</small></strong></div><div class="d1-usage-track" role="progressbar" aria-label="'+esc(label)+'" aria-valuemin="0" aria-valuemax="'+limit+'" aria-valuenow="'+Math.min(limit,used)+'"><span style="width:'+pct.toFixed(2)+'%"></span></div><div class="d1-usage-foot"><span>'+pct.toFixed(2)+'% used</span><span>'+esc(format(Math.max(0,limit-used)))+' left</span></div></section>';
}
async function loadD1Usage(){
 const root=$("#accountSettingsContent");
 root.innerHTML='<div class="account-panel d1-usage-toolbar"><div><h3>Cloudflare D1 usage</h3><p class="account-note">Usage is fetched directly from Cloudflare GraphQL Analytics. This panel does not read or write MallowCord D1 data.</p></div><button type="button" class="secondary" id="refreshD1Usage">Refresh</button></div><div class="account-panel"><div class="settings-loading">Fetching Cloudflare analytics…</div></div>';
 const refresh=$("#refreshD1Usage");refresh.onclick=loadD1Usage;
 try{
  const d=await api("/admin/d1-usage");
  const read=Number(d.rows_read)||0,written=Number(d.rows_written)||0,storage=Number(d.storage_bytes)||0;
  const readLimit=Number(d.rows_read_limit)||5000000,writeLimit=Number(d.rows_written_limit)||100000,storageLimit=Number(d.storage_limit_bytes)||5368709120;
  root.innerHTML='<div class="account-panel d1-usage-toolbar"><div><h3>Cloudflare D1 usage</h3><p class="account-note">Account-wide usage across your D1 databases · UTC day: '+esc(d.date||"—")+'</p></div><button type="button" class="secondary" id="refreshD1Usage">Refresh</button></div><div class="d1-usage-grid">'+
   d1UsageMeter("Rows read today",read,readLimit,"rows")+
   d1UsageMeter("Rows written today",written,writeLimit,"rows")+
   d1UsageMeter("Total database storage",storage,storageLimit,"bytes")+
   '</div><div class="account-panel d1-usage-source"><p class="account-note">Storage: '+esc(d1FormatBytes(storage))+' of '+esc(d1FormatBytes(storageLimit))+' · Analytics last checked '+esc(new Date(d.fetched_at||Date.now()).toLocaleTimeString())+'.</p><p class="account-note">This panel only refreshes when opened or when you press Refresh. Analytics requests do not count as D1 queries.</p></div>';
  $("#refreshD1Usage").onclick=loadD1Usage;
 }catch(e){
  root.innerHTML='<div class="account-panel d1-usage-toolbar"><div><h3>Cloudflare D1 usage</h3><p class="account-note">Usage is retrieved from Cloudflare Analytics, not from D1.</p></div><button type="button" class="secondary" id="refreshD1Usage">Retry</button></div><div class="account-panel"><h3>Usage unavailable</h3><p class="settings-error">'+esc(e.message)+'</p><p class="account-note">The Worker needs the CF_ANALYTICS_API_TOKEN secret with Account Analytics: Read permission.</p></div>';
  $("#refreshD1Usage").onclick=loadD1Usage;
 }
}
async function loadErrorLogs(){
 const root=$("#accountSettingsContent");root.innerHTML='<div class="settings-loading">Loading error logs…</div>';
 try{
  const d=await api("/admin/errors"),rows=d.errors||[];
  root.innerHTML='<div class="account-panel error-log-toolbar"><div><h3>API error logs</h3><p class="account-note">Runtime exceptions captured by the MallowCord Worker. Request bodies, cookies and passwords are not recorded.</p></div><div class="error-log-actions"><button type="button" class="secondary" id="refreshErrorLogs">Refresh</button><button type="button" class="danger" id="clearErrorLogs" '+(rows.length?'':'disabled')+'>Clear logs</button></div></div>'+
   (rows.length?'<div class="error-log-list">'+rows.map(row=>'<article class="error-log-entry"><div class="error-log-top"><span class="error-log-method">'+esc(row.method||'UNKNOWN')+'</span><code>'+esc(row.path||'')+'</code><time>'+esc(new Date(Number(row.created_at)||0).toLocaleString())+'</time></div><p class="error-log-message">'+esc(row.message||'Unknown error')+'</p>'+(row.origin?'<p class="account-note">Origin: '+esc(row.origin)+'</p>':'')+(row.stack?'<details><summary>Stack trace</summary><pre>'+esc(row.stack)+'</pre></details>':'')+'</article>').join('')+'</div>':'<div class="account-panel"><h3>No captured errors</h3><p class="account-note">The Worker has not recorded any runtime exceptions yet. Platform-level failures that happen before the Worker runs may not appear here.</p></div>');
  $("#refreshErrorLogs").onclick=loadErrorLogs;
  $("#clearErrorLogs").onclick=()=>showCreatePanel("Clear error logs",'<p>Permanently delete all recorded error logs?</p>',async()=>{await api("/admin/errors",{method:"DELETE"});toast("Error logs cleared");await loadErrorLogs()},"Clear");
 }catch(e){root.innerHTML='<div class="account-panel"><h3>Could not load error logs</h3><p class="settings-error">'+esc(e.message)+'</p><button type="button" class="secondary" id="retryErrorLogs">Retry</button></div>';$("#retryErrorLogs").onclick=loadErrorLogs}
}
async function showAccountPage(page){
 activeAccountPage=page;document.querySelectorAll(".account-nav").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
 const meta=(accountPageMeta&&accountPageMeta[page])||["Settings","Manage your preferences."];
 $("#accountPageTitle").textContent=meta[0];$("#accountPageDescription").textContent=meta[1];
 const root=$("#accountSettingsContent");
 if(page==="discord-link"){
  const d=await api("/discord/link/status");
  root.innerHTML=d.linked?'<div class="account-panel"><h3>Discord account connected</h3><p class="account-note">Your Discord account is linked. Mallow-Bot commands will run using that Discord member and the permissions they have in Mallow Swamp.</p><p><b>Discord user ID:</b> <code>'+esc(d.discord_user_id)+'</code></p></div>':'<div class="account-panel"><h3>Connect Discord</h3><p class="account-note">This does not change your username-only MallowCord sign-in. It securely links your existing Discord account using a one-time code that expires after 10 minutes.</p><ol><li>Generate a one-time code below.</li><li>Open a private DM with Mallow Bot.</li><li>Send <code>-mb link YOUR-CODE</code> in that DM.</li><li>Return here and refresh this page to confirm the link.</li></ol><button class="primary" id="generateDiscordLink">Generate one-time code</button></div>';
  const generate=$("#generateDiscordLink");if(generate)generate.onclick=async()=>{generate.disabled=true;try{const result=await api("/discord/link/start",{method:"POST",body:"{}"});root.innerHTML='<div class="account-panel"><h3>Your one-time Discord link code</h3><p class="account-note">This code expires in 10 minutes and can only be used once. Keep it private.</p><div class="discord-link-code"><code>'+esc(result.code)+'</code></div><button class="secondary" id="copyDiscordLink">Copy code</button><p>In a private DM to Mallow Bot, send:</p><pre>-mb link '+esc(result.code)+'</pre><button class="primary" id="refreshDiscordLink">I linked Discord — refresh status</button></div>';$("#copyDiscordLink").onclick=()=>navigator.clipboard?.writeText(result.code).then(()=>toast("Code copied")).catch(()=>toast("Clipboard unavailable"));$("#refreshDiscordLink").onclick=()=>showAccountPage("discord-link")}catch(e){toast(e.message);generate.disabled=false}};
  return;
 }
 if(page==="account-info"){
  const p=accountProfile,verifiedEmail=!!p.email_verified_at,verifiedPhone=!!p.phone_verified_at;
  root.innerHTML='<div class="account-panel"><h3>Profile</h3><form id="profileSettingsForm" class="account-form"><label>Username<div class="inline-field"><input name="username" value="'+esc(me.username)+'" minlength="3" maxlength="24" pattern="[a-z]{3,24}" autocapitalize="none" spellcheck="false" required><button class="secondary" type="button" id="saveUsername">Save</button></div><small class="account-note">3–24 lowercase letters only. If the username is taken, MallowCord adds four random numbers.</small></label><label>Display name<input name="display_name" maxlength="32" value="'+esc(p.display_name||"")+'" placeholder="How others see you"></label><label>Pronouns<input name="pronouns" maxlength="32" value="'+esc(p.pronouns||"")+'" placeholder="e.g. they/them"></label><label>About me<textarea name="bio" maxlength="190" rows="3" placeholder="Tell people a little about yourself">'+esc(p.bio||"")+'</textarea></label><label>Online status<select name="status"><option value="online" '+((p.status||"online")==="online"?"selected":"")+' >Online</option><option value="idle" '+(p.status==="idle"?"selected":"")+' >Away</option><option value="dnd" '+(p.status==="dnd"?"selected":"")+' >Do not disturb</option><option value="invisible" '+(p.status==="invisible"?"selected":"")+' >Invisible</option></select></label><div class="avatar-upload-section"><label>Profile picture<input id="avatarFileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><p class="account-note">Choose an image, then drag it inside the square to reposition it. Use the zoom slider to frame the part you want.</p><div class="avatar-crop-stage hidden" id="avatarCropStage"><canvas id="avatarCropCanvas" width="320" height="320" aria-label="Profile picture crop preview"></canvas><span class="avatar-crop-hint">Drag to reposition</span></div><div class="avatar-crop-controls hidden" id="avatarCropControls"><label>Zoom <input id="avatarZoom" type="range" min="1" max="3" step="0.01" value="1"></label><button type="button" class="secondary" id="resetAvatarCrop">Reset crop</button><button type="button" class="secondary" id="clearAvatarCrop">Cancel image</button></div><div class="account-avatar-preview" id="savedAvatarPreview">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="Profile preview">':'<span>'+esc((p.display_name||me.username)[0].toUpperCase())+'</span>')+'</div><label>Or use a profile picture URL<input name="avatar_url" type="url" value="'+(String(p.avatar_url||"").startsWith("data:image/")?"":esc(p.avatar_url||""))+'" placeholder="https://example.com/avatar.png"></label></div><button class="primary">Save profile</button></form></div><div class="account-panel"><h3>Email verification</h3><span class="coming-soon">NOT AVAILABLE YET</span><p class="account-note">Email verification is temporarily unavailable.</p></div><div class="account-panel"><h3>Phone verification</h3><span class="coming-soon">NOT AVAILABLE YET</span><p class="account-note">Phone verification is temporarily unavailable.</p></div>'
  initAvatarCropper();
  $("#profileSettingsForm").onsubmit=async e=>{e.preventDefault();try{const d=new FormData(e.target),cropped=avatarCropImage?await getCroppedAvatar():null,url=String(d.get("avatar_url")||"").trim();if(cropped&&url)throw Error("Choose either your uploaded picture or a picture URL, not both.");const avatar=cropped||url||(String(accountProfile.avatar_url||"").startsWith("data:image/")?accountProfile.avatar_url:"");await api("/account/profile",{method:"POST",body:JSON.stringify({display_name:d.get("display_name"),avatar_url:avatar,bio:d.get("bio"),pronouns:d.get("pronouns"),status:d.get("status")})});accountProfile=(await api("/account/profile")).profile;avatarCropImage=null;if(avatarCropObjectUrl)URL.revokeObjectURL(avatarCropObjectUrl);avatarCropObjectUrl=null;applyProfile();toast("Profile updated");showAccountPage("account-info")}catch(x){toast(x.message)}};
  const usernameInput=$("#profileSettingsForm").elements.namedItem("username");
  usernameInput.addEventListener("input",()=>{const start=usernameInput.selectionStart;usernameInput.value=usernameInput.value.toLowerCase().replace(/[^a-z]/g,"").slice(0,24);try{usernameInput.setSelectionRange(start,start)}catch{}});
  $("#saveUsername").onclick=async()=>{
   const requested=usernameInput.value.trim().toLowerCase();
   if(!/^[a-z]{3,24}$/.test(requested)){toast("Username must be 3–24 lowercase letters.");return}
   const button=$("#saveUsername");button.disabled=true;
   try{
    let result=null,chosen=requested;
    for(let attempt=0;attempt<15;attempt++){
     try{result=await api("/auth/username",{method:"POST",body:JSON.stringify({username:chosen})});break}
     catch(error){
      if(!/taken|already|unique/i.test(error.message)||attempt===14)throw error;
      const suffix=String(Math.floor(1000+Math.random()*9000));
      chosen=requested.slice(0,20)+suffix;
     }
    }
    if(!result)throw Error("Could not find an available username. Please try again.");
    me.username=result.username;usernameInput.value=me.username;$("#currentUsername").textContent=me.username;$("#userAvatar").textContent=me.username[0].toUpperCase();
    toast(me.username!==requested?"Username was taken, so we assigned "+me.username+".":"Username updated");
   }catch(error){toast(error.message)}finally{button.disabled=false}
  };
  // Email and phone verification are intentionally unavailable until the feature is released.
 }else if(page==="security"){
  root.innerHTML='<div class="account-panel"><h3>Connected sign-in</h3><p class="account-note">MallowCord sign-in is handled by Google or Discord. Your provider password is never stored by MallowCord.</p><p class="account-note">To change your sign-in provider, sign out and continue with the other provider. Account linking will be available in a future update.</p></div><div class="account-panel"><h3>Device session</h3><p class="account-note">This device is signed in using a secure, HTTP-only session cookie.</p><button id="securityLogout" class="danger">Sign out of this device</button></div>';
  $("#securityLogout").onclick=async()=>{await api("/auth/logout",{method:"POST"});localStorage.removeItem("mallowcord_session_token");location.reload()};
 }else if(page==="status"){
  const d=await api("/account/status"),u=d.account;
  root.innerHTML='<div class="account-panel"><h3>Account standing</h3><div class="status-line"><span>Account status</span><b class="'+(u.status==="active"?"status-good":"status-warning")+'">'+esc(u.status)+'</b></div><div class="status-line"><span>Account type</span><b>'+esc(u.account_type)+'</b></div><div class="status-line"><span>Username</span><b>'+esc(u.username)+'</b></div><div class="status-line"><span>Created</span><b>'+new Date(u.created_at*1000).toLocaleDateString()+'</b></div>'+(u.timeout_until?'<div class="status-line"><span>Timeout expires</span><b>'+new Date(u.timeout_until*1000).toLocaleString()+'</b></div>':"")+'</div>';
 }else if(page==="family"){
  root.innerHTML='<div class="account-panel"><h3>Family Center</h3><span class="coming-soon">COMING SOON</span><p class="account-note">Family supervision, guardian links and teen safety controls are not available in MallowCord yet.</p></div>';
 }else if(page==="apps"){
  root.innerHTML='<div class="account-panel"><h3>Connected Apps</h3><p class="account-note">No third-party apps are currently connected to your MallowCord account.</p></div>';
 }else if(page==="d1-usage"){
  if(me?.account_type!=="owner"){root.innerHTML='<div class="account-panel"><h3>Access denied</h3><p class="account-note">Owner access is required.</p></div>';return}
  await loadD1Usage();
 }else if(page==="error-logs"){
  if(me?.account_type!=="owner"){root.innerHTML='<div class="account-panel"><h3>Access denied</h3><p class="account-note">Owner access is required.</p></div>';return}
  await loadErrorLogs();
 }else if(page==="games"){
  root.innerHTML='<div class="account-panel"><h3>Registered Games</h3><p class="account-note">Game registration is not connected yet. Game integrations will appear here when supported.</p></div>';
 }else{
  const fields=[];
  if(page==="privacy")fields.push(settingField("Show my online status","showOnlineStatus"),settingField("Show my profile to other members","showProfile"),settingField("Allow anonymous usage analytics","allowAnalytics"),settingField("Personalize activity suggestions","personalizedActivity"));
  if(page==="messaging")fields.push(settingField("Who can send me messages","allowMessagesFrom","select",[["everyone","Everyone"],["members","People in shared servers"],["none","Nobody"]]),settingField("Allow friend requests","allowFriendRequests"),settingField("Show read receipts","readReceipts"));
  if(page==="notifications")fields.push(settingField("Desktop notifications","desktopNotifications"),settingField("Message sounds","messageSounds"),settingField("Only notify me for mentions","mentionsOnly"),settingField("Email notifications","emailNotifications"));
  if(page==="voice")fields.push(settingField("Input mode","inputMode","select",[["voice_activity","Voice activity"],["push_to_talk","Push to talk"]]),settingField("Noise suppression","noiseSuppression"),settingField("Echo cancellation","echoCancellation"),settingField("Automatic gain control","autoGainControl"));
  if(page==="appearance"){fields.push(settingField("Theme","theme","select",[["dark","Dark"],["light","Light"],["darker","Darker"],["opposite","Opposite colors"],["red","Red"],["blue","Blue"],["green","Green"],["purple","Purple"],["orange","Orange"],["yellow","Yellow"]]),settingField("Compact message layout","compactMode"),settingField("Show avatars","showAvatars"),settingField("Text size","fontScale","select",[["90%","Small"],["100%","Default"],["110%","Large"],["125%","Extra large"]]));fields.push('<div class="css-theme-editor"><h3>Custom CSS</h3><p class="account-note">Import a .css file or paste CSS below. Supports HTTPS @import stylesheets, background colors, background images, fonts, and other custom CSS. Saved CSS follows your account across devices.</p><label class="css-file-label">Import CSS file<input id="cssThemeFile" type="file" accept=".css,text/css"></label><textarea id="customCssInput" rows="10" spellcheck="false" placeholder="/* Your custom MallowCord CSS */">'+esc(accountPreferences.appearance?.customCss||"")+'</textarea><div class="css-theme-actions"><button type="button" class="secondary" id="previewCustomCss">Preview CSS</button><button type="button" class="secondary" id="clearCustomCss">Clear CSS</button></div><p class="account-note">Custom CSS is applied to your account view only. Use trusted CSS.</p></div><div class="background-options"><h3>Custom Background</h3><p class="account-note">Upload a picture or paste an image URL. The background is saved to your account and follows you across devices.</p><label class="css-file-label">Upload background image<input id="backgroundImageFile" type="file" accept="image/*"></label><label>Image URL<input id="backgroundImageUrl" type="url" placeholder="https://example.com/background.jpg" value="'+esc(accountPreferences.appearance?.backgroundImage&&!String(accountPreferences.appearance.backgroundImage).startsWith("data:")?accountPreferences.appearance.backgroundImage:"")+'"></label><div class="background-toggle-row"><label><input id="backgroundEnabled" type="checkbox" '+(accountPreferences.appearance?.backgroundEnabled?"checked":"")+'> Enable custom background</label><button type="button" class="secondary" id="clearBackgroundImage">Remove image</button></div><label>Overlay darkness <input id="backgroundDim" type="range" min="0" max="85" value="'+esc(String(accountPreferences.appearance?.backgroundDim??62))+'"></label><label>Background blur <input id="backgroundBlur" type="range" min="0" max="20" value="'+esc(String(accountPreferences.appearance?.backgroundBlur??0))+'"></label><p class="account-note">Adjust the darkness and blur independently. Turn the background off at any time without deleting your image.</p></div>')}
  if(page==="accessibility")fields.push(settingField("Reduce motion","reducedMotion"),settingField("High contrast","highContrast"),settingField("Larger text","largerText"),settingField("Screen-reader labels","screenReaderLabels"));
  if(page==="system")fields.push(settingField("Spellcheck in message composer","spellcheck"),settingField("Hardware acceleration preference","hardwareAcceleration"),settingField("Confirm before closing","confirmBeforeClosing"));
  if(page==="language")fields.push(settingField("Language","language","select",[["English (US)","English (US)"],["English (UK)","English (UK)"],["Spanish","Spanish"],["French","French"],["German","German"],["Portuguese","Portuguese"]]),settingField("Timezone","timezone","select",[[Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"],["UTC","UTC"],["America/Los_Angeles","Pacific Time"],["America/Denver","Mountain Time"],["America/Chicago","Central Time"],["America/New_York","Eastern Time"],["Europe/London","London"],["Europe/Paris","Central European Time"]]),settingField("Date format","dateFormat","select",[["MM/DD/YYYY","MM/DD/YYYY"],["DD/MM/YYYY","DD/MM/YYYY"],["YYYY-MM-DD","YYYY-MM-DD"]]));
  if(page==="activity")fields.push(settingField("Share current game/activity","shareCurrentActivity"),settingField("Show recent activity on my profile","showRecentActivity"));
  if(page==="clips")fields.push(settingField("Enable clip saving","saveClips"),settingField("Clip quality","clipQuality","select",[["720p","720p"],["1080p","1080p"],["1440p","1440p"]]),'<p class="account-note">Clip capture is a planned feature; these preferences are saved for later.</p>');
  if(page==="overlay")fields.push(settingField("Enable game overlay","enableOverlay"),settingField("Overlay position","overlayPosition","select",[["top-right","Top right"],["top-left","Top left"],["bottom-right","Bottom right"],["bottom-left","Bottom left"]]),'<p class="account-note">The desktop game overlay is not available in the web app yet.</p>');
  root.innerHTML=prefPage(page,fields);
  if($("#customCssInput")){$("#cssThemeFile").onchange=async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>50000){toast("CSS file must be 50 KB or smaller.");return}$("#customCssInput").value=await file.text()};$("#previewCustomCss").onclick=()=>{try{applyCustomCss($("#customCssInput").value);toast("CSS preview applied")}catch(e){toast(e.message)}};$("#clearCustomCss").onclick=()=>{$("#customCssInput").value="";applyCustomCss("");toast("Custom CSS cleared")}}if($("#backgroundImageFile")){const syncBackground=()=>{const ap=accountPreferences.appearance||{};ap.backgroundEnabled=$("#backgroundEnabled").checked;ap.backgroundDim=$("#backgroundDim").value;ap.backgroundBlur=$("#backgroundBlur").value;ap.backgroundImage=$("#backgroundImageUrl").value.trim()||ap.backgroundImage||"";accountPreferences.appearance=ap;applyBackgroundPreferences()};$("#backgroundEnabled").onchange=syncBackground;$("#backgroundDim").oninput=syncBackground;$("#backgroundBlur").oninput=syncBackground;$("#backgroundImageUrl").onchange=syncBackground;$("#backgroundImageFile").onchange=async e=>{const file=e.target.files?.[0];if(!file)return;if(!file.type.startsWith("image/")){toast("Choose an image file.");return}try{const bitmap=await createImageBitmap(file);const scale=Math.min(1,1800/bitmap.width,1200/bitmap.height),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();let quality=.78,data=canvas.toDataURL("image/webp",quality);while(data.length>44000&&quality>.35){quality-=.08;data=canvas.toDataURL("image/webp",quality)}if(data.length>44000)throw Error("Image is too detailed to fit in saved preferences. Choose a smaller image.");$("#backgroundImageUrl").value="";accountPreferences.appearance.backgroundImage=data;applyBackgroundPreferences();toast("Background image ready. Save Appearance to keep it.")}catch(err){toast(err.message||"Could not process this image.")}};$("#clearBackgroundImage").onclick=()=>{accountPreferences.appearance.backgroundImage="";$("#backgroundImageUrl").value="";applyBackgroundPreferences();toast("Custom background cleared.")}}$("#savePreferences").onclick=async()=>{const values={...(accountPreferences[page]||{})};root.querySelectorAll("[data-pref]").forEach(el=>values[el.dataset.pref]=el.type==="checkbox"?el.checked:el.value);if(page==="appearance"){values.customCss=$("#customCssInput")?.value||"";values.backgroundEnabled=$("#backgroundEnabled")?.checked??(values.backgroundEnabled??false);values.backgroundDim=$("#backgroundDim")?.value??(values.backgroundDim??"62");values.backgroundBlur=$("#backgroundBlur")?.value??(values.backgroundBlur??"0");values.backgroundImage=$("#backgroundImageUrl")?.value.trim()||values.backgroundImage||"";}accountPreferences[page]=values;try{await api("/account/preferences",{method:"POST",body:JSON.stringify({settings:accountPreferences})});applyPreferences();toast("Settings saved across your devices")}catch(e){toast(e.message)}};
 }
 root.classList.remove("settings-page-enter");void root.offsetWidth;root.classList.add("settings-page-enter");
}

// Profile image cropper: square crop, pointer drag and zoom, exported as optimized JPEG.
let avatarCropImage=null,avatarCropZoom=1,avatarCropX=0,avatarCropY=0,avatarCropObjectUrl=null,avatarCropPointer=null;
function avatarCropLayout(){
 const stage=320,img=avatarCropImage;if(!img)return null;
 const scale=Math.max(stage/img.naturalWidth,stage/img.naturalHeight)*avatarCropZoom;
 const width=img.naturalWidth*scale,height=img.naturalHeight*scale;
 return {scale,left:(stage-width)/2+avatarCropX,top:(stage-height)/2+avatarCropY,width,height};
}
function drawAvatarCrop(){
 const canvas=$("#avatarCropCanvas");if(!canvas||!avatarCropImage)return;
 const ctx=canvas.getContext("2d"),r=avatarCropLayout();ctx.clearRect(0,0,320,320);ctx.fillStyle="#202329";ctx.fillRect(0,0,320,320);
 ctx.drawImage(avatarCropImage,r.left,r.top,r.width,r.height);
}
function initAvatarCropper(){
 const input=$("#avatarFileInput"),stage=$("#avatarCropStage"),controls=$("#avatarCropControls"),zoom=$("#avatarZoom"),canvas=$("#avatarCropCanvas");
 if(!input)return;
 input.onchange=()=>{
  const file=input.files?.[0];if(!file)return;
  if(!["image/png","image/jpeg","image/webp","image/gif"].includes(file.type)){toast("Choose a PNG, JPG, WebP or GIF image.");input.value="";return}
  if(file.size>10*1024*1024){toast("Choose an image smaller than 10 MB.");input.value="";return}
  if(avatarCropObjectUrl)URL.revokeObjectURL(avatarCropObjectUrl);
  avatarCropObjectUrl=URL.createObjectURL(file);const img=new Image();
  img.onload=()=>{avatarCropImage=img;avatarCropZoom=1;avatarCropX=0;avatarCropY=0;zoom.value="1";stage.classList.remove("hidden");controls.classList.remove("hidden");$("#savedAvatarPreview").classList.add("hidden");drawAvatarCrop()};
  img.onerror=()=>toast("That image could not be opened.");img.src=avatarCropObjectUrl;
 };
 zoom.oninput=()=>{avatarCropZoom=Number(zoom.value)||1;drawAvatarCrop()};
 $("#resetAvatarCrop").onclick=()=>{avatarCropZoom=1;avatarCropX=0;avatarCropY=0;zoom.value="1";drawAvatarCrop()};
 $("#clearAvatarCrop").onclick=()=>{avatarCropImage=null;input.value="";stage.classList.add("hidden");controls.classList.add("hidden");$("#savedAvatarPreview").classList.remove("hidden");if(avatarCropObjectUrl)URL.revokeObjectURL(avatarCropObjectUrl);avatarCropObjectUrl=null};
 const point=e=>({x:e.clientX,y:e.clientY});
 canvas.onpointerdown=e=>{if(!avatarCropImage)return;avatarCropPointer=point(e);canvas.setPointerCapture(e.pointerId);canvas.classList.add("dragging")};
 canvas.onpointermove=e=>{if(!avatarCropPointer)return;const p=point(e);const rect=canvas.getBoundingClientRect(),factor=320/rect.width,r=avatarCropLayout(),maxX=Math.max(0,(r.width-320)/2),maxY=Math.max(0,(r.height-320)/2);avatarCropX=Math.max(-maxX,Math.min(maxX,avatarCropX+(p.x-avatarCropPointer.x)*factor));avatarCropY=Math.max(-maxY,Math.min(maxY,avatarCropY+(p.y-avatarCropPointer.y)*factor));avatarCropPointer=p;drawAvatarCrop()};
 const stop=()=>{avatarCropPointer=null;canvas.classList.remove("dragging")};canvas.onpointerup=stop;canvas.onpointercancel=stop;canvas.onlostpointercapture=stop;
}
async function getCroppedAvatar(){
 if(!avatarCropImage) return null;
 const r=avatarCropLayout(),scale=r.scale,sx=Math.max(0,-r.left/scale),sy=Math.max(0,-r.top/scale),size=320/scale;
 const canvas=document.createElement("canvas");canvas.width=512;canvas.height=512;
 const ctx=canvas.getContext("2d",{alpha:false});ctx.fillStyle="#202329";ctx.fillRect(0,0,512,512);
 ctx.drawImage(avatarCropImage,sx,sy,size,size,0,0,512,512);
 let quality=.88,data=canvas.toDataURL("image/jpeg",quality);
 while(data.length>650000&&quality>.55){quality-=.07;data=canvas.toDataURL("image/jpeg",quality)}
 if(data.length>700000)throw Error("This image could not be compressed enough. Try a smaller image.");
 return data;
}

function applyProfile(){
 const name=accountProfile?.display_name||me?.username||"User";$("#currentUsername").textContent=name;
 const avatar=$("#userAvatar"),avatarUrl=accountProfile?.avatar_url||me?.avatar_url||"";avatar.textContent=avatarUrl?"":name[0].toUpperCase();if(avatarUrl){const img=document.createElement("img");img.alt="";img.referrerPolicy="no-referrer";img.decoding="async";img.src=avatarUrl;img.onerror=()=>{img.remove();avatar.textContent=name[0].toUpperCase()};avatar.append(img)}avatar.dataset.status=accountProfile?.status||"online";$("#currentUsername").dataset.status=accountProfile?.status||"online";
}
function applyCustomCss(source){
 let css=String(source||"");
 if(css.length>50000)throw Error("Custom CSS must be 50 KB or smaller.");
 const imports=[];
 css=css.replace(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^)'";\s]+))\s*\)?\s*([^;]*);/gi,(all,doubleUrl,singleUrl,bareUrl,media)=>{
  const url=doubleUrl||singleUrl||bareUrl||"";
  if(!/^https:\/\//i.test(url))throw Error("CSS imports must use an HTTPS URL.");
  if(/[\r\n<>]/.test(url))throw Error("This CSS import URL is invalid.");
  imports.push("@import url("+JSON.stringify(url)+")"+(media.trim()?" "+media.trim():"")+";");
  return "";
 });
 if(/@import/i.test(css)||/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|<\/style/i.test(css))throw Error("This CSS contains an unsupported or unsafe construct.");
 let style=document.getElementById("mallowcord-custom-css");
 if(!style){style=document.createElement("style");style.id="mallowcord-custom-css";document.head.append(style)}
 style.textContent=imports.join("\n")+(imports.length?"\n":"")+css;
}
function applyBackgroundPreferences(){const a=accountPreferences.appearance||{};const enabled=!!a.backgroundEnabled;const url=String(a.backgroundImage||"");document.documentElement.style.setProperty("--mallow-custom-background",enabled&&url?"url("+JSON.stringify(url)+")":"none");document.documentElement.style.setProperty("--mallow-background-dim",String(Math.max(0,Math.min(85,Number(a.backgroundDim??62)))/100));document.documentElement.style.setProperty("--mallow-background-blur",String(Math.max(0,Math.min(20,Number(a.backgroundBlur??0)))+"px"));document.body.classList.toggle("custom-background-enabled",enabled&&!!url)}
function applyPreferences(){const theme=accountPreferences.appearance?.theme||"dark";applyBackgroundPreferences();document.body.dataset.theme=theme;document.body.classList.toggle("reduced-motion",!!accountPreferences.accessibility?.reducedMotion);document.body.classList.toggle("high-contrast",!!accountPreferences.accessibility?.highContrast);document.documentElement.style.setProperty("--account-font-scale",accountPreferences.appearance?.fontScale||"100%");try{applyCustomCss(accountPreferences.appearance?.customCss||"")}catch(e){console.warn("Custom CSS:",e.message)}}
// Account navigation is handled by the early delegated listener.
// Settings button is handled by the early delegated listener above.

$("#closeModal").onclick=()=>$("#modal").classList.add("hidden");
$("#logout").onclick=async()=>{await api("/auth/logout",{method:"POST"});localStorage.removeItem("mallowcord_session_token");location.reload()};


// Mobile channel/member drawers. Pointer Events cover Chrome Android,
// touch laptops and modern mobile browsers with one gesture path.
(()=>{
 const app=document.querySelector("#app"),toggle=document.querySelector("#mobileChannelsToggle"),members=document.querySelector(".members");
 if(!app||!toggle||!members)return;
 let gesture=null;
 const mobile=()=>window.matchMedia("(max-width:650px)").matches;
 function setToggle(open){toggle.setAttribute("aria-expanded",String(open));toggle.setAttribute("aria-label",open?"Close channels":"Open channels")}
 function closeDrawers(){app.classList.remove("mobile-channels-open","mobile-members-open");setToggle(false);members.style.transform="";members.classList.remove("mobile-drawer-dragging")}
 function openChannels(){app.classList.remove("mobile-members-open");members.style.transform="";app.classList.add("mobile-channels-open");setToggle(true)}
 function openMembers(){app.classList.remove("mobile-channels-open");members.style.transform="";app.classList.add("mobile-members-open");setToggle(false)}
 // Use a document-level capture handler so later component listeners cannot swallow taps.
 document.addEventListener("click",e=>{
  const button=e.target instanceof Element?e.target.closest("#mobileChannelsToggle,#mobileMembersToggle"):null;
  if(!button||!mobile())return;
  e.preventDefault();e.stopImmediatePropagation();
  if(button.id==="mobileChannelsToggle"){
   if(app.classList.contains("mobile-channels-open"))closeDrawers();else openChannels();
  }else{
   if(app.classList.contains("mobile-members-open"))closeDrawers();else openMembers();
  }
 },true);
 // Touch-event fallback for browsers/webviews where Pointer Events are interrupted by scrolling.
 let touchStart=null;
 app.addEventListener("touchstart",e=>{
  if(!mobile()||e.touches.length!==1)return;
  const t=e.touches[0],target=e.target instanceof Element?e.target:null;
  const memberOpen=app.classList.contains("mobile-members-open");
  if(memberOpen?!target?.closest(".members"):!target?.closest(".chat")){touchStart=null;return}
  touchStart={x:t.clientX,y:t.clientY,memberOpen};
 },{passive:true});
 app.addEventListener("touchend",e=>{
  if(!touchStart||!mobile()||!e.changedTouches.length)return;
  const t=e.changedTouches[0],dx=t.clientX-touchStart.x,dy=t.clientY-touchStart.y,start=touchStart;touchStart=null;
  if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.25)return;
  if(start.memberOpen&&dx>0)closeDrawers();
  else if(!start.memberOpen&&dx<0)openMembers();
 },{passive:true});

 const backdrop=document.createElement("button");backdrop.type="button";backdrop.className="mobile-drawer-backdrop";backdrop.setAttribute("aria-label","Close navigation");backdrop.addEventListener("click",closeDrawers);app.append(backdrop);
 document.querySelector("#channelList")?.addEventListener("click",e=>{if(mobile()&&e.target instanceof Element&&e.target.closest(".channel"))closeDrawers()});
 document.addEventListener("keydown",e=>{if(e.key==="Escape")closeDrawers()});
 function begin(e){
  if(!mobile()||e.pointerType!=="touch"||gesture)return;
  const memberOpen=app.classList.contains("mobile-members-open"),target=e.target instanceof Element?e.target:null;
  const inMember=!!target?.closest(".members"),inChat=!!target?.closest(".chat"),fromRightEdge=e.clientX>=window.innerWidth-34;
  if(memberOpen?!inMember:(!inChat&&!fromRightEdge))return;
  gesture={id:e.pointerId,x:e.clientX,y:e.clientY,dx:0,horizontal:false,mode:memberOpen?"close":"open"};
  try{app.setPointerCapture(e.pointerId)}catch{}
 }
 function move(e){
  if(!gesture||e.pointerId!==gesture.id||!mobile())return;
  const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
  if(!gesture.horizontal&&Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.1)gesture.horizontal=true;
  if(!gesture.horizontal)return;
  if((gesture.mode==="open"&&dx>0)||(gesture.mode==="close"&&dx<0))return;
  gesture.dx=dx;const width=members.getBoundingClientRect().width||300;
  members.classList.add("mobile-drawer-dragging");
  members.style.transform=gesture.mode==="open"?"translateX("+Math.max(0,Math.min(105,105+dx/width*105))+"%)":"translateX("+Math.max(0,Math.min(width,dx))+"px)";
 }
 function finish(e){
  if(!gesture||e.pointerId!==gesture.id)return;
  const g=gesture;gesture=null;members.classList.remove("mobile-drawer-dragging");
  if(!mobile()){members.style.transform="";return}
  if(g.horizontal&&g.mode==="open"&&g.dx<-48)openMembers();
  else if(g.horizontal&&g.mode==="close"&&g.dx>48)closeDrawers();
  else members.style.transform="";
 }
 app.addEventListener("pointerdown",begin,{passive:true});app.addEventListener("pointermove",move,{passive:true});
 app.addEventListener("pointerup",finish,{passive:true});app.addEventListener("pointercancel",finish,{passive:true});
 window.addEventListener("resize",()=>{if(!mobile())closeDrawers()});
})();
