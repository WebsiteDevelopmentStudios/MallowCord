const API_BASE="https://mallowcord-api.wowgrayhaha.workers.dev/api";
const $=s=>document.querySelector(s);
let me=null,serverId=null,channelId=null,currentChannel=null,poll=null,currentServer=null,serverRoles=[],canManageServer=false,replyingTo=null,contextMessage=null,editingMessage=null,serverEmojis=[],mentionDirectory={roles:[],users:[],channels:[]},composerMatches=[],composerMatchIndex=0,mentionDirectoryServerId=null,lastMessagesSignature="",messagesLoading=false,memberPoll=null,notificationPoll=null,notificationsLoading=false,notificationSettings={channels:new Set(),servers:new Set()};
async function api(path,opts={}){const r=await fetch(API_BASE+path,{credentials:"include",headers:{"content-type":"application/json",...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error((d.error||"Request failed")+(d.path?" ["+d.path+"]":"")+(d.detail?" — "+d.detail:""));return d}
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
async function enterApp(){try{if(!me)me=(await api("/auth/me")).user;$("#auth").classList.add("hidden");$("#app").classList.remove("hidden");$("#currentUsername").textContent=me.username;$("#userAvatar").textContent=me.username[0].toUpperCase();$("#accountType").textContent=me.account_type==="basic"?"Basic account":"Full access";$("#addServer").style.display=me.account_type==="basic"?"none":"grid";await loadServers();try{const p=await api("/account/profile"),s=await api("/account/preferences");accountProfile=p.profile||{};accountPreferences={...preferenceDefaults,...s.settings};for(const k of Object.keys(preferenceDefaults))accountPreferences[k]={...preferenceDefaults[k],...(s.settings?.[k]||{})};applyProfile();applyPreferences()}catch(e){console.warn("Account preferences:",e.message)}}catch(e){$("#auth").classList.remove("hidden");$("#app").classList.add("hidden");status("Signed in, but MallowCord could not load: "+(e?.message||"Unknown error"))}}
async function loadNotificationSettings(){try{const d=await api("/notification-settings");notificationSettings.channels=new Set((d.settings||[]).filter(x=>x.scope_type==="channel"&&x.muted).map(x=>x.scope_id));notificationSettings.servers=new Set((d.settings||[]).filter(x=>x.scope_type==="server"&&x.muted).map(x=>x.scope_id));}catch(e){console.warn("Notification settings:",e.message)}}
async function setNotificationMuted(scope,id,muted){await api("/notification-settings",{method:"POST",body:JSON.stringify({scope_type:scope,scope_id:id,muted})});const set=scope==="channel"?notificationSettings.channels:notificationSettings.servers;if(muted)set.add(id);else set.delete(id);await loadNotifications();toast((scope==="channel"?"Channel":"Server")+(muted?" muted.":" unmuted."))}
async function clearItemNotifications(scope,id){await api("/notifications/clear",{method:"POST",body:JSON.stringify({scope_type:scope,scope_id:id})});await loadNotifications();toast("Message pings cleared.")}
function closeItemMenu(){$("#itemContextMenu")?.classList.add("hidden")}
function openItemMenu(scope,id,label,x,y){const muted=(scope==="channel"?notificationSettings.channels:notificationSettings.servers).has(id),menu=$("#itemContextMenu");menu.dataset.scope=scope;menu.dataset.id=id;menu.innerHTML='<div class="context-label">'+esc(label)+'</div><button type="button" data-action="mute">'+(muted?"Unmute":"Mute")+' '+(scope==="channel"?"channel":"server")+'</button><button type="button" data-action="clear">Clear message pings</button>';menu.classList.remove("hidden");const rect=menu.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";menu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px"}
async function loadNotifications(){if(notificationsLoading||!me)return;notificationsLoading=true;try{const data=await api("/notifications"),rows=data.unread||[],bc=new Map(),bs=new Map();for(const r of rows){bc.set(r.channel_id,(bc.get(r.channel_id)||0)+Number(r.count||0));bs.set(r.server_id,(bs.get(r.server_id)||0)+Number(r.count||0));}document.querySelectorAll("#channelList .channel").forEach(el=>{const n=bc.get(el.dataset.id)||0;let b=el.querySelector(".unread-count");if(n){if(!b){b=document.createElement("span");b.className="unread-count";el.append(b)}b.textContent=n>99?"99+":String(n);el.classList.add("has-unread")}else{b?.remove();el.classList.remove("has-unread")}});document.querySelectorAll(".servers .server-icon[data-server-id]").forEach(el=>{const n=bs.get(el.dataset.serverId)||0;let b=el.querySelector(".server-unread-count");if(n){if(!b){b=document.createElement("span");b.className="server-unread-count";el.append(b)}b.textContent=n>99?"99+":String(n)}else b?.remove()})}catch(e){console.warn("Notifications:",e.message)}finally{notificationsLoading=false}}
async function loadServers(){const d=await api("/servers");const list=d.servers||[];const rail=document.querySelector(".servers");rail.innerHTML="";for(const s of list){const b=document.createElement("button");b.type="button";b.className="server-icon"+(s.id===serverId?" active":"");b.title=s.name;b.dataset.serverId=s.id;b.textContent=(s.name||"?")[0].toUpperCase();if(s.icon_url){const im=document.createElement("img");im.src=s.icon_url;im.alt=s.name;im.onerror=()=>im.remove();b.textContent="";b.append(im)}b.onclick=()=>selectServer(s);b.addEventListener("contextmenu",e=>{e.preventDefault();openItemMenu("server",s.id,s.name,e.clientX,e.clientY)});rail.append(b)}const divider=document.createElement("div");divider.className="server-divider";rail.append(divider);const add=document.createElement("button");add.id="addServer";add.type="button";add.className="server-icon add";add.title="Create server";add.textContent="+";add.style.display=me.account_type==="basic"?"none":"grid";add.onclick=createServer;rail.append(add);if(!list.length){toast("You have not joined a server yet.");return}const selected=list.find(x=>x.id===serverId)||list.find(x=>x.is_system)||list[0];await selectServer(selected)}
async function selectServer(s){if(memberPoll)clearInterval(memberPoll);serverId=s.id;mentionDirectoryServerId=null;lastMessagesSignature="";currentServer=s;channelId=null;currentChannel=null;$("#workspaceName").textContent=s.name;$("#channelTitle").textContent="Select a channel";$("#messages").innerHTML="";$("#channelList").innerHTML="";document.querySelectorAll(".server-icon").forEach(b=>b.classList.toggle("active",b.dataset.serverId===s.id));try{const meta=await api("/servers/"+serverId+"/settings");canManageServer=!!meta.can_manage}catch{canManageServer=false}$("#createChannelBtn").style.display=canManageServer?"grid":"none";await Promise.all([loadChannels(),loadMemberList(),loadNotificationSettings()]);loadNotifications();if(notificationPoll)clearInterval(notificationPoll);notificationPoll=setInterval(loadNotifications,5000);memberPoll=setInterval(loadMemberList,15000);checkOnboarding().catch(e=>console.warn("Onboarding:",e))}
async function loadMemberList(){
 if(!serverId)return;
 try{
  const d=await api("/servers/"+serverId+"/members"),box=$("#memberList"),members=d.members||[];
  $("#memberCountLabel").textContent="MEMBERS — "+(members.length+1);
  box.innerHTML='<button type="button" class="member mallowbot-member member-profile-trigger" data-bot-profile="1"><span class="avatar"><img src="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png" alt="MallowBot"></span><span class="member-copy"><b>MallowBot <span class="bot-tag">BOT</span></b><small>Official MallowCord bot</small></span><span class="member-presence" data-status="online"></span></button>'+members.map(mem=>{
   const label=mem.display_name||mem.username,avatar=mem.avatar_url?'<img src="'+esc(mem.avatar_url)+'" alt="">':esc(label[0].toUpperCase());
   return '<button type="button" class="member member-profile-trigger" data-user-id="'+esc(mem.id)+'"><span class="avatar status-avatar" data-status="'+esc(mem.presence||"online")+'">'+avatar+'</span><span class="member-copy"><b>'+esc(label)+'</b><small>'+esc(mem.roles||"@everyone")+'</small></span></button>';
  }).join("");
 }catch(e){console.warn("Member list:",e.message)}
}
async function loadChannels(){
 try{const ed=await api("/servers/"+serverId+"/emojis");serverEmojis=ed.emojis||[]}catch{serverEmojis=[]}
 const d=await api("/servers/"+serverId+"/channels"),box=$("#channelList");box.innerHTML="";
 if(!d.channels.length){box.innerHTML='<div class="empty-state">No channels yet.</div>';return}
 let lastCategory=null;
 d.channels.forEach(ch=>{
  const category=ch.category_name||"";
  if(category!==lastCategory&&category){const heading=document.createElement("div");heading.className="channel-category-label";heading.innerHTML='<span class="channel-category-chevron">⌄</span><span>'+esc(category.toUpperCase())+'</span>';box.append(heading)}
  lastCategory=category;
  const el=document.createElement("button");el.type="button";el.className="channel"+(ch.discord_channel_id?" discord-linked-channel":"");el.dataset.id=ch.id;
  if(ch.discord_channel_id){el.dataset.discordChannelId=ch.discord_channel_id;el.title="Synced with Discord #"+ch.name;}
  el.innerHTML='<span class="channel-kind">'+(ch.kind==="voice"?'<svg class="channel-voice-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a9 9 0 0 1 0 11"></path></svg>':"#")+'</span><span class="channel-name">'+esc(ch.name)+'</span>'+(ch.discord_channel_id?'<span class="discord-channel-mark" title="Linked to Discord" aria-label="Linked to Discord">D</span>':"");
  el.onclick=()=>selectChannel(ch);el.addEventListener("contextmenu",e=>{e.preventDefault();openItemMenu("channel",ch.id,"#"+ch.name,e.clientX,e.clientY)});box.append(el);
 });
 mentionDirectory.channels=d.channels||[];if(d.channels[0])selectChannel(d.channels[0]);
}
function selectChannel(c){channelId=c.id;currentChannel=c;lastMessagesSignature="";$("#channelTitle").textContent=c.name;document.querySelectorAll(".channel").forEach(x=>x.classList.toggle("active",x.dataset.id===c.id));const voice=c.kind==="voice";$("#messages").classList.toggle("hidden",voice);$("#messageForm").classList.toggle("hidden",voice);$("#welcome").classList.toggle("hidden",voice);let notice=$("#voiceRoomNotice");if(!notice){notice=document.createElement("div");notice.id="voiceRoomNotice";notice.className="voice-room-notice";notice.innerHTML='<div class="voice-room-symbol">◖))</div><h2>Voice room</h2><p>This voice room is ready. Live voice calling is not connected yet.</p>';$(".chat").append(notice)}notice.classList.toggle("hidden",!voice);if(poll)clearInterval(poll);messagesLoading=false;if(voice){channelId=null;$("#messages").innerHTML="";return}loadMessages();lastMessagesSignature="";poll=setInterval(loadMessages,1500)}
function renderMarkdown(raw){
 const tick=String.fromCharCode(96),parts=String(raw??"").split(/(\x60{3}[\s\S]*?\x60{3})/g);
 return parts.map(part=>{
  if(part.startsWith(tick.repeat(3))&&part.endsWith(tick.repeat(3))){const body=part.slice(3,-3).replace(/^[a-zA-Z0-9_-]+\n/,"");return "<pre><code>"+esc(body)+"</code></pre>"}
  let safe=esc(part),markdownImages=[];
  safe=safe.replace(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/gi,(all,alt,url)=>{const key="MALLOWIMAGEPLACEHOLDER"+markdownImages.length+"END";markdownImages.push('<a class="message-embed-link" href="'+url+'" target="_blank" rel="noopener noreferrer"><img class="message-embed image-embed" src="'+url+'" alt="'+esc(alt)+'" loading="lazy"></a>');return key;});
  safe=safe.replace(/:([a-zA-Z0-9_]{2,32}):/g,(all,name)=>{const em=serverEmojis.find(x=>x.name===name);return em?'<img class="inline-custom-emoji" src="'+esc(em.image_url)+'" alt=":'+esc(name)+':">':all});
  safe=safe.replace(/https:\/\/[^\s<>"']+/gi,url=>{
   const clean=url.replace(/[),.!?]+$/,""),tail=url.slice(clean.length),lower=clean.toLowerCase();
   if(/\.(gif|png|jpe?g|webp)(\?.*)?$/i.test(lower)){
    const type=/\.gif(\?.*)?$/i.test(lower)?"gif":"image";
    return '<a class="message-embed-link" href="'+clean+'" target="_blank" rel="noopener noreferrer"><img class="message-embed '+type+'-embed" src="'+clean+'" alt="'+(type==="gif"?"GIF":"Image")+'" loading="lazy"></a>'+tail;
   }
   return '<a class="message-link" href="'+clean+'" target="_blank" rel="noopener noreferrer">'+clean+'</a>'+tail;
  });
  const mentionItems=[...(mentionDirectory.roles||[]).filter(r=>r.pingable!==0).sort((x,y)=>y.name.length-x.name.length).map(r=>({name:r.name.startsWith("@")?r.name:"@"+r.name,type:"role"})),...(mentionDirectory.users||[]).sort((x,y)=>y.username.length-x.username.length).map(u=>({name:"@"+u.username,type:"user"}))];
  for(const item of mentionItems){const token=item.name;safe=safe.replace(new RegExp("(^|[^A-Za-z0-9_])("+token+")(?![A-Za-z0-9_])","gi"),(all,prefix,value)=>prefix+'<span class="mention mention-'+item.type+'">'+value+"</span>");}
  for(const ch of (mentionDirectory.channels||[]).slice().sort((x,y)=>y.name.length-x.name.length)){const token="#"+ch.name;safe=safe.replace(new RegExp("(^|\s)("+token+")(?![A-Za-z0-9_-])","gi"),(all,prefix,value)=>prefix+'<button type="button" class="channel-mention" data-channel-id="'+esc(ch.id)+'">'+value+"</button>");}
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
 const requestedChannel=channelId,includeDirectory=mentionDirectoryServerId!==serverId;
 try{
  const d=await api("/channels/"+requestedChannel+"/messages"+(includeDirectory?"?include_directory=1":"")),box=$("#messages"),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;api("/notifications/read",{method:"POST",body:JSON.stringify({channel_id:requestedChannel})}).then(loadNotifications).catch(()=>{});
  if(requestedChannel!==channelId)return;
  if(d.role_mentions||d.user_mentions||d.channel_mentions){mentionDirectory={roles:d.role_mentions||[],users:d.user_mentions||[],channels:d.channel_mentions||[]};mentionDirectoryServerId=serverId;}
  const messages=d.messages||[],signature=JSON.stringify(messages);
  if(signature===lastMessagesSignature)return;
  lastMessagesSignature=signature;
  const groups=[];
  for(const m of messages){
   const last=groups[groups.length-1],same=last&&last.author_id===m.author_id&&last.username===m.username&&(m.created_at-last.lastTime)<=300;
   if(same&&last.is_bot===!!m.is_bot){last.items.push(m);last.lastTime=m.created_at}else groups.push({author_id:m.author_id,username:m.username,avatar_url:m.avatar_url,is_bot:!!m.is_bot,items:[m],lastTime:m.created_at});
  }
  box.innerHTML=groups.map(g=>{
   const avatar=g.avatar_url?'<img src="'+esc(g.avatar_url)+'" alt="">':esc((g.username||"?")[0].toUpperCase());
   const entries=g.items.map(m=>{
    const reply=m.reply_to?'<div class="message-reply-preview">↪ Replying to <b>'+esc(m.reply_to.username)+'</b>: '+esc(m.reply_to.content)+'</div>':"";
    const reactions=(m.reactions||[]).map(r=>'<button class="reaction-chip '+(r.mine?"mine":"")+'" data-message="'+m.id+'" data-emoji="'+esc(r.emoji)+'">'+(r.custom_url?'<img src="'+esc(r.custom_url)+'" alt="">':esc(r.emoji))+' <span>'+r.count+'</span></button>').join("");
    const time=new Date(m.created_at*1000).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});
    return '<div class="message-entry '+(m.is_mentioned?'is-mentioned ':'')+(m.is_reply_to_you?'is-reply-to-you':'')+'" data-message-id="'+m.id+'">'+(m.forwarded_from?'<div class="forwarded-label">Forwarded from <b>'+esc(m.forwarded_from)+'</b></div>':"")+reply+'<div class="message-content">'+renderMarkdown(m.content)+'</div><small class="message-time-inline" title="'+new Date(m.created_at*1000).toLocaleString()+'">'+time+(m.edited_at?' · edited':"")+'</small><div class="message-reactions">'+reactions+'</div></div>';
   }).join("");
   const first=g.items[0],stamp=new Date(first.created_at*1000).toLocaleString();
   return '<article class="message-group '+(g.is_bot?"bot-message-group":"")+'"><button type="button" class="avatar profile-avatar-trigger status-avatar" data-user-id="'+esc(g.author_id)+'" data-status="'+esc(g.items[0].status||"online")+'" aria-label="View '+esc(g.username)+' profile">'+avatar+'</button><div class="message-group-body"><div class="message-head"><b>'+esc(g.username)+'</b>'+(g.is_bot?'<span class="bot-tag">BOT</span>':"")+'<small>'+stamp+'</small></div>'+entries+'</div></article>';
  }).join("");
  box.querySelectorAll(".message-entry").forEach(el=>{const m=messages.find(x=>x.id===el.dataset.messageId);if(m&&!m.is_bot)el.addEventListener("contextmenu",e=>{e.preventDefault();openMessageMenu(m,e.clientX,e.clientY)})});
  if(bottom)box.scrollTop=box.scrollHeight;
 }catch(e){toast(e.message)}finally{messagesLoading=false}
}
$("#messageForm").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,input=form.querySelector('[name="content"]'),button=form.querySelector('button[type="submit"]');let value=input.value.trim();if(!value||!channelId||form.dataset.sending==="true")return;const targetChannel=channelId,edit=editingMessage;value=expandComposerCommand(value);if(!value)return;form.dataset.sending="true";if(button){button.disabled=true;button.textContent=edit?"Saving…":"Sending…"}input.value="";hideComposerSuggestions();input.focus();let sent=false;try{if(!edit&&/^(?:-mb|\/mb)\s+/i.test(value)){await api("/bot/command",{method:"POST",body:JSON.stringify({channel_id:targetChannel,content:value})});sent=true;clearReply();await loadMessages()}else if(edit){await api("/messages/"+edit.id+"/edit",{method:"POST",body:JSON.stringify({content:value})});sent=true;cancelMessageEdit();toast("Message edited")}else{await api("/channels/"+targetChannel+"/messages",{method:"POST",body:JSON.stringify({content:value,reply_to_id:replyingTo?.id||null})});sent=true;clearReply()}await loadMessages()}catch(x){if(!sent&&!input.value)input.value=value;toast(x.message)}finally{form.dataset.sending="false";if(button){button.disabled=false;button.textContent=editingMessage?"Save":"Send"}}};

function openForwardPicker(message){const modal=$("#forwardModal"),list=$("#forwardChannelList");if(!modal||!list){toast("Forward menu is unavailable.");return}list.innerHTML=(mentionDirectory.channels||[]).filter(c=>c.kind!=="voice").map(c=>'<button type="button" class="forward-channel-option" data-channel-id="'+esc(c.id)+'"><span>#</span>'+esc(c.name)+'</button>').join("")||'<p class="settings-note">No text channels available.</p>';modal.dataset.messageId=message.id;modal.classList.remove("hidden");closeMessageMenu()}
$("#closeForwardModal").onclick=()=>$("#forwardModal").classList.add("hidden");
$("#forwardChannelList").addEventListener("click",async e=>{const b=e.target.closest("[data-channel-id]");if(!b)return;try{await api("/messages/"+$("#forwardModal").dataset.messageId+"/forward",{method:"POST",body:JSON.stringify({target_channel_id:b.dataset.channelId})});$("#forwardModal").classList.add("hidden");toast("Message forwarded.");if(b.dataset.channelId===channelId)await loadMessages()}catch(x){toast(x.message)}});
function beginMessageEdit(m){editingMessage=m;const input=$("#messageForm [name=content]"),bar=$("#messageEditBar"),button=$("#messageForm button[type=submit]");input.value=m.content;input.placeholder="Edit message…";bar.classList.remove("hidden");button.textContent="Save";input.focus();input.setSelectionRange(input.value.length,input.value.length);closeMessageMenu()}
function cancelMessageEdit(){editingMessage=null;const input=$("#messageForm [name=content]"),bar=$("#messageEditBar"),button=$("#messageForm button[type=submit]");input.value="";input.placeholder="Message #"+(currentChannel?.name||"channel");bar.classList.add("hidden");button.textContent="Send"}
$("#cancelMessageEdit").onclick=cancelMessageEdit;
function clearReply(){replyingTo=null;$("#replyingToBar")?.classList.add("hidden")}
function beginReply(m){replyingTo=m;const bar=$("#replyingToBar");bar.innerHTML='Replying to <b>'+esc(m.username)+'</b>: '+esc(m.content.slice(0,140))+'<button type="button" id="cancelReply">×</button>';bar.classList.remove("hidden");$("#cancelReply").onclick=clearReply;$("#messageForm [name=content]").focus();closeMessageMenu()}

function profileStatusLabel(s){return({online:"Online",idle:"Away",dnd:"Do Not Disturb",invisible:"Invisible"})[s]||"Offline"}
function renderProfilePopover(p,own=false){
 const root=$("#profilePopover"),name=p.display_name||p.username||"User",status=p.status||"online",avatar=p.avatar_url?'<img class="profile-popover-avatar" src="'+esc(p.avatar_url)+'" alt="">':'<div class="profile-popover-avatar status-avatar" data-status="'+esc(status)+'">'+esc(name[0].toUpperCase())+'</div>';
 root.innerHTML='<div class="profile-popover-cover"></div><div class="profile-popover-body">'+avatar+'<div class="profile-popover-name">'+esc(name)+'</div>'+(p.pronouns?'<div class="profile-popover-pronouns">'+esc(p.pronouns)+'</div>':'')+'<div class="profile-popover-status"><span class="presence-dot '+esc(status)+'"></span>'+profileStatusLabel(status)+'</div>'+(p.bio?'<div class="profile-popover-about">'+esc(p.bio)+'</div>':'')+(own?'<div class="profile-popover-actions"><button type="button" id="profileEditButton">Edit profile</button><button type="button" id="profileStatusButton">Change status</button></div>':'')+'</div>';
 root.classList.remove("hidden");
}
async function openUserProfile(userId){
 try{
  if(!userId||userId==="undefined")throw Error("This profile is unavailable.");
  if(userId===me.id){if(!accountProfile||!Object.keys(accountProfile).length){const d=await api("/account/profile");accountProfile=d.profile||{}}renderProfilePopover({...accountProfile,username:me.username},true);return}
  const d=await api("/users/"+encodeURIComponent(userId)+"/profile");if(!d.profile)throw Error("This profile is unavailable.");renderProfilePopover(d.profile,false);
 }catch(e){toast(e.message)}
}

$("#profilePopover").addEventListener("click",e=>{if(e.target.closest("#profileEditButton")){ $("#profilePopover").classList.add("hidden");openAccountSettings()}if(e.target.closest("#profileStatusButton")){$("#profilePopover").classList.add("hidden");openAccountSettings();setTimeout(()=>showAccountPage("account-info"),0)}});
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
  if(kind==="delete"&&confirm("Delete this message?"))api("/messages/"+m.id,{method:"DELETE"}).then(loadMessages).catch(e=>toast(e.message));
  return;
 }
 if(!e.target.closest("#messageContextMenu"))closeMessageMenu();
 const chip=e.target.closest(".reaction-chip");if(chip)toggleReaction(chip.dataset.message,chip.dataset.emoji);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeMessageMenu();closeItemMenu();clearReply()}});
