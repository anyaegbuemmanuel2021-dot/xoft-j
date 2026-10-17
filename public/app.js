const $ = (id) => document.getElementById(id);
const state = { conversationId: null, provider: 'openai', busy: false, status: null };
const tokenKey = 'xoft-jarvis-access-token';
let toastTimer;
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); }
function token() { return sessionStorage.getItem(tokenKey) || ''; }
async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (token()) headers.authorization = 'Bearer ' + token();
  const response = await fetch('/api' + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { $('accessToken').value = ''; toast('Access token required. Add it in Settings or use the key icon.'); throw new Error(data.error || 'Unauthorized'); }
  if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ')');
  return data;
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function date(s) { try { return new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } }
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('view-' + name)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const titles = { chat:'Chat', tasks:'Tasks', memory:'Memory', agents:'Agents & tools', approvals:'Approvals', activity:'Activity', settings:'Settings' };
  $('pageTitle').textContent = titles[name] || name; $('heading').innerHTML = name === 'chat' ? 'Think clearly.<br><span>Move intelligently.</span>' : escapeHtml(titles[name] || name);
  $('subheading').textContent = name === 'chat' ? 'Your personal intelligence layer, ready when you are.' : 'A clear view of your personal assistant workspace.';
  $('sidebar').classList.remove('open');
  if (name === 'tasks') loadTasks(); if (name === 'memory') loadMemory(); if (name === 'approvals') loadApprovals(); if (name === 'activity') loadActivity(); if (name === 'settings') loadRuntime();
}
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$('mobileMenu').addEventListener('click', () => $('sidebar').classList.toggle('open'));
$('newChat').addEventListener('click', newChat); $('clearChat').addEventListener('click', newChat);
function newChat() { state.conversationId = null; $('messages').innerHTML = welcomeHtml(); $('messageInput').focus(); }
function welcomeHtml() { return '<div class="welcome"><div class="welcome-symbol">✳</div><h3>How can I help you today?</h3><p>Ask a question, plan a project, or work through a problem. Jarvis will be clear about what it can and cannot do.</p><div class="suggestions"><button data-prompt="Help me plan my priorities for today.">⌁ <span>Plan my day</span></button><button data-prompt="Help me debug a programming problem.">⌘ <span>Debug code</span></button><button data-prompt="Help me plan the next milestone for my project.">↗ <span>Project planning</span></button></div></div>'; }
function appendMessage(role, content, error = false) {
  const welcome = $('messages').querySelector('.welcome'); if (welcome) welcome.remove();
  const el = document.createElement('div'); el.className = 'message ' + role + (error ? ' error' : '');
  el.innerHTML = '<div class="role">' + (role === 'user' ? 'YOU' : error ? 'SYSTEM' : 'JARVIS') + '</div><div>' + escapeHtml(content) + '</div>';
  $('messages').appendChild(el); $('messages').scrollTop = $('messages').scrollHeight;
}
$('messages').addEventListener('click', e => { const b = e.target.closest('[data-prompt]'); if (b) { $('messageInput').value = b.dataset.prompt; $('messageInput').focus(); } });
document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => { $('messageInput').value = b.dataset.prompt; $('messageInput').focus(); }));
$('providerSelect').addEventListener('change', async () => { try { const d = await api('/settings/provider', { method:'POST', body:JSON.stringify({ provider:$('providerSelect').value }) }); state.provider=d.provider; toast('Provider set to ' + d.provider); await loadStatus(); } catch(e) { toast(e.message); $('providerSelect').value=state.provider; } });
$('chatForm').addEventListener('submit', async e => {
  e.preventDefault(); if (state.busy) return;
  const message = $('messageInput').value.trim(); if (!message) return;
  appendMessage('user', message); $('messageInput').value=''; state.busy=true; $('sendBtn').disabled=true; $('sendBtn').innerHTML='Thinking <span>…</span>';
  const placeholder = document.createElement('div'); placeholder.className='message assistant'; placeholder.innerHTML='<div class="role">JARVIS</div><div>Thinking through this…</div>'; $('messages').appendChild(placeholder);
  try {
    const data = await api('/chat', { method:'POST', body:JSON.stringify({ message, conversationId:state.conversationId, provider:state.provider }) });
    state.conversationId=data.conversationId; placeholder.remove(); appendMessage('assistant', data.reply);
    if ('speechSynthesis' in window && $('speakResponses')?.checked) speak(data.reply);
    await loadStatus();
  } catch(err) { placeholder.remove(); appendMessage('assistant', err.message, true); }
  finally { state.busy=false; $('sendBtn').disabled=false; $('sendBtn').innerHTML='Send <span>↗</span>'; $('messageInput').focus(); }
});
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } });
$('voiceBtn').addEventListener('click', () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return toast('Voice input is not supported in this browser. Try Chrome.');
  const recognition = new SpeechRecognition(); recognition.lang = navigator.language || 'en-NG'; recognition.interimResults = false; recognition.maxAlternatives = 1;
  $('voiceBtn').textContent='●'; recognition.onresult = e => { $('messageInput').value = e.results[0][0].transcript; $('messageInput').focus(); };
  recognition.onerror = e => toast('Voice input: ' + e.error); recognition.onend = () => $('voiceBtn').textContent='🎙'; recognition.start();
});
function speak(text) { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-NG'; speechSynthesis.speak(u); }
async function loadStatus() {
  try {
    state.status = await api('/status'); $('connectionText').textContent='Core online'; $('providerText').textContent=state.status.provider + ' · ' + (state.status.authEnabled ? 'protected' : 'local mode');
    $('mConvos').textContent=state.status.counts.conversations; $('mMemory').textContent=state.status.counts.memories; $('mTasks').textContent=state.status.counts.tasks; $('mApprovals').textContent=state.status.counts.pendingApprovals;
    $('providerSelect').value=state.status.provider; state.provider=state.status.provider; $('version').textContent='V'+state.status.version;
  } catch(e) { $('connectionText').textContent='Core unavailable'; $('providerText').textContent='Check server / token'; }
}
async function loadTasks() {
  try { const items=await api('/tasks'); $('taskList').innerHTML=items.length ? items.map(t=>'<div class="list-row"><input class="check" type="checkbox" data-task="'+t.id+'" '+(t.status==='done'?'checked':'')+' aria-label="Mark task done"><div class="list-main"><strong style="'+(t.status==='done'?'text-decoration:line-through;color:#71879a':'')+'">'+escapeHtml(t.title)+'</strong><small>'+escapeHtml(date(t.createdAt))+' · '+escapeHtml(t.status)+'</small></div><button class="danger" data-delete-task="'+t.id+'">Delete</button></div>').join('') : '<div class="empty">No tasks yet. Add one above.</div>'; } catch(e) { $('taskList').innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>'; }
}
$('taskForm').addEventListener('submit', async e=>{e.preventDefault();try{await api('/tasks',{method:'POST',body:JSON.stringify({title:$('taskInput').value})});$('taskInput').value='';await loadTasks();await loadStatus();toast('Task added');}catch(e){toast(e.message);}});
$('taskList').addEventListener('change',async e=>{const id=e.target.dataset.task;if(!id)return;try{await api('/tasks/'+id,{method:'PATCH',body:JSON.stringify({status:e.target.checked?'done':'open'})});await loadTasks();await loadStatus();}catch(err){toast(err.message);}});
$('taskList').addEventListener('click',async e=>{const id=e.target.dataset.deleteTask;if(!id)return;try{await api('/tasks/'+id,{method:'DELETE'});await loadTasks();await loadStatus();}catch(err){toast(err.message);}});
async function loadMemory(){try{const items=await api('/memory');$('memoryList').innerHTML=items.length?items.map(m=>'<div class="list-row"><div class="list-main"><strong>'+escapeHtml(m.text)+'</strong><small>Saved '+escapeHtml(date(m.createdAt))+'</small></div><button class="danger" data-delete-memory="'+m.id+'">Forget</button></div>').join(''):'<div class="empty">No memory notes saved.</div>';}catch(e){$('memoryList').innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}}
$('memoryForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/memory',{method:'POST',body:JSON.stringify({text:$('memoryInput').value})});$('memoryInput').value='';await loadMemory();await loadStatus();toast('Memory saved');}catch(e){toast(e.message);}});
$('memoryList').addEventListener('click',async e=>{const id=e.target.dataset.deleteMemory;if(!id)return;try{await api('/memory/'+id,{method:'DELETE'});await loadMemory();await loadStatus();toast('Memory deleted');}catch(err){toast(err.message);}});
async function loadApprovals(){try{const items=await api('/approvals');$('approvalList').innerHTML=items.length?items.map(a=>'<div class="list-row"><div class="list-main"><strong>'+escapeHtml(a.action)+'</strong><small>'+escapeHtml(date(a.createdAt))+' · '+escapeHtml(a.status)+(a.decidedAt?' · decided '+escapeHtml(date(a.decidedAt)):'')+'</small></div>'+(a.status==='pending'?'<button data-approval="'+a.id+'" data-decision="approved">Approve</button><button class="danger" data-approval="'+a.id+'" data-decision="rejected">Reject</button>':'<span class="tag '+(a.status==='approved'?'good':'pending')+'">'+escapeHtml(a.status.toUpperCase())+'</span>')+'</div>').join(''):'<div class="empty">No approval requests yet.</div>';}catch(e){$('approvalList').innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}}
$('approvalForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/approvals',{method:'POST',body:JSON.stringify({action:$('approvalInput').value})});$('approvalInput').value='';await loadApprovals();await loadStatus();toast('Approval request recorded');}catch(e){toast(e.message);}});
$('approvalList').addEventListener('click',async e=>{const id=e.target.dataset.approval,decision=e.target.dataset.decision;if(!id||!decision)return;try{await api('/approvals/'+id+'/decision',{method:'POST',body:JSON.stringify({decision})});await loadApprovals();await loadStatus();toast('Decision recorded. No external action was executed.');}catch(err){toast(err.message);}});
async function loadActivity(){try{const items=await api('/activity');$('activityList').innerHTML=items.length?items.map(a=>'<div class="list-row"><span class="status-dot"></span><div class="list-main"><strong>'+escapeHtml(a.type)+'</strong><small>'+escapeHtml(a.detail)+' · '+escapeHtml(date(a.at))+'</small></div></div>').join(''):'<div class="empty">No recent activity.</div>';}catch(e){$('activityList').innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}}
async function loadRuntime(){try{const s=await api('/status');$('runtimeInfo').innerHTML='Service: '+escapeHtml(s.name)+'<br>Version: '+escapeHtml(s.version)+'<br>Default provider: '+escapeHtml(s.provider)+'<br>OpenAI configured: '+(s.providers.openai?'YES':'NO')+'<br>Anthropic configured: '+(s.providers.anthropic?'YES':'NO')+'<br>API authentication: '+(s.safety.authEnabled?'ON':'OFF (local development)')+'<br>External actions: DISABLED<br>WhatsApp: NOT CONNECTED';$('accessToken').value=token();}catch(e){$('runtimeInfo').textContent=e.message;}}
$('saveToken').addEventListener('click',async()=>{const v=$('accessToken').value.trim();if(v)sessionStorage.setItem(tokenKey,v);else sessionStorage.removeItem(tokenKey);toast('Token stored for this browser tab session.');await loadStatus();await loadRuntime();});
$('tokenButton').addEventListener('click',()=>{showView('settings');$('accessToken').focus();});
$('refreshBtn').addEventListener('click',async()=>{await loadStatus();toast('Status refreshed');});
$('sidebar').id='sidebar';
(async()=>{await loadStatus();if(token())$('accessToken').value=token();})();
