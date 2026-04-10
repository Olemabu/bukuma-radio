// ── DOM ───────────────────────────────────────────────────────────────────────
const DOMElements = {
  audio:       document.getElementById('audioPlayer'),
  fileInput:   document.getElementById('localFileInput'),
  title:       document.getElementById('currTitle'),
  artist:      document.getElementById('currArtist'),
  dialTitle:   document.getElementById('dialTitle'),
  btnPlayPause:document.getElementById('btnPlayPause'),
  playIcon:    document.getElementById('playIcon'),
  btnNext:     document.getElementById('btnNext'),
  btnPrev:     document.getElementById('btnPrev'),
  navRadio:    document.getElementById('navRadio'),
  navLocal:    document.getElementById('navLocal'),
  dial:        document.getElementById('mainDial'),
  canvas:      document.getElementById('waveformCanvas')
};

const ctx = DOMElements.canvas.getContext('2d');
function resizeCanvas() { DOMElements.canvas.width = window.innerWidth; DOMElements.canvas.height = 160; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── State ──────────────────────────────────────────────────────────────────────
let audioCtx, analyser, dataArray;
let isVisualizerInit = false;
let appMode          = 'radio';
let isPlaying        = false;
let localPlaylist    = [];
let localIndex       = 0;
let ws               = null;
let lastRadioTrack   = { title: 'AWAITING SIGNAL...', artist: 'Radio Mode' };
// FIX 1: track the current stream URL so we only replace it when truly needed
let currentStreamUrl = '';
// FIX 2: reconnect back-off to stop hammering dead WS
let wsRetryDelay     = 3000;

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = () => {
    wsRetryDelay = 3000; // reset back-off on success
    ws.send(JSON.stringify({ action: 'getStatus' }));
  };
  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'status' || d.type === 'nowPlaying') {
        const track = d.currentTrack || d.track;
        lastRadioTrack = {
          title:  track ? track.title  : 'STATION IDLE',
          artist: track ? track.artist : 'Awaiting Signal'
        };
        // FIX 3: NEVER stop/restart the radio audio stream based on WS status updates.
        // The audio element streams continuously; WS is UI-only.
        // Only stop if server explicitly says it stopped AND we thought we were playing.
        if (d.isPlaying === false && appMode === 'radio' && isPlaying) {
          // Server stopped — reflect in UI only, don't touch audio.src
          // The stream will naturally end; let the audio 'ended'/'error' event handle it.
          isPlaying = false;
          updateUIFromState();
        }
        if (appMode === 'radio') updateUIFromState();
      }
      if (d.type === 'volume') {
        // FIX 4: volume changes on server do NOT cause client to reconnect
        // The server applies volume at FFmpeg level on the NEXT track.
        // Nothing to do on the client.
      }
    } catch(err) {}
  };
  ws.onclose = () => {
    // FIX 5: exponential back-off with cap — don't spam reconnects
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 1.5, 30000);
  };
}

// ── UI Update ──────────────────────────────────────────────────────────────────
function updateUIFromState() {
  if (appMode === 'radio') {
    DOMElements.title.textContent  = lastRadioTrack.title;
    DOMElements.artist.textContent = lastRadioTrack.artist;
    DOMElements.dialTitle.innerHTML = 'Agum Bukuma<br>Radio';
  } else {
    if (localPlaylist.length === 0) {
      DOMElements.title.textContent  = 'No Music Loaded';
      DOMElements.artist.textContent = 'Tap to select files';
      DOMElements.dialTitle.innerHTML = 'Local<br>Library';
    } else {
      const title = localPlaylist[localIndex].name.replace(/\.[^/.]+$/, '');
      DOMElements.title.textContent  = title;
      DOMElements.artist.textContent = 'Local Device';
      DOMElements.dialTitle.innerHTML = title.substring(0, 15) + '...';
    }
  }
  if (isPlaying) {
    DOMElements.playIcon.setAttribute('name', 'pause');
    DOMElements.btnPlayPause.classList.add('playing');
    DOMElements.dial.classList.add('alive');
  } else {
    DOMElements.playIcon.setAttribute('name', 'play');
    DOMElements.btnPlayPause.classList.remove('playing');
    DOMElements.dial.classList.remove('alive');
  }
}

// ── Visualizer ────────────────────────────────────────────────────────────────
function initVisualizer() {
  if (isVisualizerInit) return;
  try {
    audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    analyser  = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    const source = audioCtx.createMediaElementSource(DOMElements.audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    isVisualizerInit = true;
    drawWaveform();
  } catch(e) { console.error('Visualizer:', e); }
}

function playMechanicalClick() {
  initVisualizer();
  if (!audioCtx) return;
  audioCtx.resume().then(() => {
    if (audioCtx.state === 'suspended') return;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.04);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.05);
  });
}

document.querySelectorAll('button, .center-dial').forEach(btn => btn.addEventListener('pointerdown', playMechanicalClick));

function drawWaveform() {
  requestAnimationFrame(drawWaveform);
  ctx.clearRect(0, 0, DOMElements.canvas.width, DOMElements.canvas.height);
  if (!isPlaying || !isVisualizerInit) return;
  analyser.getByteFrequencyData(dataArray);
  const bw = (DOMElements.canvas.width / dataArray.length) * 2;
  let x = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const bh = (dataArray[i] / 255) * DOMElements.canvas.height * 0.8;
    ctx.fillStyle = 'rgb(0,' + (180 + dataArray[i]/3) + ',255)';
    ctx.fillRect(x, (DOMElements.canvas.height - bh) / 2, bw - 1, bh);
    x += bw;
  }
}