document.addEventListener("scroll",closeMessageMenu,true);document.addEventListener("scroll",closeItemMenu,true);
document.addEventListener("click",e=>{const target=e.target.closest("#userProfileTrigger,.member-profile-trigger,.profile-avatar-trigger");if(!target)return;e.stopPropagation();if(target.id==="userProfileTrigger"){const root=$("#profilePopover");if(!root.classList.contains("hidden"))root.classList.add("hidden");else openUserProfile(me.id);}else if(target.dataset.userId)openUserProfile(target.dataset.userId);else if(target.dataset.botProfile)renderProfilePopover({username:"MallowBot",display_name:"MallowBot",avatar_url:"https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png",bio:"Official MallowCord bot",status:"online",pronouns:""});},{capture:true});
async function toggleReaction(id,emoji){try{await api("/messages/"+id+"/reactions",{method:"POST",body:JSON.stringify({emoji})});await loadMessages()}catch(e){toast(e.message)}}

$("#openEmojiPicker").onclick=()=>{const box=$("#emojiPicker");if(!box.classList.contains("hidden")){box.classList.add("hidden");return}box.innerHTML='<div class="emoji-picker-grid">'+["😀","😂","🥹","😍","😎","😭","💀","🔥","❤️","👍","👎","🎉","👀","🤔","🙏","✨","🚀","💯"].map(e=>'<button type="button" data-insert-emoji="'+e+'">'+e+'</button>').join("")+serverEmojis.map(e=>'<button type="button" data-insert-custom=":'+esc(e.name)+':" title=":'+esc(e.name)+':"><img src="'+esc(e.image_url)+'" alt="'+esc(e.name)+'"></button>').join("")+'</div>';box.classList.remove("hidden")};$("#emojiPicker").addEventListener("click",e=>{const b=e.target.closest("[data-insert-emoji],[data-insert-custom]");if(!b)return;const input=$("#messageForm [name=content]"),v=b.dataset.insertEmoji||b.dataset.insertCustom;input.setRangeText(v,input.selectionStart,input.selectionEnd,"end");input.focus()});document.addEventListener("click",e=>{if(!e.target.closest("#emojiPicker")&&!e.target.closest("#openEmojiPicker"))$("#emojiPicker").classList.add("hidden")});
$("#refreshBtn").onclick=loadMessages;
function hideComposerSuggestions(){const box=$("#composerSuggestions");if(box)box.classList.add("hidden");composerMatches=[];composerMatchIndex=0}
function expandComposerCommand(value){const commands={"/shrug":"¯\\_(ツ)_/¯","/tableflip":"(╯°□°）╯︵ ┻━┻","/unflip":"┬─┬ ノ( ゜-゜ノ)"};const first=value.trim().split(" ")[0].toLowerCase();if(commands[first])return commands[first]+value.slice(first.length);if(first==="/me"&&value.length>4)return "*"+me.username+" "+value.slice(4).trim()+"*";if(first==="/spoiler"&&value.length>9)return "||"+value.slice(9).trim()+"||";return value}
function activeComposerToken(input){const pos=input.selectionStart??input.value.length,left=input.value.slice(0,pos),bot=left.match(/(?:^|\s)-mb(?:\s+([^\s]*))?$/i);if(bot){const q=bot[1]||"",start=left.toLowerCase().lastIndexOf("-mb");return{trigger:"bot",query:q,start,end:pos}}const start=Math.max(left.lastIndexOf(" "),left.lastIndexOf("\n"),left.lastIndexOf("\t"))+1,word=left.slice(start);return word&&["@","#","/"].includes(word[0])?{trigger:word[0],query:word.slice(1),start,end:pos}:null}
function updateComposerSuggestions(){const input=$("#messageForm [name=content]"),box=$("#composerSuggestions"),token=activeComposerToken(input);if(!token){hideComposerSuggestions();return}let items=[];const q=token.query.toLowerCase();if(token.trigger==="/"){items=[{kind:"command",label:"/shrug",detail:"Send a shrug",insert:"/shrug "},{kind:"command",label:"/me",detail:"Action message",insert:"/me "},{kind:"command",label:"/spoiler",detail:"Hide text as a spoiler",insert:"/spoiler "},{kind:"command",label:"/tableflip",detail:"Send a table flip",insert:"/tableflip "},{kind:"command",label:"/unflip",detail:"Put the table back",insert:"/unflip "},{kind:"bot-command",label:"/mb commands",detail:"Mallow-Bot command reference",insert:"-mb commands"}].filter(x=>x.label.slice(1).toLowerCase().startsWith(q))}else if(token.trigger==="bot"){items=["help","commands","uptime","update","sync","countdown","xp","level","leaderboard","balance","daily","gamble","coinflip","slots","roulette","dice","blackjack","work","pay","rob","vibecheck","ship","fortune","wyr","purge","dm","ticket","ticket-panel","ticket-close","youtube","movie","channel","set-log","timeout-minutes","embed","snipe","sticky","backup","custom-command","vanity","premium-status"].map(name=>({kind:"bot-command",label:"-mb "+name,detail:(name==="help"||name==="commands")?"Mallow-Bot command list":"Requires a linked Discord server",insert:"-mb "+name+" "})).filter(x=>x.label.toLowerCase().includes("-mb "+q)).slice(0,16)}else if(token.trigger==="@"){items=[...(mentionDirectory.users||[]).map(u=>({kind:"user",label:"@"+u.username,detail:u.display_name||"Member",insert:"@"+u.username+" "})),...(mentionDirectory.roles||[]).filter(r=>r.pingable!==0).map(r=>({kind:"role",label:r.name.startsWith("@")?r.name:"@"+r.name,detail:"Role",insert:(r.name.startsWith("@")?r.name:"@"+r.name)+" "}))].filter(x=>x.label.slice(1).toLowerCase().includes(q)).slice(0,12)}else if(token.trigger==="#"){items=(mentionDirectory.channels||[]).filter(c=>c.kind!=="voice"&&c.name.toLowerCase().includes(q)).map(c=>({kind:"channel",label:"#"+c.name,detail:"Text channel",insert:"#"+c.name+" ",id:c.id})).slice(0,12)}composerMatches=items;composerMatchIndex=0;if(!items.length){hideComposerSuggestions();return}box.innerHTML=items.map((x,i)=>'<button type="button" class="composer-suggestion '+(i===0?"active":"")+'" data-index="'+i+'">'+(x.kind==="bot-command"?'<img class="bot-command-icon" src="https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png" alt="">':'<span class="suggestion-kind">'+(x.kind==="command"?" / ":x.kind==="channel"?"#":"@")+'</span>')+'<span class="suggestion-label">'+esc(x.label)+'</span><small>'+esc(x.detail)+'</small></button>').join("");box.classList.remove("hidden")}
function chooseComposerSuggestion(index){const input=$("#messageForm [name=content]"),token=activeComposerToken(input),item=composerMatches[index];if(!token||!item)return;input.setRangeText(item.insert,token.start,token.end,"end");hideComposerSuggestions();input.focus();updateComposerSuggestions()}
$("#messageForm [name=content]").addEventListener("input",updateComposerSuggestions);
$("#messageForm [name=content]").addEventListener("keydown",e=>{if(!composerMatches.length)return;if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();composerMatchIndex=(composerMatchIndex+(e.key==="ArrowDown"?1:-1)+composerMatches.length)%composerMatches.length;$("#composerSuggestions").querySelectorAll(".composer-suggestion").forEach((b,i)=>b.classList.toggle("active",i===composerMatchIndex))}else if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();chooseComposerSuggestion(composerMatchIndex)}else if(e.key==="Escape")hideComposerSuggestions()});
$("#composerSuggestions").addEventListener("mousedown",e=>{const b=e.target.closest("[data-index]");if(b){e.preventDefault();chooseComposerSuggestion(Number(b.dataset.index))}});

