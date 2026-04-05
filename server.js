const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bukuma2024';
const PORT           = process.env.PORT            || 3000;
const FFMPEG_PATH    = process.env.FFMPEG_PATH     || 'ffmpeg';
const YTDLP_PATH     = process.env.YTDLP_PATH      || 'yt-dlp';

function verifyBinaries() {
  const { execSync } = require('child_process');
  [['ffmpeg', FFMPEG_PATH], ['yt-dlp', YTDLP_PATH]].forEach(([name, bin]) => {
    try {
      execSync(bin + ' -version', { stdio: 'ignore' });
      console.log('[BINARY] OK:', name);
    } catch(e) {
      console.error('[BINARY] MISSING:', name, '— install it or set env var');
    }
  });
}

// ── Seed tracks ───────────────────────────────────────────────────────────────
const REX_LAWSON_SEED = [
  { title: 'Jolly',         artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Jolly highlife' },
  { title: 'Warri',         artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Warri highlife' },
  { title: 'Kelegbe Megbe', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Kelegbe Megbe' },
  { title: 'So Tey',        artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson So Tey highlife' },
  { title: 'Ibinabo',       artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ibinabo' },
  { title: 'Ogologo Obi',   artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ogologo Obi' },
];
function seedQueue() {
  return REX_LAWSON_SEED.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
}

// ── State ─────────────────────────────────────────────────────────────────────
let queue           = seedQueue();
let currentTrack    = null;
let isPlaying       = false;
let volume          = 80;
let currentProcess  = null;
let isTransitioning = false;
let playNextTimeout = null;
let playlists       = [];
let autoJingles     = { start: false, random: false };
let micProcess      = null;
let micActive       = false;
let micState        = 0;
// lastDataTime tracks when FFmpeg last produced audio — updated directly from
// FFmpeg stdout so the watchdog works even with 0 HTTP stream clients
let lastDataTime    = Date.now();
let monitorTimer    = null;
const clients       = new Set();
const streamClients = new Set();
let listeners       = 0;

// ── Persistence ───────────────────────────────────────────────────────────────
const dataDir      = path.join(__dirname, 'data');
const queueFile    = path.join(dataDir, 'queue.json');
const stateFile    = path.join(dataDir, 'state.json');
const playlistsFile = path.join(dataDir, 'playlists.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadState() {
  try {
    if (fs.existsSync(queueFile)) {
      const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) queue = saved;
    }
    if (fs.existsSync(stateFile)) {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      volume      = s.volume      || 80;
      autoJingles = s.autoJingles || { start: false, random: false };
    }
    if (fs.existsSync(playlistsFile))
      playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
  } catch(e) { console.error('[INIT] loadState error:', e.message); }
}
function saveState() {
  try {
    fs.writeFileSync(stateFile,    JSON.stringify({ volume, autoJingles }, null, 2));
    fs.writeFileSync(queueFile,    JSON.stringify(queue, null, 2));
  } catch(e) {}
}
function savePlaylists() {
  try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {}
}

// ── Utilities ─────────────────────────────────────────────────────────────────
multer({ dest: path.join(__dirname, 'public/uploads') }); // keep multer available

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function getStatus() {
  return {
    type: 'status', currentTrack, queue, isPlaying, volume,
    listeners, autoJingles, micState,
    streamClients: streamClients.size,
    timestamp: Date.now()
  };
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
// Only fires if FFmpeg itself has gone silent for 15s (not just "no listeners")
function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    if (isPlaying && !isTransitioning) {
      const idleMs = Date.now() - lastDataTime;
      if (idleMs > 15000) {
        console.log('[WATCHDOG] FFmpeg silent', idleMs + 'ms — restarting track');
        lastDataTime = Date.now(); // reset so we don't loop immediately
        if (currentProcess) {
          try { currentProcess.kill('SIGKILL'); } catch(e) {}
          currentProcess = null;
        }
        isTransitioning = false;
        if (queue.length === 0) queue = seedQueue();
        playNext();
      }
    }
  }, 3000);
}

// ── YouTube URL resolver ───────────────────────────────────────────────────────
async function getYouTubeUrl(query) {
  return new Promise((resolve, reject) => {
    const q = query.replace(/['"]/g, '');
    // Try audio-only first, fall back to best
    const cmd = YTDLP_PATH + ' --get-url --format "bestaudio/best" --no-playlist --ignore-errors --socket-timeout 20 --extractor-args "youtube:player_client=android,web" "ytsearch1:' + q + '"';
    exec(cmd, { timeout: 50000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[YT-DLP] error for:', q, '-', (stderr || err.message).substring(0, 120));
        return reject(new Error('yt-dlp failed: ' + (stderr || err.message).substring(0, 80)));
      }
      const url = stdout.trim().split('\n').find(l => l.startsWith('http'));
      if (!url) return reject(new Error('No stream URL returned by yt-dlp for: ' + q));
      resolve(url);
    });
  });
}

// ── Stream distribution ───────────────────────────────────────────────────────
function pushToStreamClients(chunk) {
  // Always update lastDataTime from FFmpeg output — even if no one is listening
  lastDataTime = Date.now();
  if (streamClients.size === 0) return;
  streamClients.forEach(client => {
    try { client.write(chunk); } catch(e) { streamClients.delete(client); }
  });
}

// ── Playback engine ───────────────────────────────────────────────────────────
function startPlayback() {
  if (isPlaying && currentProcess) {
    console.log('[PLAY] Already playing, ignoring start');
    return;
  }
  isPlaying = true;
  if (queue.length === 0) {
    const pl = playlists[0];
    queue = (pl && pl.tracks.length > 0)
      ? pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }))
      : seedQueue();
    saveState();
  }
  lastDataTime = Date.now();
  console.log('[PLAY] Starting playback, queue length:', queue.length);
  playNext();
}

async function playNext() {
  if (!isPlaying || isTransitioning) return;
  if (queue.length === 0) { queue = seedQueue(); saveState(); }

  isTransitioning = true;
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }

  currentTrack = { ...queue[0] };
  console.log('[PLAY] Now loading:', currentTrack.title, 'by', currentTrack.artist);
  broadcast({ type: 'nowPlaying', track: currentTrack });
  broadcast(getStatus());

  try {
    const url = await getYouTubeUrl(currentTrack.youtubeQuery || currentTrack.title);
    console.log('[PLAY] Got URL, spawning FFmpeg for:', currentTrack.title);

    // Kill any existing FFmpeg
    if (currentProcess) {
      currentProcess.removeAllListeners();
      try { currentProcess.kill('SIGKILL'); } catch(e) {}
      currentProcess = null;
    }

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-user_agent', 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      '-i', url,
      '-vn',
      '-af', 'volume=' + (volume / 100),
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'mp3',
      'pipe:1'
    ];

    currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    lastDataTime = Date.now(); // reset on spawn

    currentProcess.stdout.on('data', chunk => {
      lastDataTime = Date.now(); // keep watchdog happy
      pushToStreamClients(chunk);
    });

    currentProcess.stderr.on('data', data => {
      const msg = data.toString().trim();
      if (msg && !/^\s*$/.test(msg)) console.log('[FFMPEG]', msg.substring(0, 150));
    });

    currentProcess.on('close', (code, signal) => {
      console.log('[FFMPEG] Track ended — code:', code, 'signal:', signal, 'track:', currentTrack?.title);
      currentProcess = null;
      if (isPlaying && !isTransitioning) {
        queue.shift();
        saveState();
        isTransitioning = false;
        playNextTimeout = setTimeout(playNext, 1500);
      } else {
        isTransitioning = false;
      }
    });

    currentProcess.on('error', err => {
      console.error('[FFMPEG] Spawn error:', err.message);
      currentProcess = null;
      isTransitioning = false;
      if (isPlaying) playNextTimeout = setTimeout(playNext, 3000);
    });

    isTransitioning = false;
    broadcast(getStatus());

  } catch(e) {
    console.error('[PLAY] Failed to get URL for:', currentTrack.title, '-', e.message);
    isTransitioning = false;
    queue.shift(); // skip broken track
    if (queue.length === 0) queue = seedQueue();
    saveState();
    playNextTimeout = setTimeout(playNext, 3000);
  }
}

