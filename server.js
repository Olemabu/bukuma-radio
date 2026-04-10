const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bukuma2024';
const PORT           = process.env.PORT            || 3000;
const FFMPEG_PATH    = process.env.FFMPEG_PATH     || 'ffmpeg';
const YTDLP_PATH     = process.env.YTDLP_PATH      || 'yt-dlp';

// ── Persistence ───────────────────────────────────────────────────────────────
const dataDir      = process.env.DATA_DIR || path.join(__dirname, 'data');
const downloadsDir = path.join(dataDir, 'downloads');
const queueFile    = path.join(dataDir, 'queue.json');
const stateFile    = path.join(dataDir, 'state.json');
const playlistsFile= path.join(dataDir, 'playlists.json');
const newsFile     = path.join(dataDir, 'news.json');
if (!fs.existsSync(dataDir))      fs.mkdirSync(dataDir,      { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// ── State ──────────────────────────────────────────────────────────────────────
let queue          = [];
let playlists      = [];
let news           = [];
let programs       = [];
let libraryIndex   = 0;
let currentTrack   = null;
let isPlaying      = false;
let volume         = 80;
let currentProcess = null;
let playNextTimeout= null;
let isStartingTrack= false;
let autoJingles    = { start: false };
let autoJingleTimer= null;
let activeJingleProcess = null;
let isDownloading  = false;
let downloadQueue  = [];
const clients      = new Set();
const streamClients= new Set();

// ── Seed tracks ───────────────────────────────────────────────────────────────
function seedQueue() {
  return [
    { title: 'Ozigizaga',              artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Ozigizaga Ijaw highlife' },
    { title: 'Earth Song',             artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Earth Song Ijaw' },
    { title: 'Paddle of the Niger Delta', artist: 'Barrister Smooth', youtubeQuery: 'Chief Barrister Smooth Ijaw highlife Niger Delta' },
    { title: 'Tompolo',                artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Tompolo Ijaw' },
    { title: 'Halo Halo',             artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Halo Halo Ijaw' },
    { title: 'Ijaw Cultural Heritage', artist: 'Barrister Smooth', youtubeQuery: 'Barrister Smooth Ijaw cultural highlife best' },
    { title: 'Adaka Boro',             artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Adaka Boro' },
    { title: 'HighLife',               artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan HighLife Ijaw Afro Teme' },
    { title: 'Miss You',               artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Miss You Thousand Voice' },
    { title: 'Miekemedonmo',           artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Miekemedonmo' }
  ].map(t => ({ ...t, id: Math.random().toString(36).slice(2), status: 'pending', duration: 'Unknown' }));
}

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(queueFile)) {
      const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) queue = saved;
    }
    if (fs.existsSync(stateFile)) {
      const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      volume       = Number(d.volume || 80);
      if (isNaN(volume)) volume = 80;
      libraryIndex = d.libraryIndex || 0;
      autoJingles  = d.autoJingles  || { start: false };
    }
    if (fs.existsSync(playlistsFile)) playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
    if (fs.existsSync(newsFile)) {
      news = JSON.parse(fs.readFileSync(newsFile, 'utf8'));
    } else {
      news = [{ id: 'n1', date: new Date().toISOString(), status: 'news',
                title: 'BUKUMA RADIO GOES GLOBAL',
                summary: 'Agum Bukuma Radio now streams to the world.', content: 'We are live.' }];
      saveNews();
    }
    queue.forEach(t => {
      if (t.status === 'downloading') t.status = 'pending';
      if (t.status === 'ready' && t.localPath && !fs.existsSync(t.localPath)) {
        t.status = 'pending'; t.localPath = null;
      }
    });
    if (libraryIndex >= queue.length) libraryIndex = 0;
  } catch(e) { console.error('[INIT] loadState error:', e.message); }
}
function saveState() {
  try {
    fs.writeFileSync(stateFile,  JSON.stringify({ volume, autoJingles, isPlaying, libraryIndex }, null, 2));
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  } catch(e) {}
}
function savePlaylists() { try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {} }
function saveNews()      { try { fs.writeFileSync(newsFile,      JSON.stringify(news,      null, 2)); } catch(e) {} }

const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

// ── Broadcast ──────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function getStatus() {
  return {
    type: 'status', isPlaying, volume,
    queue: queue.map((t, i) => ({ ...t, isNowPlaying: i === libraryIndex && isPlaying })),
    libraryIndex, currentTrack, autoJingles, timestamp: Date.now()
  };
}

// ── Scout: background downloader ──────────────────────────────────────────────
// FIX: use spawn() array args for yt-dlp — no shell, no metachar injection
function enqueueDownload(track) {
  if (!track || track.status === 'ready' || track.status === 'downloading') return;
  if (downloadQueue.find(t => t.id === track.id)) return;
  downloadQueue.push(track);
  processDownloadQueue();
}
function processDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) return;
  const track = downloadQueue.shift();
  const live = queue.find(t => t.id === track.id);
  if (!live || live.status === 'ready') { processDownloadQueue(); return; }
  isDownloading = true;
  live.status = 'downloading';

  // Sanitise filename: strip non-alphanumeric, collapse whitespace to underscore
  const cleanTitle = (live.artist + ' - ' + live.title)
    .replace(/[^a-z0-9 _-]/gi, '_').replace(/\s+/g, '_');
  const localPath = path.join(downloadsDir, cleanTitle + '.mp3');

  if (fs.existsSync(localPath)) {
    live.status = 'ready'; live.localPath = localPath;
    saveState(); broadcast(getStatus());
    isDownloading = false; processDownloadQueue(); return;
  }

  // FIX: use spawn with args array — shell metacharacters in queries/URLs are safe
  const query = live.youtubeQuery || (live.artist + ' ' + live.title);
  const ytArgs = [
    '-x', '--audio-format', 'mp3',
    '--no-playlist', '--ignore-errors', '--geo-bypass', '--no-check-certificates',
    '--extractor-args', 'youtube:player_client=default,android_sdkless',
    '-o', localPath,
    'ytsearch1:' + query
  ];
  console.log('[SCOUT] Downloading: ' + live.title);

  const ytProc = spawn(YTDLP_PATH, ytArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let ytErr = '';
  ytProc.stderr.on('data', d => { ytErr += d.toString(); });
  ytProc.on('close', code => {
    const ok = code === 0 && fs.existsSync(localPath);
    live.status = ok ? 'ready' : 'error';
    if (ok) live.localPath = localPath;
    if (!ok) console.warn('[SCOUT] Failed: ' + live.title + ' code=' + code + ' err=' + ytErr.slice(0,200));
    else console.log('[SCOUT] Ready: ' + live.title);
    saveState(); broadcast(getStatus());
    isDownloading = false; processDownloadQueue();
  });
  ytProc.on('error', err => {
    live.status = 'error';
    console.error('[SCOUT] spawn error:', err.message);
    saveState(); broadcast(getStatus());
    isDownloading = false; processDownloadQueue();
  });

  // Timeout: kill if takes too long
  const killTimer = setTimeout(() => {
    console.warn('[SCOUT] Download timeout, killing: ' + live.title);
    try { ytProc.kill('SIGKILL'); } catch(e) {}
  }, 180000);
  ytProc.on('close', () => clearTimeout(killTimer));
}

let scoutTimer = null;
function startScout() {
  if (scoutTimer) clearInterval(scoutTimer);
  scoutTimer = setInterval(() => {
    for (let i = 0; i < 3; i++) {
      const idx = (libraryIndex + i) % (queue.length || 1);
      if (queue[idx] && queue[idx].status === 'pending') enqueueDownload(queue[idx]);
    }
  }, 10000);
        }

// ── The Player ─────────────────────────────────────────────────────────────────
function playTrack() {
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  if (isStartingTrack) { console.log('[PLAYER] guard: already starting'); return; }
  if (!isPlaying)      { console.log('[PLAYER] guard: not playing');       return; }
  if (queue.length === 0) return;
  if (libraryIndex >= queue.length) libraryIndex = 0;

  const track = queue[libraryIndex];

  if (track.status !== 'ready' || !track.localPath || !fs.existsSync(track.localPath)) {
    if (track.status === 'pending' || track.status === 'downloading') {
      enqueueDownload(track);
      console.log('[PLAYER] Waiting for: ' + track.title + ' (' + track.status + ')');
      playNextTimeout = setTimeout(playTrack, 3000);
      return;
    }
    if (track.status === 'error') {
      const nonErrorExists = queue.some(t => t.status !== 'error');
      if (!nonErrorExists) {
        console.log('[PLAYER] All tracks errored — resetting to pending');
        queue.forEach(t => { t.status = 'pending'; t.localPath = null; });
        saveState(); broadcast(getStatus());
        playNextTimeout = setTimeout(playTrack, 15000);
        return;
      }
      let next = (libraryIndex + 1) % queue.length;
      let scanned = 0;
      while (queue[next].status === 'error' && scanned < queue.length) {
        next = (next + 1) % queue.length;
        scanned++;
      }
      console.log('[PLAYER] Skipping ' + (scanned + 1) + ' errored, jumping to index ' + next);
      libraryIndex = next;
      saveState();
      playNextTimeout = setTimeout(playTrack, 500);
      return;
    }
    // status='ready' but file missing — re-queue download
    track.status = 'pending'; track.localPath = null;
    enqueueDownload(track);
    playNextTimeout = setTimeout(playTrack, 3000);
    return;
  }

  isStartingTrack = true;
  currentTrack = { ...track };
  broadcast({ type: 'nowPlaying', track: currentTrack });
  broadcast(getStatus());
  console.log('[PLAYER] Playing: ' + currentTrack.title);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', currentTrack.localPath,
    '-af', 'volume=' + (volume / 100),
    '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    'pipe:1'
  ];

  let proc;
  try {
    proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch(spawnErr) {
    isStartingTrack = false;
    console.error('[PLAYER] spawn failed:', spawnErr.message);
    if (isPlaying) playNextTimeout = setTimeout(playTrack, 3000);
    return;
  }

  currentProcess  = proc;
  isStartingTrack = false;
  let bytesOut    = 0;

  proc.stdout.on('data', chunk => {
    bytesOut += chunk.length;
    const dead = [];
    streamClients.forEach(client => {
      try {
        const backlog = (client.socket && client.socket.writableLength) || 0;
        if (backlog > 2 * 1024 * 1024) { dead.push(client); return; }
        if (!client.writableEnded) client.write(chunk);
      } catch(e) { dead.push(client); }
    });
    dead.forEach(c => { try { c.end(); } catch(e){} streamClients.delete(c); });
  });

  proc.on('close', code => {
    if (currentProcess !== proc) return;
    currentProcess = null;
    console.log('[PLAYER] Finished: ' + (currentTrack ? currentTrack.title : '?') +
      ' (' + bytesOut + ' bytes, code ' + code + ')');
    if (!isPlaying) return;

    if (bytesOut < 8192) {
      console.warn('[PLAYER] Short play (' + bytesOut + ' bytes) — marking error');
      const t = queue.find(q => q.id === currentTrack.id);
      if (t) t.status = 'error';
      saveState(); broadcast(getStatus());
      libraryIndex = (libraryIndex + 1) % queue.length;
      playNextTimeout = setTimeout(playTrack, 1000);
      return;
    }

    libraryIndex = (libraryIndex + 1) % queue.length;
    saveState(); broadcast(getStatus());
    playNextTimeout = setTimeout(playTrack, 500);
  });

  proc.on('error', err => {
    if (currentProcess !== proc) return;
    currentProcess = null; isStartingTrack = false;
    console.error('[PLAYER] FFmpeg error:', err.message);
    if (!isPlaying) return;
    playNextTimeout = setTimeout(playTrack, 3000);
  });

  proc.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg) console.log('[FFMPEG] ' + msg);
  });
}

function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  if (queue.length === 0) { queue = seedQueue(); saveState(); }
  if (libraryIndex >= queue.length) libraryIndex = 0;
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  saveState(); broadcast(getStatus()); playTrack();
}

