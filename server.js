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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// State
let queue = [];
  let currentTrack = null;
let isPlaying = false;
let volume = 80;
let currentProcess = null;
const clients = new Set();
const streamClients = new Set();
let listeners = 0;
let autoJingles = { start: true, random: true };
let jingleTimer = null;
let loopEnabled = false;
let loopPlaylistId = null;
let playHistory = [];
let songRequests = [];
let scheduleSlots = [];
let schedulerEnabled = false;
let scheduleTimer = null;
let audioSettings = { fadeIn: 2, fadeOut: 3, crossfade: 2, volume: 85 };
let playlists = [];

const REX_LAWSON_SONGS = [
  { id: '1', title: 'Jolly', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Jolly highlife', duration: '5:23' },
  { id: '2', title: 'Warri', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Warri highlife', duration: '6:12' },
  { id: '3', title: 'Kelegbe Megbe', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Kelegbe Megbe', duration: '4:45' },
  { id: '4', title: 'So Tey', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson So Tey highlife', duration: '5:58' }
];

const dataDir = path.join(__dirname, 'data');
const queueFile = path.join(dataDir, 'queue.json');
const stateFile = path.join(dataDir, 'state.json');
const playlistsFile = path.join(dataDir, 'playlists.json');
const scheduleFile = path.join(dataDir, 'schedule.json');
const historyFile = path.join(dataDir, 'history.json');
const requestsFile = path.join(dataDir, 'requests.json');
const registeredListenersFile = path.join(dataDir, 'registered_listeners.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  function loadState() {
      try {
            queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [...REX_LAWSON_SONGS];
            if (!queue || queue.length === 0) queue = [...REX_LAWSON_SONGS];
            if (!fs.existsSync(queueFile)) saveQueue();
            const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
            volume = s.volume || 80;
            if (s.autoJingles) autoJingles = s.autoJingles;
            if (s.audioSettings) audioSettings = s.audioSettings;
                    playlists = fs.existsSync(playlistsFile) ? JSON.parse(fs.readFileSync(playlistsFile, 'utf8')) : [];
            const sched = fs.existsSync(scheduleFile) ? JSON.parse(fs.readFileSync(scheduleFile, 'utf8')) : {};
            scheduleSlots = sched.slots || [];
                  schedulerEnabled = sched.enabled || false;
    playHistory = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
                  songRequests = fs.existsSync(requestsFile) ? JSON.parse(fs.readFileSync(requestsFile, 'utf8')) : [];
              } catch(e) {
            queue = [...REX_LAWSON_SONGS];
      }
  }

function saveQueue() { try { fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2)); } catch(e) {} }
                               function savePlaylists() { try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {} }
function saveSchedule() { try { fs.writeFileSync(scheduleFile, JSON.stringify({ slots: scheduleSlots, enabled: schedulerEnabled }, null, 2)); } catch(e) {} }
function saveHistory() { try { fs.writeFileSync(historyFile, JSON.stringify(playHistory.slice(0, 200), null, 2)); } catch(e) {} }
function saveRequests() { try { fs.writeFileSync(requestsFile, JSON.stringify(songRequests, null, 2)); } catch(e) {} }
function saveState() {
      try { fs.writeFileSync(stateFile, JSON.stringify({ volume, isPlaying, currentTrack, autoJingles, audioSettings }, null, 2)); } catch(e) {}
}

let jingles = [];
const jinglesFile = path.join(dataDir, 'jingles.json');
if (fs.existsSync(jinglesFile)) { try { jingles = JSON.parse(fs.readFileSync(jinglesFile, 'utf8')); } catch(e){} }
function saveJingles() { try { fs.writeFileSync(jinglesFile, JSON.stringify(jingles)); } catch(e){} }

                                                                               const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

function broadcast(msg) {
    const data = JSON.stringify(msg);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function scheduleRandomJingle() {
    clearTimeout(jingleTimer);
    if (!isPlaying || !autoJingles.random || jingles.length === 0) return;
    const delay = Math.floor(Math.random() * (240000 - 120000 + 1) + 120000);
    jingleTimer = setTimeout(() => {
          if (isPlaying && autoJingles.random && jingles.length > 0) {
                  const randomJingle = jingles[Math.floor(Math.random() * jingles.length)];
                  broadcast({ type: 'playJingle', url: randomJingle.url });
          }
          scheduleRandomJingle();
    }, delay);
}

function getStatus() {
                return { type: 'status', currentTrack, queue, isPlaying, volume, listeners, autoJingles, timestamp: Date.now() };
}

// Auth middleware
function requireAdmin(req, res, next) {
                          const auth = req.headers.authorization || req.headers['x-admin-password'];
    if (auth === ADMIN_PASSWORD) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false });
});