function stopPlayback() {
  console.log('[PLAY] Stopping playback');
  isPlaying = false;
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  if (currentProcess) {
    currentProcess.removeAllListeners();
    try { currentProcess.kill('SIGKILL'); } catch(e) {}
    currentProcess = null;
  }
  currentTrack = null;
  broadcast(getStatus());
}

function pausePlayback() { stopPlayback(); } // stop = pause for internet radio

function skipTrack() {
  console.log('[PLAY] Skipping track');
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  if (currentProcess) {
    currentProcess.removeAllListeners();
    try { currentProcess.kill('SIGKILL'); } catch(e) {}
    currentProcess = null;
  }
  queue.shift();
  if (queue.length === 0) queue = seedQueue();
  saveState();
  isTransitioning = false;
  if (isPlaying) {
    playNextTimeout = setTimeout(playNext, 500);
  } else {
    currentTrack = null;
    broadcast(getStatus());
  }
}

// ── Mic pipeline ──────────────────────────────────────────────────────────────
function startMicPipeline() {
  if (micProcess) return;
  console.log('[MIC] Starting FFmpeg mic pipeline');
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '44100', '-ac', '2',
    '-f', 'mp3', 'pipe:1'
  ];
  micProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  micProcess.stdin.on('error', err => { if (err.code !== 'EPIPE') console.error('[MIC stdin]', err.message); });
  micProcess.stdout.on('data', chunk => {
    if (micState > 0) pushToStreamClients(chunk);
  });
  micProcess.stderr.on('data', () => {});
  micProcess.on('close', () => { console.log('[MIC] Pipeline closed'); micProcess = null; micActive = false; });
  micProcess.on('error', err => { console.error('[MIC] spawn error:', err.message); micProcess = null; micActive = false; });
  micActive = true;
}