function stopPlayback() {
  isPlaying = false;
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  if (currentProcess) {
    const p = currentProcess; currentProcess = null;
    p.removeAllListeners(); try { p.kill('SIGKILL'); } catch(e) {}
  }
  isStartingTrack = false; currentTrack = null;
  saveState(); broadcast(getStatus());
}

function skipTrack() {
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  const old = currentProcess; currentProcess = null; isStartingTrack = false;
  if (old) { old.removeAllListeners(); try { old.kill('SIGKILL'); } catch(e) {} }
  libraryIndex = (libraryIndex + 1) % (queue.length || 1);
  saveState(); broadcast(getStatus());
  if (isPlaying) playTrack();
}

function setVolume(val) {
  volume = Math.min(100, Math.max(0, parseInt(val) || 80));
  saveState(); broadcast({ type: 'volume', value: volume });
          }

// ── Jingles ────────────────────────────────────────────────────────────────────
function startAutoJingleLoop() {
  if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
  if (!autoJingles.start) return;
  const next = Math.floor(Math.random() * 120000) + 120000;
  autoJingleTimer = setTimeout(() => { dropJingle(); startAutoJingleLoop(); }, next);
}
function dropJingle(jingleFile) {
  jingleFile = jingleFile || 'ident.mp3';
  if (!isPlaying || !currentProcess) return;
  if (activeJingleProcess) return;
  let p = path.join(__dirname, 'public/app', jingleFile);
  if (!fs.existsSync(p)) p = path.join(dataDir, 'jingles', jingleFile);
  if (!fs.existsSync(p)) return;
  try { currentProcess.stdout.pause(); } catch(e) {}
  const jArgs = ['-hide_banner', '-loglevel', 'error', '-i', p, '-f', 'mp3', '-b:a', '128k', 'pipe:1'];
  activeJingleProcess = spawn(FFMPEG_PATH, jArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
  activeJingleProcess.stdout.on('data', chunk => {
    streamClients.forEach(c => { try { if (!c.writableEnded) c.write(chunk); } catch(e) {} });
  });
  activeJingleProcess.on('close', () => {
    activeJingleProcess = null;
    if (currentProcess) { try { currentProcess.stdout.resume(); } catch(e) {} }
  });
}

// ── Stream handler ─────────────────────────────────────────────────────────────
function streamHandler(req, res) {
  res.setHeader('Content-Type',           'audio/mpeg');
  res.setHeader('Transfer-Encoding',      'chunked');
  res.setHeader('Cache-Control',          'no-cache, no-store');
  res.setHeader('Connection',             'keep-alive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('icy-name',    'Agum Bukuma Radio');
  res.setHeader('icy-genre',   'Ijaw Highlife');
  res.setHeader('icy-url',     'https://bukuma.radio');
  res.setHeader('icy-metaint', '0');
  streamClients.add(res);
  broadcast({ type: 'listeners', count: streamClients.size });
  req.on('close', () => {
    streamClients.delete(res);
    broadcast({ type: 'listeners', count: streamClients.size });
  });
  console.log('[STREAM] Listener joined. Total: ' + streamClients.size);
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify(getStatus()));
  broadcast({ type: 'listeners', count: streamClients.size });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.action) {
        case 'adminLogin':
          if (msg.password === ADMIN_PASSWORD) { ws.isAdmin = true; ws.send(JSON.stringify({ type: 'auth', success: true })); }
          break;
        case 'getStatus': ws.send(JSON.stringify(getStatus())); break;
        case 'play':   startPlayback(); break;
        case 'pause':  stopPlayback();  break;
        case 'skip':   skipTrack();     break;
        case 'volume': setVolume(msg.value); break;
        case 'toggleAutoJingles':
          autoJingles.start = !autoJingles.start;
          saveState();
          if (autoJingles.start) startAutoJingleLoop();
          else if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
          broadcast(getStatus());
          break;
        case 'addSong':
          if (msg.song) {
            const t = { id: Math.random().toString(36).slice(2), status: 'pending', ...msg.song };
            queue.push(t); saveState(); broadcast(getStatus()); enqueueDownload(t);
            if (!isPlaying) startPlayback();
          }
          break;
      }
    } catch(e) {}
  });
  ws.on('close', () => { clients.delete(ws); broadcast({ type: 'listeners', count: streamClients.size }); });
});