wss.on('connection', (ws) => {
    ws.id = 'L-' + Math.random().toString(36).substr(2, 9);
    clients.add(ws);
    listeners = clients.size;
    ws.send(JSON.stringify(getStatus()));
    broadcast({ type: 'listeners', count: listeners });
    ws.on('message', (data, isBinary) => {
          if (isBinary) {
                  if (ws.isAdmin) {
                            clients.forEach(c => { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(data); });
                  } else {
                            clients.forEach(c => { if (c.isAdmin && c.readyState === WebSocket.OPEN) c.send(data); });
                  }
                  return;
          }
          try { handleCommand(JSON.parse(data.toString()), ws); } catch(e) {}
    });
    ws.on('close', () => {
          clients.delete(ws);
          listeners = clients.size;
          broadcast({ type: 'listeners', count: listeners });
    });
});

function handleCommand(msg, ws) {
  switch(msg.action) {
    case 'requestCallIn':
            clients.forEach(c => { if (c.isAdmin && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'callInRequest', listenerId: ws.id, name: msg.name || 'Anonymous Listener' })); });
            break;
    case 'acceptCall':
            clients.forEach(c => { if (c.id === msg.listenerId && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'callAccepted' })); });
            break;
    case 'hangUpCall':
            clients.forEach(c => { if (c.id === msg.listenerId && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'callEnded' })); });
            break;
    case 'adminLogin':
            if (msg.password === ADMIN_PASSWORD) {
                      ws.isAdmin = true;
                      ws.send(JSON.stringify({ type: 'auth', success: true }));
            }
            break;
    case 'duck': broadcast({ action: 'duck', active: msg.active }); break;
    case 'play': if (!isPlaying) startPlayback(); break;
    case 'pause': pausePlayback(); break;
    case 'skip': skipTrack(); break;
    case 'volume':
                                  volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
            saveState();
            broadcast({ type: 'volume', value: volume });
            break;
    case 'addSong': addSong(msg.song); break;
          case 'removeSong': removeSong(msg.id); break;
    case 'reorder': reorderQueue(msg.from, msg.to); break;
    case 'setAutoJingles':
            autoJingles = msg.settings;
            saveState();
            broadcast(getStatus());
            if (isPlaying && autoJingles.random) scheduleRandomJingle();
            else clearTimeout(jingleTimer);
            break;
    case 'getStatus':
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(getStatus()));
            break;
  }
}

async function getYouTubeUrl(query) {
    const ytdlpPath = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\yt-dlp.exe';
    return new Promise((resolve, reject) => {
          const q = query.startsWith('http') ? `"${query}"` : `"ytsearch1:${query}"`;
          console.log('[YT-DLP] Resolving:', q);
          exec(`"${ytdlpPath}" --get-url --format bestaudio ${q}`, { timeout: 60000 }, (err, stdout, stderr) => {
                  if (err) { console.error('[YT-DLP] ERROR:', err.message); reject(err); }
                  else {
                      const url = stdout.trim().split('\n')[0];
                      console.log('[YT-DLP] Resolved OK, URL length:', url.length);
                      resolve(url);
                  }
          });
    });
}

async function startPlayback() {
    if (queue.length === 0) { console.log('[PLAY] Queue is empty'); broadcast({ type: 'error', message: 'Queue is empty' }); return; }
    console.log('[PLAY] Starting playback, queue:', queue.length, 'tracks');
    isPlaying = true;
    playNext();
}

