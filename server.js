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
const PORT = process.env.PORT || 3000;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP_PATH  = process.env.YTDLP_PATH  || 'yt-dlp';

function verifyBinaries() {
  const { execSync } = require('child_process');
  ['ffmpeg', 'yt-dlp'].forEach(name => {
    const bin = name === 'ffmpeg' ? FFMPEG_PATH : YTDLP_PATH;
    try {
      execSync('"' + bin + '" -version', { stdio: 'ignore' });
      console.log('[BINARY] OK: ' + name + ' (' + bin + ')');
    } catch(e) {
      console.error('[BINARY] MISSING: ' + name + ' at: ' + bin);
    }
  });
}

const REX_LAWSON_SEED = [
  { title: 'Jolly', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Jolly highlife' },
  { title: 'Warri', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Warri highlife' },
  { title: 'Kelegbe Megbe', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Kelegbe Megbe' },
  { title: 'So Tey', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson So Tey highlife' },
  { title: 'Ibinabo', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ibinabo' },
  { title: 'Ogologo Obi', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ogologo Obi' },
];
function seedQueue() {
  return REX_LAWSON_SEED.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
}

let queue = seedQueue();
let currentTrack = null;
let isPlaying = false;
let volume = 80;
let currentProcess = null;
let isTransitioning = false;
let playNextTimeout = null;
let silenceInterval = null;
let playlists = [];
let autoJingles = { start: false, random: false };
let micProcess = null;
let micActive = false;
let micState = 0;
let lastDataTime = Date.now();
let monitorTimer = null;
const clients = new Set();
const streamClients = new Set();
let listeners = 0;

const dataDir = path.join(__dirname, 'data');
const queueFile = path.join(dataDir, 'queue.json');
const stateFile = path.join(dataDir, 'state.json');
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
      volume = s.volume || 80;
      autoJingles = s.autoJingles || { start: false, random: false };
    }
    if (fs.existsSync(playlistsFile)) playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
  } catch(e) { console.error('[INIT] loadState error:', e.message); }
}
function saveState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ volume, autoJingles }, null, 2));
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  } catch(e) {}
}
function savePlaylists() {
  try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {}
}

const upload = multer({ dest: path.join(__dirname, 'public/uploads') });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function getStatus() {
  return { type: 'status', currentTrack, queue, isPlaying, volume, listeners, autoJingles, micState, timestamp: Date.now() };
}

function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    if (isPlaying && !isTransitioning) {
      const idleMs = Date.now() - lastDataTime;
      if (idleMs > 10000) {
        console.log('[WATCHDOG] Dead air ' + idleMs + 'ms resyncing');
        lastDataTime = Date.now();
        if (queue.length === 0) queue = seedQueue();
        playNext();
      }
    }
  }, 2000);
}

async function getYouTubeUrl(query) {
  return new Promise((resolve, reject) => {
    const safeQuery = query.replace(/"/g, '');
    const cmd = '"' + YTDLP_PATH + '" --get-url --format "bestaudio/best" --no-playlist --ignore-errors --socket-timeout 30 "ytsearch1:' + safeQuery + '"';
    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) { console.error('[YT-DLP]', (stderr || '').substring(0, 150)); return reject(err); }
      const url = stdout.trim().split('\n').filter(l => l.startsWith('http'))[0];
      if (!url) return reject(new Error('No URL from yt-dlp'));
      resolve(url);
    });
  });
}

function pushToStreamClients(chunk) {
  lastDataTime = Date.now();
  streamClients.forEach(client => {
    try { client.write(chunk); } catch(e) { streamClients.delete(client); }
  });
}

function startPlayback() {
  if (isPlaying && currentProcess) return;
  isPlaying = true;
  if (queue.length === 0) {
    const pl = playlists[0];
    queue = (pl && pl.tracks.length > 0)
      ? pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }))
      : seedQueue();
    saveState();
  }
  lastDataTime = Date.now();
  playNext();
}