$("#createChannelBtn").onclick=createChannel;
async function createChannel(){if(!serverId)return;const name=prompt("Channel name (for example: announcements)");if(!name)return;const kind=confirm("Create a voice room? Choose Cancel for a text channel.")?"voice":"text";try{const d=await api("/servers/"+serverId+"/channels",{method:"POST",body:JSON.stringify({name,kind})});toast((kind==="voice"?"Voice room":"Text channel")+" created.");await loadChannels();const found=(await api("/servers/"+serverId+"/channels")).channels.find(c=>c.id===d.channel.id);if(found)selectChannel(found);if(kind==="voice")toast("Voice room created. Live voice calling is not connected yet.")}catch(e){toast(e.message)}}
async function createServer(){const name=prompt("New server name");if(!name)return;try{const d=await api("/servers",{method:"POST",body:JSON.stringify({name})});toast("Server created.");await loadServers();const all=await api("/servers");const s=all.servers.find(x=>x.id===d.server.id);if(s)await selectServer(s)}catch(e){toast(e.message)}}
$("#addServer").onclick=createServer;
$("#serverMenuBtn").onclick=()=>openServerSettings("overview");
$("#closeServerModal").onclick=()=>$("#serverModal").classList.add("hidden");
document.querySelectorAll(".settings-tab").forEach(b=>b.onclick=()=>openServerSettings(b.dataset.settingsTab));
async function openServerSettings(tab="overview"){if(!serverId)return;$("#serverModal").classList.remove("hidden");document.querySelectorAll(".settings-tab").forEach(b=>b.classList.toggle("active",b.dataset.settingsTab===tab));const pane=$("#serverSettingsContent");pane.innerHTML='<div class="settings-loading">Loading…</div>';$("#serverSettingsSubtitle").textContent=currentServer?.name||"Server";try{if(tab==="overview"){const d=await api("/servers/"+serverId+"/settings");const s=d.server;pane.innerHTML='<form id="serverOverviewForm" class="settings-form"><label>Server name<input name="name" maxlength="50" required value="'+esc(s.name)+'"></label><label>Server icon URL<input name="icon_url" type="url" placeholder="https://…" value="'+esc(s.icon_url||"")+'"></label><p class="settings-note">Use a direct HTTPS image URL for the server icon.</p>'+(d.can_manage?'<button class="primary settings-save">Save changes</button>':'<p class="settings-note">Only this server owner can edit server details.</p>')+'</form>'}
if(tab==="emojis"){const d=await api("/servers/"+serverId+"/emojis");pane.innerHTML=(d.can_manage?'<form id="createEmojiForm" class="inline-create emoji-create-form"><input name="name" placeholder="emoji_name" pattern="[A-Za-z0-9_]{2,32}" maxlength="32" required><input name="image_file" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><input name="image_url" type="url" placeholder="Or paste HTTPS image URL"><button class="primary">Add emoji</button></form>':'')+'<p class="settings-note">Add a direct HTTPS image URL. Type :emoji_name: in messages to use it.</p><div class="server-emoji-grid">'+(d.emojis||[]).map(e=>'<div class="server-emoji-item"><img src="'+esc(e.image_url)+'" alt=""><b>:'+esc(e.name)+':</b>'+(d.can_manage?'<button class="danger-small delete-emoji" data-id="'+e.id+'">Remove</button>':'')+'</div>').join("")+'</div>'}
if(tab==="stats"){const d=await api("/servers/"+serverId+"/stats"),s=d.stats;pane.innerHTML='<div class="stats-grid">'+statCard("Members",s.members)+statCard("Channels",s.channels)+statCard("Messages",s.messages)+statCard("Roles",s.roles)+'</div><p class="settings-note">Created '+new Date(s.created_at*1000).toLocaleString()+'</p>'}
if(tab==="roles"){const d=await api("/servers/"+serverId+"/roles");serverRoles=d.roles||[];pane.innerHTML=(d.can_manage?'<form id="createRoleForm" class="inline-create"><input name="name" placeholder="New role name" minlength="2" maxlength="32" required><button class="primary">Create role</button></form>':'')+'<div class="settings-list">'+serverRoles.map(r=>'<div class="settings-list-row"><div><b>'+esc(r.name)+'</b><small>'+(r.is_system?"Built-in role":"Custom role")+'</small></div>'+(d.can_manage?'<div class="row-actions"><label class="role-ping-toggle"><input type="checkbox" class="role-ping-setting" data-id="'+r.id+'" '+(r.pingable!==0?"checked":"")+ '> Allow mentions</label>'+(!r.is_system?'<button class="secondary edit-role" data-id="'+r.id+'">Rename</button><button class="danger-small delete-role" data-id="'+r.id+'">Delete</button>':'')+'</div>':'')+'</div>').join("")+'</div><p class="settings-note">Built-in @everyone and @Member roles are protected.</p>'}
if(tab==="members"){const [d,rd]=await Promise.all([api("/servers/"+serverId+"/members"),api("/servers/"+serverId+"/roles")]);serverRoles=rd.roles||[];pane.innerHTML='<div class="settings-list">'+(d.members||[]).map(mem=>'<div class="member-setting"><div class="member-setting-main"><b>'+esc(mem.username)+'</b><small>'+esc(mem.account_type)+' · '+esc(mem.status)+' · '+esc(mem.roles||"")+'</small></div>'+(d.can_manage?'<div class="member-role-control"><select class="member-role-select" data-user="'+mem.id+'">'+serverRoles.filter(r=>r.name!=="@everyone").map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join("")+'</select><button class="secondary assign-role" data-user="'+mem.id+'">Assign</button></div>':'')+'</div>').join("")+'</div>'}
if(tab==="onboarding"){const d=await api("/servers/"+serverId+"/onboarding"),c=d.config;pane.innerHTML='<form id="onboardingSettingsForm" class="settings-form"><label class="toggle-line"><input type="checkbox" name="enabled" '+(c.enabled?"checked":"")+'> Enable server onboarding</label><label>Welcome message<textarea name="welcome_text" rows="3" maxlength="1000" placeholder="Welcome to our community…">'+esc(c.welcome_text||"")+'</textarea></label><label>Server rules<textarea name="rules_text" rows="5" maxlength="3000" placeholder="Be respectful…">'+esc(c.rules_text||"")+'</textarea></label>'+(d.can_manage?'<button class="primary settings-save">Save onboarding</button>':'<p class="settings-note">Only the server owner can edit onboarding.</p>')+'</form><p class="settings-note">Members who have not completed onboarding will see this welcome and rules screen when they enter the server.</p>'}
}catch(e){pane.innerHTML='<p class="settings-error">'+esc(e.message)+'</p>'}}
function statCard(label,value){return '<div class="stat-card"><small>'+label+'</small><strong>'+Number(value||0).toLocaleString()+'</strong></div>'}
$("#serverSettingsContent").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;if(f.id==="serverOverviewForm"){try{const d=await api("/servers/"+serverId+"/settings",{method:"POST",body:JSON.stringify({name:f.name.value,icon_url:f.icon_url.value})});currentServer=d.server;$("#workspaceName").textContent=d.server.name;$("#serverSettingsSubtitle").textContent=d.server.name;toast("Server settings saved.");await loadServers()}catch(x){toast(x.message)}}
if(f.id==="createRoleForm"){try{await api("/servers/"+serverId+"/roles",{method:"POST",body:JSON.stringify({name:f.name.value})});toast("Role created.");openServerSettings("roles")}catch(x){toast(x.message)}}
if(f.id==="createEmojiForm"){try{let image_url=f.image_url.value.trim();const file=f.image_file.files?.[0];if(file){if(file.size>256*1024)throw Error("Emoji images must be 256 KB or smaller.");if(!["image/png","image/jpeg","image/gif","image/webp"].includes(file.type))throw Error("Use a PNG, JPG, GIF or WebP image.");image_url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error("Could not read that image."));reader.readAsDataURL(file)})}if(!image_url)throw Error("Choose an image file or paste an HTTPS image URL.");await api("/servers/"+serverId+"/emojis",{method:"POST",body:JSON.stringify({name:f.name.value,image_url})});toast("Custom emoji added.");openServerSettings("emojis")}catch(x){toast(x.message)}}
if(f.id==="onboardingSettingsForm"){try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({enabled:f.enabled.checked,welcome_text:f.welcome_text.value,rules_text:f.rules_text.value})});toast("Onboarding settings saved.")}catch(x){toast(x.message)}}});
$("#serverSettingsContent").addEventListener("change",async e=>{const toggle=e.target.closest(".role-ping-setting");if(toggle){toggle.disabled=true;try{await api("/servers/"+serverId+"/roles/"+toggle.dataset.id,{method:"POST",body:JSON.stringify({pingable:toggle.checked})});toast("Role mention permission updated.");}catch(x){toggle.checked=!toggle.checked;toast(x.message)}finally{toggle.disabled=false}}});
$("#serverSettingsContent").addEventListener("click",async e=>{const emojiDel=e.target.closest(".delete-emoji");if(emojiDel){if(!confirm("Remove this custom emoji?"))return;try{await api("/servers/"+serverId+"/emojis/"+emojiDel.dataset.id,{method:"DELETE"});toast("Emoji removed.");openServerSettings("emojis")}catch(x){toast(x.message)}}
 const edit=e.target.closest(".edit-role"),del=e.target.closest(".delete-role"),assign=e.target.closest(".assign-role");if(edit){const role=serverRoles.find(r=>r.id===edit.dataset.id),name=prompt("Rename role",role?.name||"");if(!name)return;try{await api("/servers/"+serverId+"/roles/"+edit.dataset.id,{method:"POST",body:JSON.stringify({name})});toast("Role renamed.");openServerSettings("roles")}catch(x){toast(x.message)}}if(del){if(!confirm("Delete this role? Members will lose it."))return;try{await api("/servers/"+serverId+"/roles/"+del.dataset.id,{method:"DELETE"});toast("Role deleted.");openServerSettings("roles")}catch(x){toast(x.message)}}if(assign){const sel=$("#serverSettingsContent .member-role-select[data-user='"+assign.dataset.user+"']");if(!sel?.value)return;try{await api("/servers/"+serverId+"/members/"+assign.dataset.user+"/roles",{method:"POST",body:JSON.stringify({role_id:sel.value})});toast("Role assigned.");openServerSettings("members")}catch(x){toast(x.message)}}});