async function playNext() {
    if (!isPlaying || queue.length === 0) {
          if (loopEnabled) {
                  const loopPl = loopPlaylistId ? playlists.find(p => p.id === loopPlaylistId) : null;
                  if (loopPl && loopPl.tracks.length > 0) {
                            queue = loopPl.tracks.map(t => ({ ...t, id: Date.now().toString() + Math.random() }));
                            saveQueue();
                            playNext();
                            return;
                  }
          }
          console.log('[PLAY] Queue exhausted, stopping.');
          isPlaying = false;
          currentTrack = null;
          broadcast(getStatus());
          saveState();
          return;
    }
    currentTrack = { ...queue[0] };
    console.log('[PLAY] Now playing:', currentTrack.title, '-', currentTrack.artist);
    broadcast({ type: 'nowPlaying', track: currentTrack });
    broadcast(getStatus());
    saveState();
    playHistory.unshift({ ...currentTrack, playedAt: new Date().toISOString() });
    if (playHistory.length > 200) playHistory = playHistory.slice(0, 200);
    saveHistory();
    broadcast({ type: 'history_update' });
    try {
          const q = currentTrack.youtubeQuery || `${currentTrack.artist} ${currentTrack.title}`;
          broadcast({ type: 'loading', message: `Loading: ${currentTrack.title}...` });
          const url = await getYouTubeUrl(q);
          if (!isPlaying) return;
          if (autoJingles.start && jingles.length > 0) {
                  const startJingle = jingles[Math.floor(Math.random() * jingles.length)];
                  broadcast({ type: 'playJingle', url: startJingle.url });
          }
          scheduleRandomJingle();
          if (currentProcess) { try { currentProcess.kill('SIGKILL'); } catch(e) {} }
          const ffmpegPath = 'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.WinGet.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe';
          console.log('[FFMPEG] Spawning for:', currentTrack.title);
          currentProcess = spawn(ffmpegPath, ['-reconnect', '1', '-reconnect_streamed', '1', '-i', url, '-af', `volume=${volume/100}`, '-f', 'mp3', '-b:a', '128k', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
          currentProcess.stdout.on('data', (chunk) => {
                  streamClients.forEach(res => { try { res.write(chunk); } catch(e) { streamClients.delete(res); } });
          });
          currentProcess.stderr.on('data', (d) => {});
          currentProcess.on('close', (code) => {
                  console.log('[FFMPEG] Process closed for:', currentTrack?.title, 'code:', code);
                  if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 500); }
          });
          currentProcess.on('error', (e) => {
                  console.error('[FFMPEG] Error:', e.message);
                  broadcast({ type: 'error', message: 'Playback error: ' + e.message });
                  if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 2000); }
          });
    } catch(e) {
          console.error('[PLAY] CATCH ERROR for', currentTrack?.title, ':', e.message);
          broadcast({ type: 'error', message: 'Could not load: ' + (currentTrack ? currentTrack.title : 'track') });
          if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 2000); }
    }
}

function pausePlayback() {
    isPlaying = false;
    if (currentProcess) { try { currentProcess.kill('SIGKILL'); currentProcess = null; } catch(e) {} }
    broadcast(getStatus());
    saveState();
}

function skipTrack() {
    if (currentProcess) { try { currentProcess.kill('SIGKILL'); currentProcess = null; } catch(e) {} }
    queue.shift();
    saveQueue();
    if (isPlaying) playNext();
    else { currentTrack = null; broadcast(getStatus()); }
}

function addSong(song) {
    if (!song || !song.title) return;
    queue.push({ id: Date.now().toString(), title: song.title, artist: song.artist || 'Unknown', youtubeQuery: song.youtubeQuery || `${song.artist} ${song.title}`, duration: song.duration || '?:??' });
    saveQueue();
    broadcast(getStatus());
}

function removeSong(id) {
    const idx = queue.findIndex(s => s.id === id);
    if (idx > 0) { queue.splice(idx, 1); saveQueue(); broadcast(getStatus()); }
}

function reorderQueue(from, to) {
    if (from < 1 || to < 1 || from >= queue.length || to >= queue.length) return;
    const [item] = queue.splice(from, 1);
    queue.splice(to, 0, item);
    saveQueue();
    broadcast(getStatus());
}

// ---- ROUTES ----

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    streamClients.add(res);
    req.on('close', () => streamClients.delete(res));
});

// Login
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.json({ success: false });
});

app.post('/api/register', (req, res) => {
    const { name, phone, village } = req.body;
    if (!name || !phone || !village) return res.json({ success: false, error: 'Name, phone, and village are required' });
    
    // Bukuma Village Captcha Validation
    const validVillages = [
        "okrigbo", "alaka", "anyama", "krigbo square", "alaka krigbo square",
        "zion city square", "zion city", "area omomema", "omomema", "ayama square",
        "ika square", "agbulabulo", "okpunadike square", "amkpa square",
        "okpuruta square", "onugulo", "anangulo"
    ];
    
    const v = village.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '');
    const isValid = validVillages.some(valid => v === valid || v.includes(valid));
    
    if (!isValid) {
        return res.json({ success: false, error: 'Sorry, that is not a recognized Bukuma village. Activation Denied.' });
    }

    let registered = [];
    try {
        if (fs.existsSync(registeredListenersFile)) {
            registered = JSON.parse(fs.readFileSync(registeredListenersFile, 'utf8'));
        }
    } catch(e) {}
    registered.push({ name, phone, village, timestamp: new Date().toISOString() });
    try {
        fs.writeFileSync(registeredListenersFile, JSON.stringify(registered, null, 2));
    } catch(e) {}
    res.json({ success: true });
});