function stopMicPipeline() {
  if (micProcess) {
    try { micProcess.stdin.end(); } catch(e) {}
    try { micProcess.kill('SIGKILL'); } catch(e) {}
    micProcess = null;
  }
  micActive = false;
  micState = 0;
}

function setMicState(state) {
  const prev = micState;
  micState = state;
  console.log('[MIC] State change:', prev, '->', state);

  if (state === 0) {
    stopMicPipeline();
    // Resume normal volume music
    if (isPlaying && !currentProcess) {
      isTransitioning = false;
      setTimeout(playNext, 300);
    }
  } else {
    // Duck music if TALK mode
    if (state === 1 && currentProcess && isPlaying) {
      currentProcess.removeAllListeners();
      try { currentProcess.kill('SIGKILL'); } catch(e) {}
      currentProcess = null;
      isTransitioning = false;
      setTimeout(playNextDucked, 200);
    }
    startMicPipeline();
  }
  broadcast({ type: 'micState', micState });
  broadcast(getStatus());
}

async function playNextDucked() {
  if (!isPlaying || isTransitioning) return;
  isTransitioning = true;
  try {
    const track = queue[0];
    if (!track) { isTransitioning = false; return; }
    const url = await getYouTubeUrl(track.youtubeQuery || track.title);
    const duckVol = Math.max(0.05, (volume / 100) * 0.15);
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-user_agent', 'Mozilla/5.0',
      '-i', url, '-vn',
      '-af', 'volume=' + duckVol,
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'mp3', 'pipe:1'
    ];
    currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentProcess.stdout.on('data', chunk => {
      lastDataTime = Date.now();
      if (micState !== 2) pushToStreamClients(chunk);
    });
    currentProcess.stderr.on('data', () => {});
    currentProcess.on('close', () => {
      currentProcess = null;
      isTransitioning = false;
      if (isPlaying && micState === 0) {
        queue.shift(); saveState();
        playNextTimeout = setTimeout(playNext, 1500);
      }
    });
    currentProcess.on('error', err => { console.error('[DUCK]', err.message); isTransitioning = false; currentProcess = null; });
    isTransitioning = false;
  } catch(e) { console.error('[DUCK] failed:', e.message); isTransitioning = false; }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws);
  listeners = clients.size;
  ws.send(JSON.stringify(getStatus()));
  broadcast({ type: 'listeners', count: listeners });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws.isAdmin && micActive && micProcess?.stdin?.writable) {
        try { micProcess.stdin.write(data); } catch(e) {}
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.action) {
        case 'adminLogin':
          if (msg.password === ADMIN_PASSWORD) {
            ws.isAdmin = true;
            ws.send(JSON.stringify({ type: 'auth', success: true }));
            console.log('[AUTH] Admin connected');
          } else {
            ws.send(JSON.stringify({ type: 'auth', success: false }));
          }
          break;
        case 'getStatus':
          ws.send(JSON.stringify(getStatus()));
          break;
        case 'play':
          startPlayback();
          break;
        case 'stop':
        case 'pause':
          stopPlayback();
          break;
        case 'skip':
          skipTrack();
          break;
        case 'volume':
          volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
          saveState();
          broadcast({ type: 'volume', value: volume });
          break;
        case 'micState':
          if (ws.isAdmin) setMicState(parseInt(msg.state) || 0);
          break;
        case 'addSong':
          if (msg.song) {
            queue.push({ id: Math.random().toString(36).slice(2), ...msg.song });
            saveState(); broadcast(getStatus());
            if (!isPlaying) startPlayback();
          }
          break;
      }
    } catch(e) { console.error('[WS] message parse error:', e.message); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    listeners = clients.size;
    broadcast({ type: 'listeners', count: listeners });
  });
});