async function playNext() {
  if (!isPlaying || isTransitioning) return;
  if (queue.length === 0) { queue = seedQueue(); saveState(); }
  isTransitioning = true;
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }

  currentTrack = { ...queue[0] };
  console.log('[PLAY] Loading:', currentTrack.title);
  broadcast({ type: 'nowPlaying', track: currentTrack });
  broadcast(getStatus());

  try {
    const url = await getYouTubeUrl(currentTrack.youtubeQuery || currentTrack.title);
    if (currentProcess) {
      currentProcess.removeAllListeners();
      try { currentProcess.kill('SIGKILL'); } catch(e) {}
      currentProcess = null;
    }
    const args = [
      '-hide_banner', '-reconnect', '1', '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-i', url, '-vn', '-af', 'volume=' + (volume / 100),
      '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2', 'pipe:1'
    ];
    currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentProcess.stdout.on('data', chunk => pushToStreamClients(chunk));
    currentProcess.stderr.on('data', data => {
      const msg = data.toString();
      if (/error|failed|invalid/i.test(msg) && !/Stream #/i.test(msg))
        console.error('[FFMPEG]', msg.trim().substring(0, 200));
    });
    currentProcess.on('close', code => {
      console.log('[FFMPEG] closed code:', code);
      if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
      if (isPlaying) { queue.shift(); saveState(); isTransitioning = false; playNextTimeout = setTimeout(playNext, 1500); }
    });
    currentProcess.on('error', err => {
      console.error('[FFMPEG] spawn error:', err.message);
      if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
      isTransitioning = false;
      if (isPlaying) playNextTimeout = setTimeout(playNext, 3000);
    });
    isTransitioning = false;
  } catch(e) {
    console.error('[PLAY] failed:', e.message);
    isTransitioning = false;
    queue.shift();
    if (queue.length === 0) queue = seedQueue();
    saveState();
    playNextTimeout = setTimeout(playNext, 4000);
  }
}

function pausePlayback() {
  isPlaying = false;
  stopMicPipeline();
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  if (currentProcess) { try { currentProcess.kill('SIGKILL'); } catch(e) {} currentProcess = null; }
  broadcast(getStatus());
}

function skipTrack() {
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  if (currentProcess) {
    currentProcess.removeAllListeners();
    try { currentProcess.kill('SIGKILL'); } catch(e) {}
    currentProcess = null;
  }
  queue.shift();
  if (queue.length === 0) queue = seedQueue();
  saveState();
  isTransitioning = false;
  if (isPlaying) playNext();
  else { currentTrack = null; broadcast(getStatus()); }
}

function startMicPipeline() {
  if (micProcess) return;
  console.log('[MIC] Starting pipeline');
  const args = [
    '-hide_banner', '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', 'pipe:0',
    '-f', 'mp3', '-b:a', '64k', '-ar', '44100', '-ac', '2', 'pipe:1'
  ];
  micProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  micProcess.stdin.on('error', err => { if (err.code !== 'EPIPE') console.error('[MIC] stdin:', err.message); });
  micProcess.stdout.on('data', chunk => {
    if (micState > 0) pushToStreamClients(chunk);
  });
  micProcess.stderr.on('data', data => {
    const msg = data.toString();
    if (/error|failed/i.test(msg)) console.error('[MIC FFMPEG]', msg.trim().substring(0, 100));
  });
  micProcess.on('close', () => { console.log('[MIC] closed'); micProcess = null; micActive = false; });
  micProcess.on('error', err => { console.error('[MIC] spawn:', err.message); micProcess = null; micActive = false; });
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
  micState = state;
  if (state === 0) {
    stopMicPipeline();
    if (currentProcess) {
      currentProcess.removeAllListeners();
      try { currentProcess.kill('SIGKILL'); } catch(e) {}
      currentProcess = null;
      isTransitioning = false;
      if (isPlaying) setTimeout(playNext, 500);
    }
  } else {
    if (state === 1 && currentProcess && isPlaying) {
      currentProcess.removeAllListeners();
      try { currentProcess.kill('SIGKILL'); } catch(e) {}
      currentProcess = null;
      isTransitioning = false;
      if (queue.length > 0) setTimeout(playNextDucked, 300);
    }
    startMicPipeline();
  }
  broadcast({ type: 'micState', micState, state });
}

async function playNextDucked() {
  if (!isPlaying || isTransitioning) return;
  isTransitioning = true;
  try {
    const track = queue[0];
    if (!track) { isTransitioning = false; return; }
    const url = await getYouTubeUrl(track.youtubeQuery || track.title);
    const duckVol = Math.max(0.1, (volume / 100) * 0.2);
    const args = [
      '-hide_banner', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-user_agent', 'Mozilla/5.0', '-i', url, '-vn',
      '-af', 'volume=' + duckVol,
      '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2', 'pipe:1'
    ];
    currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentProcess.stdout.on('data', chunk => { if (micState !== 2) pushToStreamClients(chunk); });
    currentProcess.stderr.on('data', () => {});
    currentProcess.on('close', () => {
      if (isPlaying && micState === 0) { queue.shift(); saveState(); isTransitioning = false; playNextTimeout = setTimeout(playNext, 1500); }
      else isTransitioning = false;
    });
    currentProcess.on('error', err => { console.error('[DUCK]', err.message); isTransitioning = false; });
    isTransitioning = false;
  } catch(e) { console.error('[DUCK] failed:', e.message); isTransitioning = false; }
}