app.post('/api/duck', (req, res) => {
    broadcast({ action: 'duck', active: req.body.active });
    res.json({ success: true });
});

app.get('/api/status', (req, res) => res.json(getStatus()));

app.post('/api/play', (req, res) => {
    if (!isPlaying) startPlayback();
    res.json({ success: true, isPlaying });
});

app.post('/api/pause', (req, res) => {
    pausePlayback();
    res.json({ success: true, isPlaying });
});

app.post('/api/skip', (req, res) => {
    skipTrack();
    res.json({ success: true });
});

app.post('/api/volume', (req, res) => {
    volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80));
    saveState();
    broadcast({ type: 'volume', value: volume });
    res.json({ success: true, volume });
});

app.post('/api/queue/skip', requireAdmin, (req, res) => {
    skipTrack();
    res.json({ success: true });
});

// Queue GET
app.get('/api/queue', (req, res) => {
    res.json({ queue });
});

// Queue POST (add YouTube URL)
app.post('/api/queue', requireAdmin, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, error: 'No URL provided' });
    const id = Date.now().toString();
    const entry = { id, url, title: 'Loading...', artist: '', youtubeQuery: url, duration: '?' };
    queue.push(entry);
    saveQueue();
    broadcast(getStatus());
    // Resolve title in background
           exec(`yt-dlp --get-title --no-warnings "${url}" 2>/dev/null`, { timeout: 30000 }, (err, stdout) => {
                 if (!err && stdout.trim()) {
                         const idx = queue.findIndex(q => q.id === id);
                         if (idx !== -1) { queue[idx].title = stdout.trim(); queue[idx].youtubeQuery = stdout.trim(); saveQueue(); broadcast(getStatus()); }
                 }
           });
    res.json({ success: true, id });
});

// Queue bulk add
app.post('/api/queue/bulk', requireAdmin, (req, res) => {
    const { urls } = req.body;
    if (!Array.isArray(urls)) return res.json({ success: false });
    urls.forEach(url => {
          if (url && url.trim().startsWith('http')) {
                  const id = Date.now().toString() + Math.random();
                  queue.push({ id, url: url.trim(), title: url.trim(), artist: '', youtubeQuery: url.trim(), duration: '?' });
          }
    });
    saveQueue();
    broadcast(getStatus());
    res.json({ success: true, count: urls.length });
});

app.post('/api/queue/add', requireAdmin, (req, res) => {
    addSong(req.body);
    res.json({ success: true, queue });
});

app.delete('/api/queue/:id', requireAdmin, (req, res) => {
    removeSong(req.params.id);
    res.json({ success: true, queue });
});

// YouTube search
app.get('/api/youtube/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    exec(`yt-dlp "ytsearch5:${q}" --get-title --get-id --get-duration --no-warnings 2>/dev/null`, { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) return res.json({ results: [] });
          const lines = stdout.trim().split('\n');
          const results = [];
          for (let i = 0; i + 2 < lines.length; i += 3) {
                  const title = lines[i];
                  const vid = lines[i + 1];
                  const dur = lines[i + 2];
                  results.push({ title, url: `https://www.youtube.com/watch?v=${vid}`, thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, duration: dur });
          }
          res.json({ results });
    });
});

// Playlists
app.get('/api/playlists', (req, res) => res.json({ playlists }));

app.post('/api/playlists', requireAdmin, (req, res) => {
    const { name } = req.body;
    if (!name) return res.json({ success: false });
    const pl = { id: Date.now().toString(), name, tracks: [...queue] };
    playlists.push(pl);
    savePlaylists();
    res.json({ success: true, playlists });
});

app.post('/api/playlists/:id/load', requireAdmin, (req, res) => {
    const pl = playlists.find(p => p.id === req.params.id);
    if (!pl) return res.json({ success: false });
    queue = pl.tracks.map(t => ({ ...t, id: Date.now().toString() + Math.random() }));
    saveQueue();
    broadcast(getStatus());
    if (!isPlaying) startPlayback();
    res.json({ success: true });
});

app.delete('/api/playlists/:id', requireAdmin, (req, res) => {
    playlists = playlists.filter(p => p.id !== req.params.id);
    savePlaylists();
    res.json({ success: true, playlists });
});

// Loop
app.post('/api/loop/enable', requireAdmin, (req, res) => {
    loopEnabled = true;
    loopPlaylistId = req.body.playlistId || null;
    res.json({ success: true });
});

app.post('/api/loop/disable', requireAdmin, (req, res) => {
    loopEnabled = false;
    loopPlaylistId = null;
    res.json({ success: true });
});