// ── HTTP Routes ────────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  console.log('[STREAM] New listener connected, total:', streamClients.size + 1);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  streamClients.add(res);
  req.on('close', () => {
    streamClients.delete(res);
    console.log('[STREAM] Listener disconnected, total:', streamClients.size);
  });
});

app.get('/api/status',    (req, res) => res.json(getStatus()));
app.get('/api/queue',     (req, res) => res.json({ queue }));
app.get('/api/playlists', (req, res) => res.json({ playlists }));

app.post('/api/play',  (req, res) => { startPlayback(); res.json({ success: true, isPlaying }); });
app.post('/api/stop',  (req, res) => { stopPlayback();  res.json({ success: true }); });
app.post('/api/pause', (req, res) => { stopPlayback();  res.json({ success: true }); });
app.post('/api/skip',  (req, res) => { skipTrack();     res.json({ success: true }); });
app.post('/api/queue/skip', (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', (req, res) => {
  volume = Math.min(100, Math.max(0, parseInt(req.body.volume ?? req.body.value) || 80));
  saveState(); broadcast({ type: 'volume', value: volume });
  res.json({ success: true, volume });
});

app.post('/api/duck', (req, res) => {
  const state = parseInt(req.body.state) || 0;
  setMicState(state);
  res.json({ success: true, micState: state });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false });
});

const communityUsers = [];
app.post('/api/register', (req, res) => {
  const { name, village, phone } = req.body;
  if (!name || !village) return res.status(400).json({ success: false, error: 'Name and village required' });
  communityUsers.push({ name, village, phone, registeredAt: new Date().toISOString() });
  console.log('[REGISTER]', name, 'from', village);
  res.json({ success: true, name, village });
});

app.post('/api/queue', (req, res) => {
  const { url, title, artist, youtubeQuery } = req.body;
  if (!url && !youtubeQuery && !title) return res.status(400).json({ success: false, error: 'Need url, title, or youtubeQuery' });
  const entry = {
    id: Math.random().toString(36).slice(2),
    title: title || url, artist: artist || 'Unknown',
    youtubeQuery: youtubeQuery || url || title
  };
  queue.push(entry); saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, id: entry.id, entry });
});

app.post('/api/queue/add', (req, res) => {
  const { videoId, title, duration, url } = req.body;
  if (!videoId && !title && !url) return res.status(400).json({ success: false, error: 'Need videoId, title, or url' });
  const vid = videoId || (url && url.match(/[?&]v=([^&]+)/)?.[1]);
  const entry = {
    id: Math.random().toString(36).slice(2),
    title: title || 'Unknown',
    artist: 'YouTube',
    youtubeQuery: vid ? ('https://www.youtube.com/watch?v=' + vid) : (url || title),
    videoId: vid || null,
    duration: duration || ''
  };
  queue.push(entry);
  saveState();
  broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, id: entry.id, entry });
});
app.post('/api/queue/remove', (req, res) => {
  const { index, id } = req.body;
  let removed = 0;
  if (id !== undefined) {
    const before = queue.length;
    queue = queue.filter(t => t.id !== id);
    removed = before - queue.length;
  } else if (index !== undefined) {
    const idx = parseInt(index);
    if (idx >= 0 && idx < queue.length) { queue.splice(idx, 1); removed = 1; }
  }
  if (removed) saveState();
  broadcast(getStatus());
  res.json({ success: true, removed });
});
app.delete('/api/queue/:id', (req, res) => {
  const before = queue.length;
  queue = queue.filter(t => t.id !== req.params.id);
  if (queue.length !== before) saveState();
  broadcast(getStatus());
  res.json({ success: true, removed: before - queue.length });
});

app.get('/api/youtube/search', (req, res) => {
  const q = req.query.q?.trim();
  if (!q) return res.json({ results: [] });
  const safeQ = q.replace(/['"\\]/g, '');
  const cmd = YTDLP_PATH + ' "ytsearch5:' + safeQ + '" --flat-playlist --print "%(id)s|||%(title)s|||%(duration_string)s" --no-warnings';
  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout?.trim()) return res.json({ results: [] });
    const results = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [vid, title, dur] = line.split('|||').map(s => s?.trim());
      if (!vid || vid.length < 5) return null;
      return {
        videoId: vid,
        title: title || 'Unknown',
        url: 'https://www.youtube.com/watch?v=' + vid,
        thumbnail: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg',
        duration: dur || ''
      };
    }).filter(Boolean);
    res.json({ results });
  });
});

