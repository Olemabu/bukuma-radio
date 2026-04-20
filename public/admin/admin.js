// ── State ────────────────────────────────────────────────────────────────────────────
let ws = null;
let serverState = {};
let seekDragging = false;
let micStream, micAudioCtx, micSource, micWorklet;

// ── WebSocket ────────────────────────────────────────────────────────────────────────
function initStatusWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  
  ws.onopen  = () => { console.log('[WS] Connected'); document.getElementById('wsStatus').className = 'ws-indicator connected'; document.getElementById('wsStatus').textContent = 'CONNECTED' };
  ws.onclose = () => { console.log('[WS] Retrying…'); document.getElementById('wsStatus').className = 'ws-indicator'; document.getElementById('wsStatus').textContent = 'RETRYING…'; setTimeout(initStatusWS, 3000); };
  
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'status') {
        serverState = d;
        updateOnAirDisplay(d);
      }
    } catch(err) {}
  };
}

// ── Display Update (The Heart of the Dashboard) ──────────────────────────────────────
function updateOnAirDisplay(data) {
  // Status pill
  const pill  = document.getElementById('statusPill');
  const label = document.getElementById('statusLabel');
  if (data.isPlaying) {
    pill.className  = 'status-pill on-air';
    label.textContent = 'ON AIR';
  } else {
    pill.className  = 'status-pill offline';
    label.textContent = 'OFFLINE';
  }

  // Play button label
  const playBtn = document.getElementById('playBtn');
  if (playBtn) playBtn.innerHTML = data.isPlaying ? '■ STOPPING' : '▶ PLAYING';

  // Hub Info
  const micOn = (data.micMode === 'SOLO' || data.micMode === 'DUCK');
  const overlayOn = data.overlayActive;

  const titleEl  = document.getElementById('trackTitle');
  const artistEl = document.getElementById('trackArtist');
  const artEl    = document.getElementById('trackArt');

  if (overlayOn) {
    titleEl.textContent  = data.overlayTitle || 'NEWS BROADCAST';
    artistEl.textContent = 'BUKUMA NEWS NETWORK';
    artEl.textContent    = '📢';
    artistEl.style.color = 'var(--danger)';
  } else if (micOn && data.onAirMessage) {
    titleEl.textContent  = data.onAirMessage;
    artistEl.textContent = 'LIVE BROADCAST';
    artEl.textContent    = '🎙';
    artistEl.style.color = 'var(--accent)';
  } else if (micOn) {
    titleEl.textContent  = 'LIVE ON AIR';
    artistEl.textContent = 'BROADCASTING';
    artEl.textContent    = '🎙';
    artistEl.style.color = 'var(--accent)';
  } else if (data.currentTrack) {
    titleEl.textContent  = data.currentTrack.title  || 'Unknown Track';
    artistEl.textContent = (data.currentTrack.artist || 'Community Radio').toUpperCase();
    artEl.textContent    = '🎵';
    artistEl.style.color = 'var(--accent)';
  } else {
    titleEl.textContent  = 'STATION STANDBY';
    artistEl.textContent = 'AWAITING SIGNAL';
    artEl.textContent    = '📻';
  }

  // Seek bar
  if (!seekDragging && data.duration > 0) {
    const pct = (data.elapsedTime / data.duration) * 100;
    const seekBar = document.getElementById('seekBar');
    if (seekBar) {
        seekBar.value = pct;
        document.getElementById('seekStart').textContent = formatTime(data.elapsedTime);
        document.getElementById('seekEnd').textContent   = formatTime(data.duration);
    }
  }

  // Stats / Metrics
  const vu  = Math.round(data.listenerStats ? data.listenerStats.vu      : 0);
  const lat = data.listenerStats ? data.listenerStats.latency : 0;
  
  if (document.getElementById('vuDisplay')) document.getElementById('vuDisplay').textContent  = vu + '%';
  if (document.getElementById('latDisplay')) document.getElementById('latDisplay').textContent = lat + 'ms';
  if (document.getElementById('micModeDisplay')) document.getElementById('micModeDisplay').textContent = data.micMode || 'OFF';
  if (document.getElementById('volDisplay')) document.getElementById('volDisplay').textContent = (data.volume || 0) + '%';

  // VU meter (mic feedback)
  const micBar = document.getElementById('micVU');
  if (micBar) micBar.style.width = vu + '%';

  // Sliders
  syncSlider('volSlider',  'volVal',  data.volume || 80,                    v => v + '%');
  syncSlider('newsVolSlider', 'newsVolVal', data.newsVolume || 100, v => v + '%');
  syncSlider('duckSlider', 'duckVal', data.micDuckLevel !== undefined ? data.micDuckLevel : 30, v => v + '%');
  syncSlider('gateSlider', 'gateVal', Math.round((data.micGate || 0.05) * 100), v => (v / 100).toFixed(2));

  // Mic mode buttons
  updateMicModeButtons(data.micMode || 'OFF');

  // Library
  if (data.library) {
    renderLibrary(data.library, data.currentTrack);
    renderPlaylistSelector(data.library);
  }

  // News
  if (data.newsLibrary) renderNewsLibrary(data.newsLibrary, data.overlayActive);
  if (document.getElementById('newsControlBar')) document.getElementById('newsControlBar').style.display = overlayOn ? 'flex' : 'none';
  
  updateRecorderUI(data.isRecording);
  if (data.schedule) renderSchedule(data.schedule);
}