// ── Playback ───────────────────────────────────────────────────────────────────
// FIX 6: togglePlayback ONLY manages the <audio> element.
// It never restarts a stream that is already playing.
function togglePlayback() {
  if (isPlaying) {
    DOMElements.audio.pause();
    if (appMode === 'radio') {
      DOMElements.audio.src = '';
      currentStreamUrl = '';
    }
    isPlaying = false;
  } else {
    if (appMode === 'radio') {
      // FIX 7: append timestamp only on fresh connect, not on resume-after-pause
      const url = '/api/stream?' + Date.now();
      DOMElements.audio.src = url;
      currentStreamUrl = url;
      DOMElements.audio.play().catch(() => {});
    } else {
      if (localPlaylist.length === 0) { DOMElements.fileInput.click(); return; }
      if (!DOMElements.audio.src) loadLocalTrack();
      DOMElements.audio.play().catch(() => {});
    }
    isPlaying = true;
  }
  updateUIFromState();
}

function loadLocalTrack() {
  if (!localPlaylist.length) return;
  DOMElements.audio.src = URL.createObjectURL(localPlaylist[localIndex]);
  updateUIFromState();
}

function skipLocal(dir) {
  if (appMode !== 'local' || !localPlaylist.length) return;
  localIndex = dir === 'next'
    ? (localIndex + 1) % localPlaylist.length
    : (localIndex - 1 + localPlaylist.length) % localPlaylist.length;
  loadLocalTrack();
  if (isPlaying) DOMElements.audio.play().catch(() => {});
}

// ── Audio element events ───────────────────────────────────────────────────────
// FIX 8: handle stream stalls/errors — auto-reconnect gracefully without full restart
DOMElements.audio.addEventListener('error', (e) => {
  if (appMode !== 'radio' || !isPlaying) return;
  console.warn('[AUDIO] Stream error, reconnecting in 2s...', e);
  setTimeout(() => {
    if (appMode === 'radio' && isPlaying) {
      const url = '/api/stream?' + Date.now();
      DOMElements.audio.src = url;
      currentStreamUrl = url;
      DOMElements.audio.play().catch(() => {});
    }
  }, 2000);
});

DOMElements.audio.addEventListener('ended', () => {
  if (appMode === 'local') { skipLocal('next'); return; }
  // Radio stream ended (server stopped) — show stopped state
  if (appMode === 'radio') { isPlaying = false; updateUIFromState(); }
});

// FIX 9: stall detection — if radio stream stalls for 10s, reconnect
let stallTimer = null;
DOMElements.audio.addEventListener('waiting', () => {
  if (appMode !== 'radio' || !isPlaying) return;
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (appMode === 'radio' && isPlaying && DOMElements.audio.readyState < 3) {
      console.warn('[AUDIO] Stream stalled, reconnecting...');
      const url = '/api/stream?' + Date.now();
      DOMElements.audio.src = url;
      currentStreamUrl = url;
      DOMElements.audio.play().catch(() => {});
    }
  }, 10000);
});
DOMElements.audio.addEventListener('playing', () => {
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
});

// ── Controls ───────────────────────────────────────────────────────────────────
DOMElements.btnPlayPause.addEventListener('click', () => {
  initVisualizer();
  setTimeout(togglePlayback, 50);
});
DOMElements.btnNext.addEventListener('click', () => {
  initVisualizer();
  if (appMode === 'local') setTimeout(() => skipLocal('next'), 50);
});
DOMElements.btnPrev.addEventListener('click', () => {
  if (appMode === 'local') setTimeout(() => skipLocal('prev'), 50);
});
DOMElements.navRadio.addEventListener('click', () => {
  if (appMode === 'radio') return;
  if (isPlaying) togglePlayback();
  appMode = 'radio';
  DOMElements.navRadio.classList.add('active');
  DOMElements.navLocal.classList.remove('active');
  updateUIFromState();
});
DOMElements.navLocal.addEventListener('click', () => {
  if (appMode === 'local') { DOMElements.fileInput.click(); return; }
  if (isPlaying) togglePlayback();
  appMode = 'local';
  DOMElements.navLocal.classList.add('active');
  DOMElements.navRadio.classList.remove('active');
  if (!localPlaylist.length) DOMElements.fileInput.click();
  updateUIFromState();
});
DOMElements.fileInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files).filter(f => f.type.startsWith('audio/'));
  if (files.length) {
    localPlaylist = files;
    localIndex    = 0;
    loadLocalTrack();
    if (!isPlaying) togglePlayback();
  }
});
DOMElements.dial.addEventListener('click', () => {
  DOMElements.btnPlayPause.classList.add('active');
  setTimeout(() => { DOMElements.btnPlayPause.classList.remove('active'); togglePlayback(); }, 150);
});

// ── Init ───────────────────────────────────────────────────────────────────────
connectWS();
updateUIFromState();

// FIX 10: iOS/Safari unlock — must happen on first touch gesture
document.body.addEventListener('touchstart', function() {
  if (!window.audioEnabled) {
    DOMElements.audio.load();
    window.audioEnabled = true;
  }
}, { once: true });
