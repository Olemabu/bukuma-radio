const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// State
let queue = [];
let currentTrack = null;
let isPlaying = false;
let volume = 80;
let currentProcess = null;
const clients = new Set();
const streamClients = new Set();
let listeners = 0;

// Cardinal Rex Lawson top 4 popular songs
const REX_LAWSON_SONGS = [
  { id: '1', title: 'Jolly', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Jolly highlife', duration: '5:23' },
  { id: '2', title: 'Warri', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Warri highlife', duration: '6:12' },
  { id: '3', title: 'Kelegbe Megbe', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Kelegbe Megbe', duration: '4:45' },
  { id: '4', title: 'So Tey', artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson So Tey highlife', duration: '5:58' }
];

const dataDir = path.join(__dirname, 'data');
const queueFile = path.join(dataDir, 'queue.json');
const stateFile = path.join(dataDir, 'state.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadState() {
  try {
    queue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [...REX_LAWSON_SONGS];
    if (!fs.existsSync(queueFile)) saveQueue();
    const s = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    volume = s.volume || 80;
  } catch(e) { queue = [...REX_LAWSON_SONGS]; }
}

function saveQueue() { try { fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2)); } catch(e) {} }
function saveState() { try { fs.writeFileSync(stateFile, JSON.stringify({ volume, isPlaying, currentTrack }, null, 2)); } catch(e) {} }

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function getStatus() {
  return { type: 'status', currentTrack, queue, isPlaying, volume, listeners, timestamp: Date.now() };
}

wss.on('connection', (ws) => {
  clients.add(ws);
  listeners = clients.size;
  ws.send(JSON.stringify(getStatus()));
  broadcast({ type: 'listeners', count: listeners });
  ws.on('message', (data) => { try { handleCommand(JSON.parse(data.toString()), ws); } catch(e) {} });
  ws.on('close', () => { clients.delete(ws); listeners = clients.size; broadcast({ type: 'listeners', count: listeners }); });
});

function handleCommand(msg, ws) {
  switch(msg.action) {
    case 'play': if (!isPlaying) startPlayback(); break;
    case 'pause': pausePlayback(); break;
    case 'skip': skipTrack(); break;
    case 'volume':
      volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
      saveState(); broadcast({ type: 'volume', value: volume }); break;
    case 'addSong': addSong(msg.song); break;
    case 'removeSong': removeSong(msg.id); break;
    case 'reorder': reorderQueue(msg.from, msg.to); break;
    case 'getStatus': if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(getStatus())); break;
  }
}

async function getYouTubeUrl(query) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp --get-url --format bestaudio "ytsearch1:${query}"`, { timeout: 30000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim().split('\n')[0]);
    });
  });
}

async function startPlayback() {
  if (queue.length === 0) { broadcast({ type: 'error', message: 'Queue is empty' }); return; }
  isPlaying = true;
  playNext();
}

async function playNext() {
  if (!isPlaying || queue.length === 0) {
    isPlaying = false; currentTrack = null;
    broadcast(getStatus()); saveState(); return;
  }
  currentTrack = { ...queue[0] };
  broadcast({ type: 'nowPlaying', track: currentTrack });
  broadcast(getStatus());
  saveState();

  try {
    const q = currentTrack.youtubeQuery || `${currentTrack.artist} ${currentTrack.title}`;
    broadcast({ type: 'loading', message: `Loading: ${currentTrack.title}...` });
    const url = await getYouTubeUrl(q);
    if (!isPlaying) return;
    if (currentProcess) { try { currentProcess.kill('SIGKILL'); } catch(e) {} }

    currentProcess = spawn('ffmpeg', ['-reconnect', '1', '-reconnect_streamed', '1', '-i', url, '-af', `volume=${volume/100}`, '-f', 'mp3', '-br', '128k', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });

    currentProcess.stdout.on('data', (chunk) => {
      streamClients.forEach(res => { try { res.write(chunk); } catch(e) { streamClients.delete(res); } });
    });
    currentProcess.stderr.on('data', () => {});
    currentProcess.on('close', (code) => {
      if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 500); }
    });
    currentProcess.on('error', (e) => {
      broadcast({ type: 'error', message: 'Playback error: ' + e.message });
      if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 2000); }
    });
  } catch(e) {
    broadcast({ type: 'error', message: 'Could not load: ' + (currentTrack ? currentTrack.title : 'track') });
    if (isPlaying) { queue.shift(); saveQueue(); setTimeout(playNext, 2000); }
  }
}

function pausePlayback() {
  isPlaying = false;
  if (currentProcess) { try { currentProcess.kill('SIGKILL'); currentProcess = null; } catch(e) {} }
  broadcast(getStatus()); saveState();
}

function skipTrack() {
  if (currentProcess) { try { currentProcess.kill('SIGKILL'); currentProcess = null; } catch(e) {} }
  queue.shift(); saveQueue();
  if (isPlaying) playNext(); else { currentTrack = null; broadcast(getStatus()); }
}

function addSong(song) {
  if (!song || !song.title) return;
  queue.push({ id: Date.now().toString(), title: song.title, artist: song.artist || 'Unknown', youtubeQuery: song.youtubeQuery || `${song.artist} ${song.title}`, duration: song.duration || '?:??' });
  saveQueue(); broadcast(getStatus());
}

function removeSong(id) {
  const idx = queue.findIndex(s => s.id === id);
  if (idx > 0) { queue.splice(idx, 1); saveQueue(); broadcast(getStatus()); }
}

function reorderQueue(from, to) {
  if (from < 1 || to < 1 || from >= queue.length || to >= queue.length) return;
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  saveQueue(); broadcast(getStatus());
}

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
app.post('/api/play', (req, res) => { if (!isPlaying) startPlayback(); res.json({ success: true, isPlaying }); });
app.post('/api/pause', (req, res) => { pausePlayback(); res.json({ success: true, isPlaying }); });
app.post('/api/skip', (req, res) => { skipTrack(); res.json({ success: true }); });
app.post('/api/volume', (req, res) => { volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80)); saveState(); broadcast({ type: 'volume', value: volume }); res.json({ success: true, volume }); });
app.post('/api/queue/add', (req, res) => { addSong(req.body); res.json({ success: true, queue }); });
app.delete('/api/queue/:id', (req, res) => { removeSong(req.params.id); res.json({ success: true, queue }); });
app.post('/api/queue/rex-lawson', (req, res) => {
  REX_LAWSON_SONGS.forEach(s => { if (!queue.find(q => q.title === s.title)) queue.push({...s, id: (Date.now()*Math.random()).toString()}); });
  saveQueue(); broadcast(getStatus());
  if (!isPlaying) startPlayback();
  res.json({ success: true, queue });
});
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), isPlaying, currentTrack: currentTrack ? currentTrack.title : null, queueLength: queue.length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('BUKUMA RADIO running on port ' + PORT);
  loadState();
  setTimeout(() => { if (!isPlaying && queue.length > 0) { console.log('Auto-starting with Rex Lawson...'); startPlayback(); } }, 5000);
});