// Schedule
app.get('/api/schedule', (req, res) => res.json({ slots: scheduleSlots, enabled: schedulerEnabled }));

app.put('/api/schedule', requireAdmin, (req, res) => {
    schedulerEnabled = !!req.body.enabled;
    saveSchedule();
    res.json({ success: true, enabled: schedulerEnabled });
});

app.post('/api/schedule/slot', requireAdmin, (req, res) => {
    const { day, time, playlistId, label } = req.body;
    if (!day || !time || !playlistId) return res.json({ success: false });
    scheduleSlots.push({ id: Date.now().toString(), day, time, playlistId, label: label || '' });
    saveSchedule();
    res.json({ success: true, slots: scheduleSlots });
});

app.delete('/api/schedule/slot/:id', requireAdmin, (req, res) => {
    scheduleSlots = scheduleSlots.filter(s => s.id !== req.params.id);
    saveSchedule();
    res.json({ success: true, slots: scheduleSlots });
});

// Audio settings
app.post('/api/audio/settings', requireAdmin, (req, res) => {
    audioSettings = { fadeIn: req.body.fadeIn || 2, fadeOut: req.body.fadeOut || 3, crossfade: req.body.crossfade || 2, volume: req.body.volume || 85 };
    saveState();
    res.json({ success: true });
});

// History
app.get('/api/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ history: playHistory.slice(0, limit) });
});

// Requests
app.get('/api/requests', (req, res) => res.json({ requests: songRequests }));

app.post('/api/requests', (req, res) => {
    const { song, listener } = req.body;
    if (!song) return res.json({ success: false });
    const r = { id: Date.now().toString(), song, listener: listener || 'Anonymous', status: 'pending', createdAt: new Date().toISOString() };
    songRequests.push(r);
    saveRequests();
    broadcast({ type: 'request_new' });
    res.json({ success: true, id: r.id });
});

app.post('/api/requests/:id', requireAdmin, (req, res) => {
    const { action } = req.body;
    const r = songRequests.find(x => x.id === req.params.id);
    if (!r) return res.json({ success: false });
    r.status = action === 'approve' ? 'approved' : 'rejected';
    if (action === 'approve') {
          queue.push({ id: Date.now().toString(), title: r.song, artist: 'Request', youtubeQuery: r.song, duration: '?' });
          saveQueue();
          broadcast(getStatus());
          if (!isPlaying) startPlayback();
    }
    saveRequests();
    res.json({ success: true });
});

// Jingles
app.get('/api/jingles', (req, res) => res.json({ jingles }));

app.post('/api/jingles', upload.single('jingle'), requireAdmin, (req, res) => {
    if (!req.file) return res.json({ success: false });
    const j = { id: Date.now().toString(), name: req.body.name || req.file.originalname, url: '/uploads/' + req.file.filename };
    jingles.push(j);
    saveJingles();
    res.json({ success: true, jingles });
});

app.post('/api/jingles/:id/play', requireAdmin, (req, res) => {
    const j = jingles.find(x => x.id === req.params.id);
    if (j) broadcast({ type: 'playJingle', url: j.url });
    res.json({ success: true });
});

app.post('/api/queue/rex-lawson', requireAdmin, (req, res) => {
    REX_LAWSON_SONGS.forEach(s => {
          if (!queue.find(q => q.title === s.title)) queue.push({ ...s, id: (Date.now() * Math.random()).toString() });
    });
    saveQueue();
    broadcast(getStatus());
    if (!isPlaying) startPlayback();
    res.json({ success: true, queue });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), isPlaying, currentTrack: currentTrack ? currentTrack.title : null, queueLength: queue.length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('BUKUMA RADIO running on port ' + PORT);
    loadState();
    setTimeout(() => {
          if (schedulerEnabled) startScheduler();
          if (!isPlaying && queue.length > 0) { console.log('Auto-starting...'); startPlayback(); }
    }, 500);
});

function startScheduler() {
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = setInterval(() => {
          if (!schedulerEnabled) return;
          const now = new Date();
          const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          const dayName = days[now.getDay()];
          const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
          scheduleSlots.forEach(slot => {
                  if ((slot.day === dayName || slot.day === 'everyday') && slot.time === timeStr) {
                            const pl = playlists.find(p => p.id === slot.playlistId);
                            if (pl) {
                                        queue = pl.tracks.map(t => ({ ...t, id: Date.now().toString() + Math.random() }));
                                        saveQueue();
                                        broadcast(getStatus());
                                        if (!isPlaying) startPlayback();
                            }
                  }
          });
    }, 60000);
}