// ── HTTP Routes ────────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/stream',     streamHandler);
app.get('/api/stream', streamHandler);
app.get('/api/status', (req, res) => res.json(getStatus()));
app.get('/api/queue',  (req, res) => res.json({ queue }));

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false });
});
app.get( '/api/admin/verify', requireAuth, (req, res) => res.json({ success: true }));
app.post('/api/play',       requireAuth, (req, res) => { startPlayback(); res.json({ success: true }); });
app.post('/api/pause',      requireAuth, (req, res) => { stopPlayback();  res.json({ success: true }); });
app.post('/api/skip',       requireAuth, (req, res) => { skipTrack();     res.json({ success: true }); });
app.post('/api/queue/skip', requireAuth, (req, res) => { skipTrack();     res.json({ success: true }); });
app.post('/api/volume',     requireAuth, (req, res) => { setVolume(req.body.value); res.json({ success: true, volume }); });

app.post('/api/admin/onair', requireAuth, (req, res) => {
  if (req.body.state) startPlayback(); else stopPlayback();
  res.json({ success: true, isPlaying });
});
app.post('/api/admin/panic', requireAuth, (req, res) => {
  stopPlayback(); queue = seedQueue(); libraryIndex = 0; saveState(); broadcast(getStatus());
  res.json({ success: true });
});
app.post('/api/queue', requireAuth, (req, res) => {
  const entry = { id: Math.random().toString(36).slice(2), status: 'pending',
    title: req.body.title || 'Unknown', artist: req.body.artist || 'Unknown',
    youtubeQuery: req.body.youtubeQuery || req.body.title };
  queue.push(entry); saveState(); broadcast(getStatus()); enqueueDownload(entry);
  if (!isPlaying) startPlayback();
  res.json({ success: true, id: entry.id });
});
app.post('/api/queue/add', requireAuth, (req, res) => {
  const { videoId, title, duration, url } = req.body;
  const vid = videoId || (url && url.match(/[?&]v=([^&]+)/)?.[1]);
  const entry = { id: Math.random().toString(36).slice(2), status: 'pending',
    title: title || 'Unknown', artist: 'YouTube',
    youtubeQuery: vid ? ('https://www.youtube.com/watch?v=' + vid) : (url || title),
    duration: duration || '' };
  queue.push(entry); saveState(); broadcast(getStatus()); enqueueDownload(entry);
  if (!isPlaying) startPlayback();
  res.json({ success: true, id: entry.id });
});
app.delete('/api/queue/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const wasPlaying = currentTrack && currentTrack.id === id;
  queue = queue.filter(t => t.id !== id);
  if (libraryIndex >= queue.length) libraryIndex = Math.max(0, queue.length - 1);
  saveState();
  if (wasPlaying && isPlaying) skipTrack(); else broadcast(getStatus());
  res.json({ success: true });
});
app.post('/api/queue/:id/play-now', requireAuth, (req, res) => {
  const idx = queue.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  if (queue[idx].status !== 'ready') return res.status(400).json({ success: false, error: 'Not ready' });
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  const old = currentProcess; currentProcess = null; isStartingTrack = false;
  if (old) { old.removeAllListeners(); try { old.kill('SIGKILL'); } catch(e) {} }
  libraryIndex = idx; isPlaying = true; saveState(); playTrack();
  res.json({ success: true });
});
app.post('/api/upload', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname);
  const newPath = path.join(downloadsDir, req.file.filename + ext);
  fs.renameSync(req.file.path, newPath);
  let title = req.body.title || req.file.originalname.replace(ext, '');
  let artist = req.body.artist || 'Local Upload';
  try {
    const mm = await import('music-metadata');
    const md = await mm.parseFile(newPath);
    if (md.common.title)  title  = md.common.title;
    if (md.common.artist) artist = md.common.artist;
  } catch(e) {}
  const track = { id: Math.random().toString(36).slice(2), status: 'ready',
    title, artist, youtubeQuery: 'LOCAL', localPath: newPath };
  queue.push(track); saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, track });
});
app.get('/api/youtube/search', (req, res) => {
  const raw = req.query.q;
  if (!raw) return res.json({ results: [] });
  // Sanitise: strip only characters dangerous to yt-dlp argument parsing
  const q = String(raw).replace(/["']/g, '');
  // FIX: use spawn args array — no shell, no & injection
  const ytArgs = [
    '--quiet', '--no-warnings', '--flat-playlist',
    '--print', '%(id)s|||%(title)s|||%(duration_string)s',
    '--extractor-args', 'youtube:player_client=default,android_sdkless',
    'ytsearch5:' + q
  ];
  const ytProc = spawn(YTDLP_PATH, ytArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  ytProc.stdout.on('data', d => { out += d.toString(); });
  ytProc.on('close', () => {
    if (!out.trim()) return res.json({ results: [] });
    const results = out.trim().split('\n').filter(l => l.includes('|||')).map(line => {
      const parts = line.split('|||').map(s => s ? s.trim() : '');
      return { videoId: parts[0], title: parts[1],
        url: 'https://www.youtube.com/watch?v=' + parts[0],
        thumbnail: 'https://i.ytimg.com/vi/' + parts[0] + '/mqdefault.jpg',
        duration: parts[2] };
    });
    res.json({ results });
  });
  ytProc.on('error', () => res.json({ results: [] }));
  setTimeout(() => { try { ytProc.kill(); } catch(e){} }, 30000);
});

app.get('/api/herald',  (req, res) => res.json({ news }));
app.post('/api/herald', requireAuth, (req, res) => {
  const item = { id: Date.now().toString(), date: new Date().toISOString(), ...req.body };
  news.unshift(item); saveNews(); res.json({ success: true, item });
});
app.delete('/api/herald/:id', requireAuth, (req, res) => {
  news = news.filter(n => n.id !== req.params.id); saveNews(); res.json({ success: true });
});
app.get('/api/vault', (req, res) => {
  const pl = playlists[0] || { tracks: [] };
  res.json({ tracks: pl.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist,
    duration: t.duration, thumbnail: t.thumbnail, status: 'ready' })) });
});