// ── Mic Actions ──────────────────────────────────────────────────────────────────────
function updateMicModeButtons(mode) {
  const modes = ['micOff', 'micDuck', 'micSolo'];
  modes.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = 'mode-btn';
      if (id === 'micOff' && mode === 'OFF') el.classList.add('active-off');
      if (id === 'micDuck' && mode === 'DUCK') el.classList.add('active-duck');
      if (id === 'micSolo' && mode === 'SOLO') el.classList.add('active-solo');
  });
}

function updateRecorderUI(isRecording) {
  const btn = document.getElementById('recordNewsBtn');
  const ind = document.getElementById('recordIndicator');
  const lbl = document.getElementById('recordStatus');
  if (!btn) return;
  
  if (isRecording) {
    btn.textContent = '⏹ STOP & MASTER';
    btn.style.background = 'var(--danger)';
    if (ind) { ind.style.opacity = '1'; ind.style.animation = 'pulse 1s infinite'; }
    if (lbl) lbl.textContent = 'RECORDING LIVE...';
  } else {
    btn.textContent = '⏺ RECORD REPORT';
    btn.style.background = '';
    if (ind) { ind.style.opacity = '0.2'; ind.style.animation = 'none'; }
    if (lbl) lbl.textContent = 'Mic ready...';
  }
}

// ── Sliders / Transport ──────────────────────────────────────────────────────────────
function syncSlider(sliderId, valId, serverVal, formatter) {
  const slider = document.getElementById(sliderId);
  const valEl  = document.getElementById(valId);
  if (slider && valEl && document.activeElement !== slider) {
    slider.value = serverVal;
    valEl.textContent = formatter(serverVal);
  }
}

function playStation() { fetch('/api/play', { method: 'POST' }).catch(console.error); }
function stopStation() { fetch('/api/stop', { method: 'POST' }).catch(console.error); }
function skipTrack()   { fetch('/api/skip', { method: 'POST' }).catch(console.error); }

function onSeekInput(pct) {
  seekDragging = true;
  const dur = serverState.duration || 0;
  const elapsed = (pct / 100) * dur;
  document.getElementById('seekStart').textContent = formatTime(elapsed);
}

function onSeekCommit(pct) {
  seekDragging = false;
  const dur = serverState.duration || 0;
  if (dur <= 0) return;
  const seconds = (pct / 100) * dur;
  fetch('/api/seek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds })
  }).catch(console.error);
}

