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

// ── Config ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bukuma2024';
const PORT           = process.env.PORT            || 3000;

// Binary paths — set via env vars on Railway, fall back to local Windows paths
const FFMPEG_PATH = process.env.FFMPEG_PATH
    || 'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.WinGet.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe';
const YTDLP_PATH  = process.env.YTDLP_PATH
    || 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\yt-dlp.exe';

// Startup verification — runs once at boot, logs clearly in Railway log viewer
function verifyBinaries() {
    const binaries = { ffmpeg: FFMPEG_PATH, 'yt-dlp': YTDLP_PATH };
    for (const [name, resolvedPath] of Object.entries(binaries)) {
        const source = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'YTDLP_PATH']
            ? 'env var'
            : 'default fallback';
        if (fs.existsSync(resolvedPath)) {
            console.log(`[BINARY] ✓ ${name} found at: ${resolvedPath}  (${source})`);
        } else {
            console.error(`[BINARY] ✗ ${name} NOT FOUND at: ${resolvedPath}  (${source})`);
            console.error(`[BINARY]   → Set the ${name === 'ffmpeg' ? 'FFMPEG_PATH' : 'YTDLP_PATH'} env var to the correct path`);
        }
    }
}



// ── Default seed tracks ──────────────────────────────────────────────────────
const REX_LAWSON_SEED = [
    { title: 'Jolly',          artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Jolly highlife' },
    { title: 'Warri',          artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Warri highlife' },
    { title: 'Kelegbe Megbe',  artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Kelegbe Megbe' },
    { title: 'So Tey',         artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson So Tey highlife' },
    { title: 'Ibinabo',        artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ibinabo' },
    { title: 'Ogologo Obi',    artist: 'Cardinal Rex Lawson', youtubeQuery: 'Cardinal Rex Lawson Ogologo Obi' },
];

function seedQueue() {
    return REX_LAWSON_SEED.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
}

// ── State ────────────────────────────────────────────────────────────────────
let queue        = seedQueue();  // Always start with seeds; overwritten by loadState
let currentTrack = null;
let isPlaying    = false;
let volume       = 80;
let currentProcess   = null;
let isTransitioning  = false;
let playNextTimeout  = null;
let silenceInterval  = null;
let playlists        = [];
let autoJingles      = { start: false, random: false };

// Confidence Monitor (Watchdog)
let lastDataTime = Date.now();
let monitorTimer = null;

const clients       = new Set();
const streamClients = new Set();
let listeners = 0;

// ── Data persistence ─────────────────────────────────────────────────────────
const dataDir              = path.join(__dirname, 'data');
const queueFile            = path.join(dataDir, 'queue.json');
const stateFile            = path.join(dataDir, 'state.json');
const playlistsFile        = path.join(dataDir, 'playlists.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadState() {
    try {
        if (fs.existsSync(queueFile)) {
            const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
            if (Array.isArray(saved) && saved.length > 0) queue = saved;
            // else keep the seed
        }
        if (fs.existsSync(stateFile)) {
            const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            volume      = s.volume      || 80;
            autoJingles = s.autoJingles || { start: false, random: false };
        }
        if (fs.existsSync(playlistsFile)) {
            playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
        }
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

// ── Utilities ────────────────────────────────────────────────────────────────
const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

function broadcast(msg) {
    const data = JSON.stringify(msg);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function getStatus() {
    return { type: 'status', currentTrack, queue, isPlaying, volume, listeners, autoJingles, timestamp: Date.now() };
}

// ── Confidence Monitor ───────────────────────────────────────────────────────
// Programmatically asserts the radio is "playing out".
// If dead air detected for >10s while isPlaying=true, forces a resync.
function startMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(() => {
        if (isPlaying && !isTransitioning) {
            const idleMs = Date.now() - lastDataTime;
            if (idleMs > 10000) {
                console.log(`[WATCHDOG] Dead air ${idleMs}ms — resyncing`);
                lastDataTime = Date.now();
                if (queue.length === 0) queue = seedQueue();
                playNext();
            }
        }
    }, 2000);
}

// ── Audio engine ─────────────────────────────────────────────────────────────
async function getYouTubeUrl(query) {
    return new Promise((resolve, reject) => {
        const cmd = `"${YTDLP_PATH}" --get-url --format bestaudio --no-playlist --ignore-errors "ytsearch1:${query}"`;
        exec(cmd, (err, stdout) => {
            if (err) return reject(err);
            const url = stdout.trim().split('\n').filter(l => l.startsWith('http'))[0];
            if (!url) return reject(new Error('No URL from yt-dlp'));
            resolve(url);
        });
    });
}

function startPlayback() {
    if (isPlaying && currentProcess) return;
    isPlaying = true;
    // Auto-seed if empty
    if (queue.length === 0) {
        const pl = playlists[0];
        if (pl && pl.tracks.length > 0) {
            queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
        } else {
            queue = seedQueue();
        }
        saveState();
    }
    lastDataTime = Date.now();
    playNext();
}

async function playNext() {
    if (!isPlaying || isTransitioning) return;

    // Wrap-around: if queue exhausted, re-seed for continuous play
    if (queue.length === 0) {
        console.log('[PLAY] Queue empty — reseeding');
        queue = seedQueue();
        saveState();
    }

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

        // ── FFmpeg: simple, reliable single-input pipeline ──────────────────
        // Music → volume → mp3 → stream
        const args = [
            '-hide_banner',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '-i', url,
            '-vn',                          // drop any video stream
            '-af', `volume=${volume / 100}`,
            '-f', 'mp3',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            '-'
        ];

        currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        // Catch EPIPE on stdin to prevent crashing
        currentProcess.stdin.on('error', err => {
            if (err.code !== 'EPIPE') console.error('[FFMPEG] Stdin error:', err.message);
        });

        currentProcess.stdout.on('data', chunk => {
            lastDataTime = Date.now();  // Heartbeat for Confidence Monitor
            streamClients.forEach(client => {
                try { client.write(chunk); } catch(e) { streamClients.delete(client); }
            });
        });

        currentProcess.stderr.on('data', data => {
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('failed')) {
                console.error('[FFMPEG] Signal Error:', msg.trim());
            }
        });

        currentProcess.on('close', code => {
            console.log('[FFMPEG] Track closed, code:', code);
            clearInterval(silenceInterval);
            silenceInterval = null;
            if (isPlaying) {
                queue.shift();
                saveState();
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 1500);
            }
        });

        currentProcess.on('error', err => {
            console.error('[FFMPEG] Spawn error:', err.message);
            clearInterval(silenceInterval);
            silenceInterval = null;
            isTransitioning = false;
            if (isPlaying) playNextTimeout = setTimeout(playNext, 3000);
        });

        isTransitioning = false;

    } catch(e) {
        console.error('[PLAY] Failed to load track:', e.message);
        isTransitioning = false;
        queue.shift();
        if (queue.length === 0) queue = seedQueue();
        saveState();
        playNextTimeout = setTimeout(playNext, 4000);
    }
}

function pausePlayback() {
    isPlaying = false;
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    if (currentProcess) {
        try { currentProcess.kill('SIGKILL'); } catch(e) {}
        currentProcess = null;
    }
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

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
    clients.add(ws);
    listeners = clients.size;
    ws.send(JSON.stringify(getStatus()));
    broadcast({ type: 'listeners', count: listeners });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            // Mic PCM from Admin Console → pipe to FFmpeg sidechain input
            if (ws.isAdmin && currentProcess && currentProcess.stdin && currentProcess.stdin.writable) {
                try { currentProcess.stdin.write(data); } catch(e) {}
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
                    }
                    break;
                case 'getStatus':
                    ws.send(JSON.stringify(getStatus()));
                    break;
                case 'play':   if (!isPlaying) startPlayback(); break;
                case 'pause':  pausePlayback(); break;
                case 'skip':   skipTrack(); break;
                case 'volume':
                    volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
                    saveState();
                    broadcast({ type: 'volume', value: volume });
                    break;
                case 'addSong':
                    if (msg.song) {
                        queue.push({ id: Math.random().toString(36).slice(2), ...msg.song });
                        saveState();
                        broadcast(getStatus());
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

// ── HTTP Routes ───────────────────────────────────────────────────────────────
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
app.get('/api/queue',  (req, res) => res.json({ queue }));
app.get('/api/playlists', (req, res) => res.json({ playlists }));

app.post('/api/play',  (req, res) => { if (!isPlaying) startPlayback(); res.json({ success: true, isPlaying }); });
app.post('/api/pause', (req, res) => { pausePlayback(); res.json({ success: true }); });
app.post('/api/skip',  (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', (req, res) => {
    volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80));
    saveState();
    broadcast({ type: 'volume', value: volume });
    res.json({ success: true, volume });
});

app.post('/api/duck', (req, res) => {
    // State 0=off, 1=talk/duck, 2=solo. Ducking is handled by sidechain filter in FFmpeg.
    res.json({ success: true });
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.status(401).json({ success: false });
});

// Queue management
app.post('/api/queue', (req, res) => {
    const { url, title, artist, youtubeQuery } = req.body;
    if (!url && !youtubeQuery && !title) return res.status(400).json({ success: false });
    const entry = { id: Math.random().toString(36).slice(2), title: title || url, artist: artist || 'Unknown', youtubeQuery: youtubeQuery || url || title };
    queue.push(entry);
    saveState();
    broadcast(getStatus());
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

// YouTube search
app.get('/api/youtube/search', (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    exec(`"${YTDLP_PATH}" "ytsearch5:${q}" --get-title --get-id --get-duration --no-warnings`, { timeout: 30000 }, (err, stdout) => {
        if (err || !stdout.trim()) return res.json({ results: [] });
        const lines = stdout.trim().split('\n');
        const results = [];
        for (let i = 0; i + 2 < lines.length; i += 3) {
            const vid = lines[i + 1];
            results.push({ title: lines[i], url: `https://www.youtube.com/watch?v=${vid}`, thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, duration: lines[i + 2] });
        }
        res.json({ results });
    });
});

// Playlists
app.post('/api/playlists', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false });
    const pl = { id: Date.now().toString(), name, tracks: [...queue] };
    playlists.push(pl);
    savePlaylists();
    res.json({ success: true, playlists });
});

app.post('/api/playlists/:id/load', (req, res) => {
    const pl = playlists.find(p => p.id === req.params.id);
    if (!pl) return res.status(404).json({ success: false });
    queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
    saveState();
    broadcast(getStatus());
    if (!isPlaying) startPlayback();
    res.json({ success: true });
});

app.delete('/api/playlists/:id', (req, res) => {
    playlists = playlists.filter(p => p.id !== req.params.id);
    savePlaylists();
    res.json({ success: true, playlists });
});

// Rex Lawson shortcut
app.post('/api/queue/rex-lawson', (req, res) => {
    const seeds = seedQueue();
    seeds.forEach(s => { if (!queue.find(q => q.title === s.title)) queue.push(s); });
    saveState();
    broadcast(getStatus());
    if (!isPlaying) startPlayback();
    res.json({ success: true, queue });
});

// Song requests (public)
let songRequests = [];
app.post('/api/requests', (req, res) => {
    const { song, listener } = req.body;
    if (!song) return res.status(400).json({ success: false });
    const r = { id: Date.now().toString(), song, listener: listener || 'Anonymous', status: 'pending', createdAt: new Date().toISOString() };
    songRequests.push(r);
    broadcast({ type: 'request_new', song: r.song });
    res.json({ success: true, id: r.id });
});

app.get('/api/requests', (req, res) => res.json({ requests: songRequests }));

app.get('/health', (req, res) => res.json({
    status: 'ok',
    uptime: process.uptime(),
    isPlaying,
    currentTrack: currentTrack ? currentTrack.title : null,
    queueLength: queue.length,
    streamClients: streamClients.size,
    lastDataAgeMs: Date.now() - lastDataTime
}));

// ── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`[BUKUMA] Station live on port ${PORT}`);
    verifyBinaries(); // confirm ffmpeg + yt-dlp paths at startup
    loadState();      // load saved queue / settings
    startMonitor();   // Confidence Monitor (dead-air watchdog)
    setTimeout(() => {
        console.log('[BUKUMA] Auto-starting playback — queue length:', queue.length);
        startPlayback();
    }, 2000);
});
