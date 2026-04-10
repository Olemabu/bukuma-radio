// ── DOM refs ──────────────────────────────────────────────────────────────────────────────
const DE = {
  audio:      document.getElementById('audioPlayer'),
  fileInput:  document.getElementById('localFileInput'),
  title:      document.getElementById('currTitle'),
  artist:     document.getElementById('currArtist'),
  dialTitle:  document.getElementById('dialTitle'),
  btnPlay:    document.getElementById('btnPlayPause'),
  playIcon:   document.getElementById('playIcon'),
  btnNext:    document.getElementById('btnNext'),
  btnPrev:    document.getElementById('btnPrev'),
  navRadio:   document.getElementById('navRadio'),
  navLocal:   document.getElementById('navLocal'),
  dial:       document.getElementById('mainDial'),
  canvas:     document.getElementById('waveformCanvas')
};

// ── Canvas ──────────────────────────────────────────────────────────────────────────────
const ctx = DE.canvas.getContext('2d');
function resizeCanvas() { DE.canvas.width = window.innerWidth; DE.canvas.height = 160; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── State ──────────────────────────────────────────────────────────────────────────────
let audioCtx, analyser, dataArray;
let isVisualizerInit = false;
let appMode    = 'radio';
let isPlaying  = false;
let localPlaylist = [];
let localIndex    = 0;
let ws = null;
let lastRadioTrack  = { title: 'AWAITING SIGNAL...', artist: 'Radio Mode' };
let serverIsPlaying = true; // optimistic: assume server is on-air until told otherwise
let currentStreamUrl = '';
let wsRetryDelay = 3000;
let stallTimer  = null;
let radioRetryDelay = 2000; // exponential back-off for stream errors

// ── WebSocket ────────────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');

  ws.onopen = () => {
    wsRetryDelay = 3000;
    ws.send(JSON.stringify({ action: 'getStatus' }));
  };

  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'status' || d.type === 'nowPlaying') {
        const track = d.currentTrack || d.track;
        lastRadioTrack = {
          title:  track ? track.title  : 'STATION IDLE',
          artist: track ? track.artist : 'Awaiting Signal'
        };

        // Update server playing state (used to know if stream is live)
        if (typeof d.isPlaying === 'boolean') serverIsPlaying = d.isPlaying;

        // Server stopped: reflect in UI only — never touch audio element from WS handler
        if (d.isPlaying === false && appMode === 'radio' && isPlaying) {
          // Server stopped broadcasting — update UI to show idle but keep connection
          // so when server resumes, the stream automatically recovers
          isPlaying = false;
          updateUI();
        }
        if (appMode === 'radio') updateUI();
      }
    } catch(e) {}
  };

  ws.onclose = () => {
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 1.5, 30000);
  };
}

// ── UI ───────────────────────────────────────────────────────────────────────────────────
function updateUI() {
  if (appMode === 'radio') {
    DE.title.textContent  = lastRadioTrack.title;
    DE.artist.textContent = lastRadioTrack.artist;
    DE.dialTitle.innerHTML = 'Agum Bukuma<br>Radio';
  } else {
    if (!localPlaylist.length) {
      DE.title.textContent  = 'No Music Loaded';
      DE.artist.textContent = 'Tap to select files';
      DE.dialTitle.innerHTML = 'Local<br>Library';
    } else {
      const title = localPlaylist[localIndex].name.replace(/\.[^/.]+$/, '');
      DE.title.textContent  = title;
      DE.artist.textContent = 'Local Device';
      DE.dialTitle.innerHTML = title.substring(0, 15) + '...';
    }
  }
  DE.playIcon.setAttribute('name', isPlaying ? 'pause' : 'play');
  DE.btnPlay.classList.toggle('playing', isPlaying);
  DE.dial.classList.toggle('alive', isPlaying);
            }

// ── Visualizer ─────────────────────────────────────────────────────────────────────────────
function initVisualizer() {
  if (isVisualizerInit) return;
  try {
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    const src = audioCtx.createMediaElementSource(DE.audio);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    isVisualizerInit = true;
    drawWave();
  } catch(e) { console.warn('[VIZ] Could not init visualizer:', e.message); }
}

function playClick() {
  initVisualizer();
  if (!audioCtx) return;
  audioCtx.resume().then(() => {
    if (audioCtx.state === 'suspended') return;
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.04);
    g.gain.setValueAtTime(0.5, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.04);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.05);
  });
}

document.querySelectorAll('button, .center-dial').forEach(b => b.addEventListener('pointerdown', playClick));

function drawWave() {
  requestAnimationFrame(drawWave);
  ctx.clearRect(0, 0, DE.canvas.width, DE.canvas.height);
  if (!isPlaying || !isVisualizerInit) return;
  analyser.getByteFrequencyData(dataArray);
  const bw = (DE.canvas.width / dataArray.length) * 2;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const bh = (dataArray[i] / 255) * DE.canvas.height * 0.8;
    ctx.fillStyle = 'rgb(0,' + (180 + dataArray[i] / 3) + ',255)';
    ctx.fillRect(x, (DE.canvas.height - bh) / 2, bw - 1, bh);
    x += bw;
  }
}