function setVolume(val) {
  if (document.getElementById('volVal')) document.getElementById('volVal').textContent = val + '%';
  fetch('/api/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: parseInt(val) }) });
}

function setNewsVolume(val) {
  if (document.getElementById('newsVolVal')) document.getElementById('newsVolVal').textContent = val + '%';
  fetch('/api/news/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: parseInt(val) }) });
}

function setDuckLevel(val) {
  if (document.getElementById('duckVal')) document.getElementById('duckVal').textContent = val + '%';
  fetch('/api/mic-duck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duckLevel: parseInt(val) }) });
}

function setGateLevel(val) {
  const gate = (parseInt(val) / 100).toFixed(2);
  if (document.getElementById('gateVal')) document.getElementById('gateVal').textContent = gate;
  fetch('/api/mic-gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gate: parseFloat(gate) }) });
}

function setMic(mode) {
  fetch('/api/mic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
}

// ── Mic Capture Engine ───────────────────────────────────────────────────────────────
async function startMic() {
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 } });
    micAudioCtx = new AudioContext({ sampleRate: 48000 });
    micSource   = micAudioCtx.createMediaStreamSource(micStream);

    const proc = `class MicProc extends AudioWorkletProcessor { process(inputs){ const ch=inputs[0][0]; if(!ch||!ch.length)return true; const b=new Int16Array(ch.length); for(let i=0;i<ch.length;i++)b[i]=Math.max(-32768,Math.min(32767,Math.round(ch[i]*32767))); this.port.postMessage(b.buffer,[b.buffer]); return true; } } registerProcessor('mic-proc', MicProc);`;
    const blob = new Blob([proc], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await micAudioCtx.audioWorklet.addModule(url);
    micWorklet = new AudioWorkletNode(micAudioCtx, 'mic-proc');
    micWorklet.port.onmessage = e => { if(ws && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
    micSource.connect(micWorklet);
    micWorklet.connect(micAudioCtx.destination);
    console.log('[MIC] Live');
  } catch(err) { alert('Mic blocked: ' + err.message); stopMic(); }
}

function stopMic() {
  if (micWorklet) { try { micWorklet.disconnect(); } catch(e) {} micWorklet = null; }
  if (micSource)  { try { micSource.disconnect();  } catch(e) {} micSource  = null; }
  if (micAudioCtx){ try { micAudioCtx.close();     } catch(e) {} micAudioCtx = null; }
  if (micStream)  { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  setMic('OFF');
}

// ── News / On-Air Message ────────────────────────────────────────────────────────────
function setOnAirMessage() {
  const msg = document.getElementById('oamInput').value.trim();
  fetch('/api/on-air-message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
}

function clearOnAirMessage() {
  document.getElementById('oamInput').value = '';
  fetch('/api/on-air-message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '' }) });
}

async function handleNewsUpload(input) {
  if (!input.files.length) return;
  const formData = new FormData();
  Array.from(input.files).forEach(f => formData.append('tracks', f));
  showUploadModal('Broadcasting News…', 30);
  await fetch('/api/upload?type=news', { method: 'POST', body: formData });
  updateUploadModal('✓ Success', 100);
  setTimeout(hideUploadModal, 1500);
  input.value = '';
}

function toggleNewsRecording() {
    fetch('/api/news/record', { method: 'POST' }).catch(console.error);
}

function broadcastNews(id) { fetch('/api/news/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
function stopBroadcast()   { fetch('/api/news/stop', { method: 'POST' }); }

// ── Library Rendering ───────────────────────────────────────────────────────────────
function renderLibrary(library, current) {
  const list = document.getElementById('trackList');
  if (!list) return;
  document.getElementById('libCount').textContent = library.length + ' tracks';
  list.innerHTML = library.map((t, i) => {
    const isPlaying = current && current.id === t.id;
    return `
      <div class="track-card ${isPlaying ? 'playing' : ''}" ondblclick="playTrackById('${t.id}')">
        <div class="track-meta">
          <div class="t-main">${escHtml(t.title)}</div>
          <div class="t-sub">${escHtml(t.artist)}</div>
        </div>
        <div style="display:flex; gap:8px;">
            <button class="btn btn-sm" onclick="playTrackById('${t.id}')">▶</button>
            <button class="btn btn-sm btn-danger" onclick="deleteTrack('${t.id}')">✕</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderNewsLibrary(news, active) {
  const list = document.getElementById('newsList');
  if (!list) return;
  list.innerHTML = news.map(n => `
    <div class="news-item">
      <div class="news-title">${escHtml(n.title)}</div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-sm" onclick="openScheduleModal('${n.id}', '${escAttr(n.title)}')">🕓</button>
        <button class="btn btn-sm ${active ? 'btn-stop' : 'btn-play'}" onclick="${active ? 'stopBroadcast()' : `broadcastNews('${n.id}')`}">${active ? '⏹' : '📢'}</button>
      </div>
    </div>
  `).join('');
}

// ── Modals / Helpers ────────────────────────────────────────────────────────────────
function showUploadModal(txt, pct) { 
    document.getElementById('uploadStatusText').textContent = txt; 
    document.getElementById('uploadProgressFill').style.width = pct + '%'; 
    document.getElementById('uploadModal').classList.add('open'); 
}
function updateUploadModal(txt, pct) {
    document.getElementById('uploadStatusText').textContent = txt; 
    document.getElementById('uploadProgressFill').style.width = pct + '%';
}
function hideUploadModal() { document.getElementById('uploadModal').classList.remove('open'); }

function playTrackById(id) { fetch('/api/play-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
function deleteTrack(id)   { if(confirm('Delete track?')) fetch('/api/delete-track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }

function formatTime(s) { if(!s||isNaN(s)) return '0:00'; const m=Math.floor(s/60), sec=Math.floor(s%60); return `${m}:${sec.toString().padStart(2,'0')}`; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s).replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

window.addEventListener('load', initStatusWS);

// ── Schedule Management ──────────────────────────────────────────────────────────
function renderSchedule(schedule) {
  const list = document.getElementById('scheduleList');
  if (!list || !schedule) return;
  if (!schedule.length) {
    list.innerHTML = '<div style="padding:10px; text-align:center; opacity:0.5;">No items scheduled</div>';
    return;
  }
  const dayMap = { mon:'Monday', tue:'Tuesday', wed:'Wednesday', thu:'Thursday', fri:'Friday', sat:'Saturday', sun:'Sunday' };
  list.innerHTML = schedule.map(s => {
    const newsItem = serverState.newsLibrary ? serverState.newsLibrary.find(n => n.id === s.newsId) : null;
    return `
      <div style="display:flex; justify-content:space-between; background:rgba(255,255,255,0.03); padding:8px 10px; border-radius:6px; border-left:2px solid var(--accent3); margin-bottom:4px;">
        <div style="flex:1;">
          <div style="font-weight:700; color:var(--text); font-size:11px;">${s.time} - ${dayMap[s.dayOfWeek]}</div>
          <div style="font-size:9px; opacity:0.7;">${newsItem ? escHtml(newsItem.title) : 'Archived News'}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openScheduleModal(newsId, title) {
  const modal = document.createElement('div');
  modal.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); backdrop-filter:blur(10px); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;";
  modal.innerHTML = `
    <div class="card" style="width:100%; max-width:400px; padding:25px; border:1px solid var(--accent);">
      <div class="card-title">Schedule Broadcast</div>
      <div style="font-size:12px; color:var(--text-dim); margin-bottom:20px;">Item: ${title}</div>
      
      <label style="display:block; font-size:10px; color:var(--accent); margin-bottom:5px;">DAY OF WEEK</label>
      <select id="schDay" class="btn" style="width:100%; margin-bottom:15px; background:rgba(255,255,255,0.05); text-align:left; padding:10px;">
        <option value="mon">Monday</option><option value="tue">Tuesday</option><option value="wed">Wednesday</option>
        <option value="thu">Thursday</option><option value="fri">Friday</option><option value="sat">Saturday</option>
        <option value="sun">Sunday</option>
      </select>

      <label style="display:block; font-size:10px; color:var(--accent); margin-bottom:5px;">TIME (24h)</label>
      <input type="time" id="schTime" class="btn" value="12:00" style="width:100%; margin-bottom:25px; background:rgba(255,255,255,0.05); text-align:left; padding:10px;">

      <div style="display:flex; gap:10px;">
        <button class="btn" style="flex:1;" onclick="this.closest('div').parentElement.parentElement.remove()">CANCEL</button>
        <button class="btn btn-play" style="flex:1;" id="saveSchBtn">SET SCHEDULE</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#saveSchBtn').onclick = () => {
    const day = modal.querySelector('#schDay').value;
    const time = modal.querySelector('#schTime').value;
    fetch('/api/news/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsId, day, time })
    }).then(() => modal.remove()).catch(console.error);
  };
}

function clearSchedule() {
  if (confirm('Clear all scheduled broadcasts?')) fetch('/api/news/schedule/clear', { method: 'POST' });
}

// ── Playlist Management ──────────────────────────────────────────────────────
function openPlaylistModal() { document.getElementById('playlistModal').classList.add('open'); }
function closePlaylistModal() { document.getElementById('playlistModal').classList.remove('open'); }

function renderPlaylistSelector(library) {
  const container = document.getElementById('plTrackSelector');
  if (!container) return;
  container.innerHTML = library.map(t => `
    <div style="display:flex; align-items:center; gap:10px; padding:6px; border-bottom:1px solid rgba(255,255,255,0.05);">
      <input type="checkbox" class="pl-track-check" value="${t.id}" style="width:16px; height:16px;">
      <div style="font-size:11px;">${escHtml(t.title)} - <span style="color:var(--text-dim)">${escHtml(t.artist)}</span></div>
    </div>
  `).join('');
}

function savePlaylist() {
  const name = document.getElementById('plName').value.trim();
  const checks = document.querySelectorAll('.pl-track-check:checked');
  const trackIds = Array.from(checks).map(c => c.value);
  if (!name || !trackIds.length) return alert('Enter name and select tracks');
  fetch('/api/playlists/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, trackIds })
  }).then(r => r.json()).then(res => { if (res.ok) { alert('Playlist created!'); closePlaylistModal(); } });
}