app.post('/api/playlists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false });
  playlists.push({ id: Date.now().toString(), name, tracks: [...queue] });
  savePlaylists();
  res.json({ success: true, playlists });
});
app.post('/api/playlists/:id/load', (req, res) => {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ success: false });
  queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
  saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true });
});
app.delete('/api/playlists/:id', (req, res) => {
  playlists = playlists.filter(p => p.id !== req.params.id);
  savePlaylists(); res.json({ success: true, playlists });
});

app.post('/api/queue/rex-lawson', (req, res) => {
  seedQueue().forEach(s => { if (!queue.find(q => q.title === s.title)) queue.push(s); });
  saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, queue });
});

let songRequests = [];
app.post('/api/requests', (req, res) => {
  const { song, listener } = req.body;
  if (!song) return res.status(400).json({ success: false });
  const r = { id: Date.now().toString(), song, listener: listener || 'Anonymous', status: 'pending', createdAt: new Date().toISOString() };
  songRequests.push(r); broadcast({ type: 'request_new', request: r });
  res.json({ success: true, id: r.id });
});
app.get('/api/requests', (req, res) => res.json({ requests: songRequests }));
app.post('/api/requests/:id/approve', (req, res) => {
  const r = songRequests.find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ success: false });
  r.status = 'approved';
  queue.push({ id: Math.random().toString(36).slice(2), title: r.song, artist: r.listener, youtubeQuery: r.song });
  saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true });
});


// ── Herald / News API ────────────────────────────────────────────────────────
const heraldFile = path.join(dataDir, 'herald.json');
const DEFAULT_HERALD = { news: [
  { id: '1', title: 'School Redevelopment', summary: 'Proposed redevelopment plan to restore the primary school.', content: 'The Village Primary School has been in a state of disrepair. Donations are ongoing.', status: 'ongoing', link: '#' },
  { id: '2', title: 'Community Harvest Festival', summary: 'Annual harvest festival coming up next month.', content: 'Join us for the annual harvest festival celebrating Bukuma culture and music.', status: 'upcoming', link: '#' }
]};
function loadHerald() {
  try {
    if (fs.existsSync(heraldFile)) return JSON.parse(fs.readFileSync(heraldFile, 'utf8'));
  } catch(e) {}
  return DEFAULT_HERALD;
}
function saveHerald(data) {
  try { fs.writeFileSync(heraldFile, JSON.stringify(data, null, 2)); } catch(e) {}
}
app.get('/data/herald.json', (req, res) => res.json(loadHerald()));
app.get('/api/herald', (req, res) => res.json(loadHerald()));
app.post('/api/herald', (req, res) => {
  const herald = loadHerald();
  const { title, summary, content, status, link } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'title required' });
  const item = { id: Date.now().toString(), title, summary: summary||'', content: content||'', status: status||'new', link: link||'#' };
  herald.news.unshift(item);
  saveHerald(herald);
  broadcast({ type: 'herald_update', herald });
  res.json({ success: true, item });
});
app.put('/api/herald/:id', (req, res) => {
  const herald = loadHerald();
  const idx = herald.news.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  herald.news[idx] = { ...herald.news[idx], ...req.body, id: req.params.id };
  saveHerald(herald);
  broadcast({ type: 'herald_update', herald });
  res.json({ success: true });
});
app.delete('/api/herald/:id', (req, res) => {
  const herald = loadHerald();
  herald.news = herald.news.filter(n => n.id !== req.params.id);
  saveHerald(herald);
  broadcast({ type: 'herald_update', herald });
  res.json({ success: true });
});
// ── Song Request dismiss ──────────────────────────────────────────────────────
app.post('/api/requests/:id/dismiss', (req, res) => {
  const r = songRequests.find(r => r.id === req.params.id);
  if (!r) return res.status(404).json({ success: false });
  r.status = 'dismissed';
  broadcast({ type: 'request_dismissed', id: req.params.id });
  res.json({ success: true });
});
app.get('/api/listeners', (req, res) => res.json({ users: communityUsers, count: communityUsers.length }));

app.get('/health', (req, res) => res.json({
  status: 'ok', uptime: Math.round(process.uptime()),
  isPlaying, micState, micActive,
  currentTrack: currentTrack?.title || null,
  queueLength: queue.length,
  streamClients: streamClients.size,
  wsClients: clients.size,
  lastDataAgeMs: Date.now() - lastDataTime
}));

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('[BUKUMA] Station live on port', PORT);
  verifyBinaries();
  loadState();
  startMonitor();
  setTimeout(() => {
    console.log('[BUKUMA] Auto-starting playback, queue:', queue.length);
    startPlayback();
  }, 2000);
});