async function checkOnboarding(){if(!serverId)return;const d=await api("/servers/"+serverId+"/onboarding");if(!d.config.enabled||d.completed)return;$("#onboardingTitle").textContent="Welcome to "+(currentServer?.name||"the server");$("#onboardingWelcome").textContent=d.config.welcome_text||"Welcome!";$("#onboardingRules").textContent=d.config.rules_text||"Please be respectful.";$("#onboardingModal").classList.remove("hidden")}
$("#finishOnboarding").onclick=async()=>{try{await api("/servers/"+serverId+"/onboarding",{method:"POST",body:JSON.stringify({complete:true})});$("#onboardingModal").classList.add("hidden");toast("You're all set.")}catch(e){toast(e.message)}};

let accountProfile={},accountPreferences={},activeAccountPage="account-info";
const preferenceDefaults={
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
const accountPageMeta={
 "account-info":["Account Info","Change your username, display name, profile picture and contact details."],
 security:["Password & Security","Manage sign-in security, passwords and recovery."],
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
 "error-logs":["Error Logs","Review server-side errors captured by the MallowCord API."]
};
async function openAccountSettings(){
 const owner=me?.account_type==="owner";$("#ownerToolsTitle").hidden=!owner;$("#ownerErrorLogs").hidden=!owner;
 $("#modal").classList.remove("hidden");
 $("#accountSettingsContent").innerHTML='<div class="settings-loading">Loading account settings…</div>';
 try{
  const [p,s]=await Promise.all([api("/account/profile"),api("/account/preferences")]);
  accountProfile=p.profile||{};accountPreferences={...preferenceDefaults,...(s.settings||{})};
  for(const k of Object.keys(preferenceDefaults))accountPreferences[k]={...preferenceDefaults[k],...(s.settings?.[k]||{})};
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
async function loadErrorLogs(){
 const root=$("#accountSettingsContent");root.innerHTML='<div class="settings-loading">Loading error logs…</div>';
 try{
  const d=await api("/admin/errors"),rows=d.errors||[];
  root.innerHTML='<div class="account-panel error-log-toolbar"><div><h3>API error logs</h3><p class="account-note">Runtime exceptions captured by the MallowCord Worker. Request bodies, cookies and passwords are not recorded.</p></div><div class="error-log-actions"><button type="button" class="secondary" id="refreshErrorLogs">Refresh</button><button type="button" class="danger" id="clearErrorLogs" '+(rows.length?'':'disabled')+'>Clear logs</button></div></div>'+
   (rows.length?'<div class="error-log-list">'+rows.map(row=>'<article class="error-log-entry"><div class="error-log-top"><span class="error-log-method">'+esc(row.method||'UNKNOWN')+'</span><code>'+esc(row.path||'')+'</code><time>'+esc(new Date(Number(row.created_at)||0).toLocaleString())+'</time></div><p class="error-log-message">'+esc(row.message||'Unknown error')+'</p>'+(row.origin?'<p class="account-note">Origin: '+esc(row.origin)+'</p>':'')+(row.stack?'<details><summary>Stack trace</summary><pre>'+esc(row.stack)+'</pre></details>':'')+'</article>').join('')+'</div>':'<div class="account-panel"><h3>No captured errors</h3><p class="account-note">The Worker has not recorded any runtime exceptions yet. Platform-level failures that happen before the Worker runs may not appear here.</p></div>');
  $("#refreshErrorLogs").onclick=loadErrorLogs;
  $("#clearErrorLogs").onclick=async()=>{if(!confirm("Permanently clear all recorded error logs?"))return;try{await api("/admin/errors",{method:"DELETE"});toast("Error logs cleared");await loadErrorLogs()}catch(e){toast(e.message)}};
 }catch(e){root.innerHTML='<div class="account-panel"><h3>Could not load error logs</h3><p class="settings-error">'+esc(e.message)+'</p><button type="button" class="secondary" id="retryErrorLogs">Retry</button></div>';$("#retryErrorLogs").onclick=loadErrorLogs}
}
async function showAccountPage(page){
 activeAccountPage=page;document.querySelectorAll(".account-nav").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
 const meta=accountPageMeta[page]||["Settings","Manage your preferences."];
 $("#accountPageTitle").textContent=meta[0];$("#accountPageDescription").textContent=meta[1];
 const root=$("#accountSettingsContent");
 if(page==="account-info"){
  const p=accountProfile,verifiedEmail=!!p.email_verified_at,verifiedPhone=!!p.phone_verified_at;
  root.innerHTML='<div class="account-panel"><h3>Profile</h3><form id="profileSettingsForm" class="account-form"><label>Username<div class="inline-field"><input name="username" value="'+esc(me.username)+'" minlength="3" maxlength="24" required><button class="secondary" type="button" id="saveUsername">Save</button></div></label><label>Display name<input name="display_name" maxlength="32" value="'+esc(p.display_name||"")+'" placeholder="How others see you"></label><label>Pronouns<input name="pronouns" maxlength="32" value="'+esc(p.pronouns||"")+'" placeholder="e.g. they/them"></label><label>About me<textarea name="bio" maxlength="190" rows="3" placeholder="Tell people a little about yourself">'+esc(p.bio||"")+'</textarea></label><label>Online status<select name="status"><option value="online" '+((p.status||"online")==="online"?"selected":"")+' >Online</option><option value="idle" '+(p.status==="idle"?"selected":"")+' >Away</option><option value="dnd" '+(p.status==="dnd"?"selected":"")+' >Do not disturb</option><option value="invisible" '+(p.status==="invisible"?"selected":"")+' >Invisible</option></select></label><div class="avatar-upload-section"><label>Profile picture<input id="avatarFileInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><p class="account-note">Choose an image, then drag it inside the square to reposition it. Use the zoom slider to frame the part you want.</p><div class="avatar-crop-stage hidden" id="avatarCropStage"><canvas id="avatarCropCanvas" width="320" height="320" aria-label="Profile picture crop preview"></canvas><span class="avatar-crop-hint">Drag to reposition</span></div><div class="avatar-crop-controls hidden" id="avatarCropControls"><label>Zoom <input id="avatarZoom" type="range" min="1" max="3" step="0.01" value="1"></label><button type="button" class="secondary" id="resetAvatarCrop">Reset crop</button><button type="button" class="secondary" id="clearAvatarCrop">Cancel image</button></div><div class="account-avatar-preview" id="savedAvatarPreview">'+(p.avatar_url?'<img src="'+esc(p.avatar_url)+'" alt="Profile preview">':'<span>'+esc((p.display_name||me.username)[0].toUpperCase())+'</span>')+'</div><label>Or use a profile picture URL<input name="avatar_url" type="url" value="'+(String(p.avatar_url||"").startsWith("data:image/")?"":esc(p.avatar_url||""))+'" placeholder="https://example.com/avatar.png"></label></div><button class="primary">Save profile</button></form></div><div class="account-panel"><h3>Email verification</h3><p class="account-note">Add an email address and verify it with a one-time code.</p><form id="emailVerifyForm" class="account-form"><label>Email address<input name="value" type="email" value="'+esc(p.email||"")+'" placeholder="you@example.com" required></label><div class="verification-state '+(verifiedEmail?"verified":"")+'">'+(verifiedEmail?"Verified":"Not verified")+'</div><button class="secondary">Send verification code</button></form><form id="emailConfirmForm" class="account-form verify-code-form"><label>Six-digit email code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label><button class="primary">Confirm email</button></form></div><div class="account-panel"><h3>Phone verification</h3><p class="account-note">Use international format, including the country code (for example +12065550123).</p><form id="phoneVerifyForm" class="account-form"><label>Phone number<input name="value" type="tel" value="'+esc(p.phone||"")+'" placeholder="+12065550123" required></label><div class="verification-state '+(verifiedPhone?"verified":"")+'">'+(verifiedPhone?"Verified":"Not verified")+'</div><button class="secondary">Send SMS code</button></form><form id="phoneConfirmForm" class="account-form verify-code-form"><label>Six-digit SMS code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label><button class="primary">Confirm phone</button></form></div>';
  initAvatarCropper();
  $("#profileSettingsForm").onsubmit=async e=>{e.preventDefault();try{const d=new FormData(e.target),cropped=avatarCropImage?await getCroppedAvatar():null,url=String(d.get("avatar_url")||"").trim();if(cropped&&url)throw Error("Choose either your uploaded picture or a picture URL, not both.");const avatar=cropped||url||(String(accountProfile.avatar_url||"").startsWith("data:image/")?accountProfile.avatar_url:"");await api("/account/profile",{method:"POST",body:JSON.stringify({display_name:d.get("display_name"),avatar_url:avatar,bio:d.get("bio"),pronouns:d.get("pronouns"),status:d.get("status")})});accountProfile=(await api("/account/profile")).profile;avatarCropImage=null;if(avatarCropObjectUrl)URL.revokeObjectURL(avatarCropObjectUrl);avatarCropObjectUrl=null;applyProfile();toast("Profile updated");showAccountPage("account-info")}catch(x){toast(x.message)}};
  $("#saveUsername").onclick=async()=>{const val=$("#profileSettingsForm").username.value;try{const d=await api("/auth/username",{method:"POST",body:JSON.stringify({username:val})});me.username=d.username;$("#currentUsername").textContent=me.username;toast("Username updated")}catch(x){toast(x.message)}};
  for(const [form,channel] of [["emailVerifyForm","email"],["phoneVerifyForm","phone"]])$("#"+form).onsubmit=async e=>{e.preventDefault();try{const value=new FormData(e.target).get("value");await api("/account/contact/request",{method:"POST",body:JSON.stringify({channel,value})});accountProfile=(await api("/account/profile")).profile;toast("Verification code sent");showAccountPage("account-info")}catch(x){toast(x.message)}};
  for(const [form,channel] of [["emailConfirmForm","email"],["phoneConfirmForm","phone"]])$("#"+form).onsubmit=async e=>{e.preventDefault();try{await api("/account/contact/confirm",{method:"POST",body:JSON.stringify({channel,code:new FormData(e.target).get("code")})});accountProfile=(await api("/account/profile")).profile;toast("Contact method verified");showAccountPage("account-info")}catch(x){toast(x.message)}};
 }else if(page==="security"){
  root.innerHTML='<div class="account-panel"><h3>Password</h3>'+(me.account_type==="basic"?'<p class="account-note">This is a device-based basic account. It currently signs in with its saved device cookie and recovery code rather than a password. Password login is available on full-access accounts.</p>':'<form id="passwordForm" class="account-form"><label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><label>New password<input name="new_password" type="password" minlength="12" autocomplete="new-password" required></label><label>Confirm new password<input name="confirm_password" type="password" minlength="12" autocomplete="new-password" required></label><button class="primary">Change password</button></form>')+'</div><div class="account-panel"><h3>Two-factor authentication</h3><span class="coming-soon">COMING SOON</span><p class="account-note">Authenticator apps and backup codes are planned but are not enabled yet.</p></div><div class="account-panel"><h3>Recovery code</h3><p class="account-note">Keep a recovery code somewhere safe. Generating a new one invalidates the previous code.</p><button id="rotateRecovery" class="secondary">Generate new recovery code</button><code id="rotatedCode" class="recovery-code-output"></code></div><div class="account-panel"><h3>Device session</h3><p class="account-note">This device is signed in using a secure, HTTP-only session cookie.</p><button id="securityLogout" class="danger">Sign out of this device</button></div>';
  if($("#passwordForm"))$("#passwordForm").onsubmit=async e=>{e.preventDefault();const d=new FormData(e.target);if(d.get("new_password")!==d.get("confirm_password"))return toast("New passwords do not match.");try{await api("/account/password",{method:"POST",body:JSON.stringify({current_password:d.get("current_password"),new_password:d.get("new_password")})});e.target.reset();toast("Password changed successfully")}catch(x){toast(x.message)}};
  $("#rotateRecovery").onclick=async()=>{try{const d=await api("/auth/recovery/rotate",{method:"POST"});$("#rotatedCode").textContent=d.recovery_code;toast("New recovery code created. Save it now.")}catch(x){toast(x.message)}};
  $("#securityLogout").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};
 }else if(page==="status"){
  const d=await api("/account/status"),u=d.account;
  root.innerHTML='<div class="account-panel"><h3>Account standing</h3><div class="status-line"><span>Account status</span><b class="'+(u.status==="active"?"status-good":"status-warning")+'">'+esc(u.status)+'</b></div><div class="status-line"><span>Account type</span><b>'+esc(u.account_type)+'</b></div><div class="status-line"><span>Username</span><b>'+esc(u.username)+'</b></div><div class="status-line"><span>Created</span><b>'+new Date(u.created_at*1000).toLocaleDateString()+'</b></div>'+(u.timeout_until?'<div class="status-line"><span>Timeout expires</span><b>'+new Date(u.timeout_until*1000).toLocaleString()+'</b></div>':"")+'</div>';
 }else if(page==="family"){
  root.innerHTML='<div class="account-panel"><h3>Family Center</h3><span class="coming-soon">COMING SOON</span><p class="account-note">Family supervision, guardian links and teen safety controls are not available in MallowCord yet.</p></div>';
 }else if(page==="apps"){
  root.innerHTML='<div class="account-panel"><h3>Connected Apps</h3><p class="account-note">No third-party apps are currently connected to your MallowCord account.</p></div>';
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
  if(page==="appearance"){fields.push(settingField("Theme","theme","select",[["dark","Dark"],["light","Light"],["darker","Darker"],["opposite","Opposite colors"],["red","Red"],["blue","Blue"],["green","Green"],["purple","Purple"],["orange","Orange"],["yellow","Yellow"]]),settingField("Compact message layout","compactMode"),settingField("Show avatars","showAvatars"),settingField("Text size","fontScale","select",[["90%","Small"],["100%","Default"],["110%","Large"],["125%","Extra large"]]));fields.push('<div class="css-theme-editor"><h3>Custom CSS</h3><p class="account-note">Import a .css file or paste CSS below. Saved CSS follows your account across devices.</p><label class="css-file-label">Import CSS file<input id="cssThemeFile" type="file" accept=".css,text/css"></label><textarea id="customCssInput" rows="10" spellcheck="false" placeholder="/* Your custom MallowCord CSS */">'+esc(accountPreferences.appearance?.customCss||"")+'</textarea><div class="css-theme-actions"><button type="button" class="secondary" id="previewCustomCss">Preview CSS</button><button type="button" class="secondary" id="clearCustomCss">Clear CSS</button></div><p class="account-note">Custom CSS is applied to your account view only. Use trusted CSS.</p></div>')}
  if(page==="accessibility")fields.push(settingField("Reduce motion","reducedMotion"),settingField("High contrast","highContrast"),settingField("Larger text","largerText"),settingField("Screen-reader labels","screenReaderLabels"));
  if(page==="system")fields.push(settingField("Spellcheck in message composer","spellcheck"),settingField("Hardware acceleration preference","hardwareAcceleration"),settingField("Confirm before closing","confirmBeforeClosing"));
  if(page==="language")fields.push(settingField("Language","language","select",[["English (US)","English (US)"],["English (UK)","English (UK)"],["Spanish","Spanish"],["French","French"],["German","German"],["Portuguese","Portuguese"]]),settingField("Timezone","timezone","select",[[Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"],["UTC","UTC"],["America/Los_Angeles","Pacific Time"],["America/Denver","Mountain Time"],["America/Chicago","Central Time"],["America/New_York","Eastern Time"],["Europe/London","London"],["Europe/Paris","Central European Time"]]),settingField("Date format","dateFormat","select",[["MM/DD/YYYY","MM/DD/YYYY"],["DD/MM/YYYY","DD/MM/YYYY"],["YYYY-MM-DD","YYYY-MM-DD"]]));
  if(page==="activity")fields.push(settingField("Share current game/activity","shareCurrentActivity"),settingField("Show recent activity on my profile","showRecentActivity"));
  if(page==="clips")fields.push(settingField("Enable clip saving","saveClips"),settingField("Clip quality","clipQuality","select",[["720p","720p"],["1080p","1080p"],["1440p","1440p"]]),'<p class="account-note">Clip capture is a planned feature; these preferences are saved for later.</p>');
  if(page==="overlay")fields.push(settingField("Enable game overlay","enableOverlay"),settingField("Overlay position","overlayPosition","select",[["top-right","Top right"],["top-left","Top left"],["bottom-right","Bottom right"],["bottom-left","Bottom left"]]),'<p class="account-note">The desktop game overlay is not available in the web app yet.</p>');
  root.innerHTML=prefPage(page,fields);
  if($("#customCssInput")){$("#cssThemeFile").onchange=async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>50000){toast("CSS file must be 50 KB or smaller.");return}$("#customCssInput").value=await file.text()};$("#previewCustomCss").onclick=()=>{try{applyCustomCss($("#customCssInput").value);toast("CSS preview applied")}catch(e){toast(e.message)}};$("#clearCustomCss").onclick=()=>{$("#customCssInput").value="";applyCustomCss("");toast("Custom CSS cleared")}}$("#savePreferences").onclick=async()=>{const values={...(accountPreferences[page]||{})};root.querySelectorAll("[data-pref]").forEach(el=>values[el.dataset.pref]=el.type==="checkbox"?el.checked:el.value);if(page==="appearance")values.customCss=$("#customCssInput")?.value||"";accountPreferences[page]=values;try{await api("/account/preferences",{method:"POST",body:JSON.stringify({settings:accountPreferences})});applyPreferences();toast("Settings saved across your devices")}catch(e){toast(e.message)}};
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
 const name=accountProfile.display_name||me.username;$("#currentUsername").textContent=name;
 const avatar=$("#userAvatar");avatar.innerHTML=accountProfile.avatar_url?'<img src="'+esc(accountProfile.avatar_url)+'" alt="">':esc(name[0].toUpperCase());avatar.dataset.status=accountProfile.status||"online";$("#currentUsername").dataset.status=accountProfile.status||"online";
}
function applyCustomCss(source){
 let css=String(source||"");
 if(css.length>50000)throw Error("Custom CSS must be 50 KB or smaller.");
 const allowedImport="https://puckzxz.github.io/NotAnotherAnimeTheme/build/v3/naat.v3.css";
 let imported=null;
 css=css.replace(/@import\s+(?:url\(\s*)?(['"]?)(https:\/\/[^'")\s;]+)\1\s*\)?\s*;/gi,(all,q,url)=>{
  if(url!==allowedImport)throw Error("Only the supplied NotAnotherAnimeTheme stylesheet is allowed as an external import.");
  if(imported&&imported!==url)throw Error("Only one external theme stylesheet can be imported.");
  imported=url;return "";
 });
 if(/@import/i.test(css)||/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|<\/style/i.test(css))throw Error("This CSS contains an unsupported or unsafe construct.");
 let link=document.getElementById("mallowcord-approved-theme-import");
 if(imported){
  if(!link){link=document.createElement("link");link.id="mallowcord-approved-theme-import";link.rel="stylesheet";document.head.append(link)}
  if(link.href!==imported)link.href=imported;
 }else link?.remove();
 let style=document.getElementById("mallowcord-custom-css");
 if(!style){style=document.createElement("style");style.id="mallowcord-custom-css";document.head.append(style)}
 style.textContent=css;
}
function applyPreferences(){const theme=accountPreferences.appearance?.theme||"dark";document.body.dataset.theme=theme;document.body.classList.toggle("reduced-motion",!!accountPreferences.accessibility?.reducedMotion);document.body.classList.toggle("high-contrast",!!accountPreferences.accessibility?.highContrast);document.documentElement.style.setProperty("--account-font-scale",accountPreferences.appearance?.fontScale||"100%");try{applyCustomCss(accountPreferences.appearance?.customCss||"")}catch(e){console.warn("Custom CSS:",e.message)}}
document.querySelectorAll(".account-nav").forEach(b=>b.onclick=()=>showAccountPage(b.dataset.page));
$("#settingsBtn").onclick=openAccountSettings;

$("#closeModal").onclick=()=>$("#modal").classList.add("hidden");
$("#logout").onclick=async()=>{await api("/auth/logout",{method:"POST"});location.reload()};
(async()=>{try{me=(await api("/auth/me")).user;await enterApp()}catch{}})();