// ── Playback ─────────────────────────────────────────────────────────────────────────────
// Connect to the live radio stream — call this to begin listening
function startRadioStream() {
  const url = '/api/stream?' + Date.now();
  DE.audio.src = url;
  currentStreamUrl = url;
  radioRetryDelay = 2000; // reset back-off
  DE.audio.play().catch(() => {});
}

function togglePlayback() {
  if (isPlaying) {
    DE.audio.pause();
    if (appMode === 'radio') { DE.audio.src = ''; currentStreamUrl = ''; }
    isPlaying = false;
  } else {
    if (appMode === 'radio') {
      startRadioStream();
    } else {
      if (!localPlaylist.length) { DE.fileInput.click(); return; }
      if (!DE.audio.src) loadLocalTrack();
      DE.audio.play().catch(() => {});
    }
    isPlaying = true;
  }
  updateUI();
}

function loadLocalTrack() {
  if (!localPlaylist.length) return;
  DE.audio.src = URL.createObjectURL(localPlaylist[localIndex]);
  updateUI();
}

function skipLocal(dir) {
  if (appMode !== 'local' || !localPlaylist.length) return;
  localIndex = dir === 'next'
    ? (localIndex + 1) % localPlaylist.length
    : (localIndex - 1 + localPlaylist.length) % localPlaylist.length;
  loadLocalTrack();
  if (isPlaying) DE.audio.play().catch(() => {});
}

// ── Audio events ──────────────────────────────────────────────────────────────────────────
// Stream error handler with exponential back-off
DE.audio.addEventListener('error', () => {
  if (appMode !== 'radio' || !isPlaying) return;
  setTimeout(() => {
    if (appMode === 'radio' && isPlaying) startRadioStream();
  }, radioRetryDelay);
  radioRetryDelay = Math.min(radioRetryDelay * 1.5, 15000);
});

// FIX: 'ended' on radio stream means server dropped — reconnect, don't stay silent
DE.audio.addEventListener('ended', () => {
  if (appMode === 'local') { skipLocal('next'); return; }
  // Radio mode: server finished a track or restarted — reconnect after short delay
  if (appMode === 'radio' && isPlaying) {
    setTimeout(() => {
      if (appMode === 'radio' && isPlaying) startRadioStream();
    }, radioRetryDelay);
  }
});

// Stall detection: if buffering for 10 s with no data, reconnect
DE.audio.addEventListener('waiting', () => {
  if (appMode !== 'radio' || !isPlaying) return;
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (appMode === 'radio' && isPlaying && DE.audio.readyState < 3) startRadioStream();
  }, 10000);
});

DE.audio.addEventListener('playing', () => {
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  radioRetryDelay = 2000; // reset back-off on successful play
});

// ── Controls ─────────────────────────────────────────────────────────────────────────────
DE.btnPlay.addEventListener('click', () => { initVisualizer(); setTimeout(togglePlayback, 50); });
DE.btnNext.addEventListener('click', () => { initVisualizer(); if (appMode === 'local') setTimeout(() => skipLocal('next'), 50); });
DE.btnPrev.addEventListener('click', () => { if (appMode === 'local') setTimeout(() => skipLocal('prev'), 50); });

DE.navRadio.addEventListener('click', () => {
  if (appMode === 'radio') return;
  // Switch from local to radio: stop local audio
  if (isPlaying) { DE.audio.pause(); DE.audio.src = ''; isPlaying = false; }
  appMode = 'radio';
  DE.navRadio.classList.add('active');
  DE.navLocal.classList.remove('active');
  // Auto-start the radio stream
  startRadioStream();
  isPlaying = true;
  updateUI();
});

DE.navLocal.addEventListener('click', () => {
  if (appMode === 'local') { DE.fileInput.click(); return; }
  if (isPlaying) togglePlayback();
  appMode = 'local';
  DE.navLocal.classList.add('active');
  DE.navRadio.classList.remove('active');
  if (!localPlaylist.length) DE.fileInput.click();
  updateUI();
});

DE.fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files).filter(f => f.type.startsWith('audio/'));
  if (files.length) {
    localPlaylist = files; localIndex = 0;
    loadLocalTrack();
    if (!isPlaying) togglePlayback();
  }
});

DE.dial.addEventListener('click', () => {
  DE.btnPlay.classList.add('active');
  setTimeout(() => { DE.btnPlay.classList.remove('active'); togglePlayback(); }, 150);
});

// ── Init ───────────────────────────────────────────────────────────────────────────────────
connectWS();
updateUI();

// Unlock audio context on first touch (required by mobile browsers)
document.body.addEventListener('touchstart', () => {
  if (!window.audioEnabled) { DE.audio.load(); window.audioEnabled = true; }
}, { once: true });
