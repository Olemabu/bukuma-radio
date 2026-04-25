// ── State ────────────────────────────────────────────────────────────────────────────
let ws = null;
let serverState = {};
let seekDragging = false;
let micStream, micAudioCtx, micSource, micWorklet;

// ── Chambers ─────────────────────────────────────────────────────────────────────────
function switchChamber(chamberId) {
  // Update Buttons
  document.querySelectorAll('.chamber-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`btn-${chamberId}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Update Chambers
  document.querySelectorAll('.chamber').forEach(ch => ch.classList.remove('active'));
  const activeCh = document.getElementById(`chamber-${chamberId}`);
  if (activeCh) activeCh.classList.add('active');
  
  localStorage.setItem('activeChamber', chamberId);
  console.log(`[CHAMBER] Switched to ${chamberId.toUpperCase()}`);
}

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
  if (playBtn) playBtn.innerHTML = data.isPlaying ? '■ STOP' : '▶ PLAY';

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

  // Next Track Label
  const nextTrackLabel = document.getElementById('nextTrackLabel');
  if (nextTrackLabel) {
    if (data.queue && data.queue.length > 0) {
        const nextIdx = (data.currentMusicIdx + 1) % data.queue.length;
        const next = data.queue[nextIdx];
        nextTrackLabel.textContent = next ? `${next.artist} - ${next.title}` : 'END OF QUEUE';
    } else {
        nextTrackLabel.textContent = 'NO QUEUE';
    }
  }

  // Playback Mode Buttons Sync
  const repeatBtn = document.getElementById('repeatBtn');
  if (repeatBtn) {
    repeatBtn.classList.toggle('active-mode', data.playbackMode !== 'LINEAR');
    if (data.playbackMode === 'REPEAT_ONE') {
        repeatBtn.textContent = '🔂 LOOP: ONE';
    } else if (data.playbackMode === 'REPEAT_ALL') {
        repeatBtn.textContent = '🔁 LOOP: ALL';
    } else {
        repeatBtn.textContent = '🔁 LOOP: OFF';
    }
  }

  const shuffleBtn = document.getElementById('shuffleBtn');
  if (shuffleBtn) {
    shuffleBtn.classList.toggle('active-mode', data.shuffle);
    shuffleBtn.textContent = data.shuffle ? '🔀 SHUFFLE: ON' : '🔀 SHUFFLE: OFF';
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
  }

  // News
  if (data.newsLibrary) renderNewsLibrary(data.newsLibrary, data.activeOverlayId);
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

function playStation() {
    if (serverState.isPlaying) {
        fetch('/api/stop', { method: 'POST' }).catch(console.error);
    } else {
        fetch('/api/play', { method: 'POST' }).catch(console.error);
    }
}
function skipTrack()   { fetch('/api/skip', { method: 'POST' }).catch(console.error); }

function togglePlaybackMode() {
    const modes = ['LINEAR', 'REPEAT_ONE', 'REPEAT_ALL'];
    let nextIdx = (modes.indexOf(serverState.playbackMode) + 1) % modes.length;
    const nextMode = modes[nextIdx];
    fetch('/api/playback-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: nextMode })
    });
}

function toggleShuffle() {
    fetch('/api/shuffle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shuffle: !serverState.shuffle })
    });
}

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
    updateMicButton(true);
  } catch(err) { alert('Mic blocked: ' + err.message); stopMic(); }
}

function updateMicButton(isLive) {
  const btn = document.querySelector('.big-mic-btn');
  const cutBtn = document.querySelector('.btn-danger[onclick*="stopMic"]');
  if (!btn) return;
  if (isLive) {
    btn.textContent = '🎙 CHANNEL LIVE';
    btn.classList.add('live');
    if (cutBtn) cutBtn.style.display = 'block';
  } else {
    btn.textContent = '🎙 OPEN BROADCAST CHANNEL';
    btn.classList.remove('live');
    if (cutBtn) cutBtn.style.display = 'none';
  }
}

function stopMic() {
  if (micWorklet) { try { micWorklet.disconnect(); } catch(e) {} micWorklet = null; }
  if (micSource)  { try { micSource.disconnect();  } catch(e) {} micSource  = null; }
  if (micAudioCtx){ try { micAudioCtx.close();     } catch(e) {} micAudioCtx = null; }
  if (micStream)  { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  setMic('OFF');
  updateMicButton(false);
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

async function handleFileUpload(input) {
  if (!input.files.length) return;
  const formData = new FormData();
  Array.from(input.files).forEach(f => formData.append('tracks', f));
  showUploadModal('Transmitting Music…', 30);
  await fetch('/api/upload', { method: 'POST', body: formData });
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

function renderNewsLibrary(news, activeId) {
  const list = document.getElementById('newsList');
  if (!list) return;
  list.innerHTML = news.map(n => {
    const isActive = n.id === activeId;
    return `
      <div class="news-item ${isActive ? 'playing' : ''}">
        <div class="news-title">${escHtml(n.title)}</div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-sm" onclick="openScheduleModal('${n.id}', '${escAttr(n.title)}')">🕓</button>
          <button class="btn btn-sm ${isActive ? 'btn-stop' : 'btn-play'}" onclick="${isActive ? 'stopBroadcast()' : `broadcastNews('${n.id}')`}">${isActive ? '⏹' : '📢'}</button>
        </div>
      </div>
    `;
  }).join('');
}

// ── Modals / Helpers ────────────────────────────────────────────────────────────────
function showUploadModal(txt, pct) { 
    document.getElementById('uploadStatusText').textContent = txt; 
    document.getElementById('uploadProgressFill').style.width = pct + '%'; 
    const modal = document.getElementById('uploadModal');
    if(modal) modal.classList.add('open'); 
}
function updateUploadModal(txt, pct) {
    document.getElementById('uploadStatusText').textContent = txt; 
    document.getElementById('uploadProgressFill').style.width = pct + '%';
}
function hideUploadModal() { 
  const modal = document.getElementById('uploadModal');
  if(modal) modal.classList.remove('open'); 
}

function playTrackById(id) { fetch('/api/play-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
function deleteTrack(id)   { if(confirm('Delete track?')) fetch('/api/delete-track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }

function formatTime(s) { if(!s||isNaN(s)) return '0:00'; const m=Math.floor(s/60), sec=Math.floor(s%60); return `${m}:${sec.toString().padStart(2,'0')}`; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s).replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

window.addEventListener('load', () => {
  const lastChamber = localStorage.getItem('activeChamber') || 'ops';
  switchChamber(lastChamber);
  updateMicButton(false);
  initStatusWS();
});