wss.on('connection', ws => {
  clients.add(ws);
  listeners = clients.size;
  ws.send(JSON.stringify(getStatus()));
  broadcast({ type: 'listeners', count: listeners });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws.isAdmin && micActive && micProcess && micProcess.stdin && micProcess.stdin.writable) {
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
          } else ws.send(JSON.stringify({ type: 'auth', success: false }));
          break;
        case 'getStatus': ws.send(JSON.stringify(getStatus())); break;
        case 'play': if (!isPlaying) startPlayback(); break;
        case 'pause': pausePlayback(); break;
        case 'skip': skipTrack(); break;
        case 'volume':
          volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
          saveState(); broadcast({ type: 'volume', value: volume }); break;
        case 'micState':
          if (ws.isAdmin) setMicState(parseInt(msg.state) || 0); break;
        case 'addSong':
          if (msg.song) {
            queue.push({ id: Math.random().toString(36).slice(2), ...msg.song });
            saveState(); broadcast(getStatus());
            if (!isPlaying) startPlayback();
          }
          break;
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    listeners = clients.size;
    broadcast({ type: 'listeners', count: listeners });
  });
});

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  streamClients.add(res);
  req.on('close', () => streamClients.delete(res));
});

app.get('/api/status', (req, res) => res.json(getStatus()));
app.get('/api/queue', (req, res) => res.json({ queue }));
app.get('/api/playlists', (req, res) => res.json({ playlists }));

app.post('/api/play', (req, res) => { if (!isPlaying) startPlayback(); res.json({ success: true, isPlaying }); });
app.post('/api/pause', (req, res) => { pausePlayback(); res.json({ success: true }); });
app.post('/api/skip', (req, res) => { skipTrack(); res.json({ success: true }); });
app.post('/api/queue/skip', (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', (req, res) => {
  volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80));
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
  if (!url && !youtubeQuery && !title) return res.status(400).json({ success: false });
  const entry = {
    id: Math.random().toString(36).slice(2),
    title: title || url, artist: artist || 'Unknown',
    youtubeQuery: youtubeQuery || url || title
  };
  queue.push(entry); saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, id: entry.id });
});

app.delete('/api/queue/:id', (req, res) => {
  const before = queue.length;
  queue = queue.filter(t => t.id !== req.params.id);
  if (queue.length !== before) saveState();
  broadcast(getStatus());
  res.json({ success: true, queue });
});

app.get('/api/youtube/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  const safeQ = q.replace(/"/g, '');
  const cmd = '"' + YTDLP_PATH + '" "ytsearch5:' + safeQ + '" --flat-playlist --print "%(id)s|||%(title)s|||%(duration_string)s" --no-warnings';
  exec(cmd, { timeout: 45000 }, (err, stdout) => {
    if (err || !stdout.trim()) return res.json({ results: [] });
    const results = stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('|||');
      const vid = (parts[0] || '').trim();
      const title = (parts[1] || 'Unknown').trim();
      const dur = (parts[2] || '').trim();
      if (!vid) return null;
      return { title, url: 'https://www.youtube.com/watch?v=' + vid, thumbnail: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg', duration: dur };
    }).filter(Boolean);
    res.json({ results });
  });
});

app.post('/api/playlists', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false });
  const pl = { id: Date.now().toString(), name, tracks: [...queue] };
  playlists.push(pl); savePlaylists();
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
  const seeds = seedQueue();
  seeds.forEach(s => { if (!queue.find(q => q.title === s.title)) queue.push(s); });
  saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, queue });
});

let songRequests = [];
app.post('/api/requests', (req, res) => {
  const { song, listener } = req.body;
  if (!song) return res.status(400).json({ success: false });
  const r = { id: Date.now().toString(), song, listener: listener || 'Anonymous', status: 'pending', createdAt: new Date().toISOString() };
  songRequests.push(r); broadcast({ type: 'request_new', song: r.song });
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

app.get('/health', (req, res) => res.json({
  status: 'ok', uptime: process.uptime(), isPlaying, micState, micActive,
  currentTrack: currentTrack ? currentTrack.title : null,
  queueLength: queue.length, streamClients: streamClients.size,
  lastDataAgeMs: Date.now() - lastDataTime
}));

server.listen(PORT, () => {
  console.log('[BUKUMA] Station live on port', PORT);
  verifyBinaries(); loadState(); startMonitor();
  setTimeout(() => { console.log('[BUKUMA] Auto-starting, queue:', queue.length); startPlayback(); }, 2000);
});