function handleGetPlaylists(req, res)   { res.json({ playlists }); }
function handleSavePlaylist(req, res)   {
  const pl = { id: Date.now().toString(), name: req.body.name, tracks: [...queue] };
  playlists.push(pl); savePlaylists(); res.json({ success: true, playlists });
}
function handleLoadPlaylist(req, res)   {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ success: false });
  queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
  libraryIndex = 0; saveState(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true });
}
function handleAddTrackToPlaylist(req, res) {
  const pl = playlists.find(p => p.id === req.params.id);
  if (!pl) return res.status(404).json({ success: false });
  pl.tracks = pl.tracks || []; pl.tracks.push(req.body.track); savePlaylists();
  res.json({ success: true, count: pl.tracks.length });
}
app.get( '/api/playlists',                requireAuth, handleGetPlaylists);
app.post('/api/playlists',                requireAuth, handleSavePlaylist);
app.post('/api/playlists/:id/load',       requireAuth, handleLoadPlaylist);
app.post('/api/playlists/:id/add-track',  requireAuth, handleAddTrackToPlaylist);
app.get( '/api/admin/playlists',              requireAuth, handleGetPlaylists);
app.post('/api/admin/playlists',              requireAuth, handleSavePlaylist);
app.post('/api/admin/playlists/:id/load',     requireAuth, handleLoadPlaylist);
app.post('/api/admin/playlists/:id/add-track',requireAuth, handleAddTrackToPlaylist);

app.get( '/api/admin/programs', requireAuth, (req, res) => res.json({ programs }));
app.post('/api/admin/programs', requireAuth, (req, res) => { programs = req.body.programs || []; res.json({ success: true }); });
app.post('/api/admin/programs/reset', requireAuth, (req, res) => { libraryIndex = 0; saveState(); res.json({ success: true }); });

app.post('/api/admin/drive/play', requireAuth, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ success: false });
  const track = { id: Math.random().toString(36).slice(2), status: 'ready',
    title: path.basename(filePath, path.extname(filePath)), artist: 'Drive',
    youtubeQuery: 'LOCAL', localPath: filePath };
  const insertIdx = libraryIndex + 1;
  queue.splice(insertIdx, 0, track);
  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
  const old = currentProcess; currentProcess = null; isStartingTrack = false;
  if (old) { old.removeAllListeners(); try { old.kill('SIGKILL'); } catch(e) {} }
  libraryIndex = insertIdx; isPlaying = true; saveState(); broadcast(getStatus()); playTrack();
  res.json({ success: true });
});
app.post('/api/duck',       requireAuth, (req, res) => res.json({ success: true }));
app.post('/api/volume/mic', requireAuth, (req, res) => res.json({ success: true }));
app.get('/api/admin/drive', requireAuth, (req, res) => {
  const dirs = [{ name: 'Downloads', path: downloadsDir }, { name: 'Jingles', path: path.join(dataDir, 'jingles') }];
  let files = [];
  dirs.forEach(dp => {
    if (!fs.existsSync(dp.path)) return;
    fs.readdirSync(dp.path).forEach(f => {
      if (!['.mp3','.wav','.ogg','.m4a'].includes(path.extname(f).toLowerCase())) return;
      const stat = fs.statSync(path.join(dp.path, f));
      if (stat.isFile()) files.push({ name: f, size: stat.size, category: dp.name, fullPath: path.join(dp.path, f) });
    });
  });
  res.json({ files });
});
app.post('/api/jingle/:id', requireAuth, (req, res) => {
  const map = { '01': 'ident.mp3', '02': 'jingle02.mp3', '03': 'jingle03.mp3' };
  dropJingle(map[req.params.id] || (req.params.id + '.mp3'));
  res.json({ success: true });
});
app.get('/health', (req, res) => res.json({
  status: 'ok', uptime: process.uptime(), isPlaying,
  currentTrack: currentTrack ? currentTrack.title : null,
  queueLength: queue.length, streamClients: streamClients.size,
  downloadQueueLength: downloadQueue.length, isDownloading
}));

// ── Boot ───────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('[BUKUMA] Internet Radio — port ' + PORT);
  loadState();
  startScout();
  if (autoJingles.start) startAutoJingleLoop();
  setTimeout(() => {
    if (isPlaying && queue.length > 0 && !currentProcess && !isStartingTrack) {
      console.log('[BOOT] Resuming playback');
      playTrack();
    }
  }, 5000);
});
