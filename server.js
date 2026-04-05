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

// Binary paths
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg'; // Default to PATH
const YTDLP_PATH  = process.env.YTDLP_PATH  || 'yt-dlp'; // Default to PATH

function verifyBinaries() {
    console.log(`[BINARY] FFmpeg Path: ${FFMPEG_PATH}`);
    console.log(`[BINARY] yt-dlp Path: ${YTDLP_PATH}`);
}

// ── Seed tracks ───────────────────────────────────────────────────────────────
function seedQueue() {
    return []; // No longer using hardcoded seeds
}

// ── State ────────────────────────────────────────────────────────────────────
let queue        = seedQueue();
let currentTrack = null;
let isPlaying    = false;
let volume       = 80;
let currentProcess   = null;
let isTransitioning  = false;
let playNextTimeout  = null;
let silenceInterval  = null;
let playlists        = [];
let autoJingles      = { start: false, random: false };

// Neutral fallback (Station Ident) 
const SAFE_FALLBACK_URL = 'https://archive.org/download/bukuma-radio-ident/ident.mp3'; 
let consecutiveFailures = 0;
let serverMicState      = 0; // 0=Off, 1=Talk/Duck, 2=Solo

// Confidence Monitor (Watchdog)
let lastDataTime = Date.now();
let monitorTimer = null;

const clients       = new Set();
const streamClients = new Set();
let listeners = 0;

// ── Persistence ───────────────────────────────────────────────────────────────
const dataDir              = path.join(__dirname, 'data');
const downloadsDir         = path.join(dataDir, 'downloads');
const queueFile            = path.join(dataDir, 'queue.json');
const stateFile            = path.join(dataDir, 'state.json');
const playlistsFile        = path.join(dataDir, 'playlists.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

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
        if (fs.existsSync(playlistsFile)) {
            playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
        }

        // --- MANDATORY REX LAWSON PURGE ---
        // Ensuring no 'Cardinal Rex Lawson' tracks persist in the production data
        const filterFn = t => !t.artist?.toLowerCase().includes('rex lawson') && 
                              !t.title?.toLowerCase().includes('jolly') && 
                              !t.title?.toLowerCase().includes('warri');
        queue = queue.filter(filterFn);
        playlists.forEach(pl => { if (pl.tracks) pl.tracks = pl.tracks.filter(filterFn); });
        // ----------------------------------

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
    return { type: 'status', currentTrack, queue, isPlaying, volume, listeners, autoJingles, timestamp: Date.now(), serverMicState };
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
function startMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(() => {
        if (isPlaying && !isTransitioning) {
            const idleMs = Date.now() - lastDataTime;
            if (idleMs > 15000) {
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
        const extractorArgs = 'youtube:player_client=default,android_sdkless';
        const cmd = `"${YTDLP_PATH}" --get-url --format "bestaudio/best" --no-playlist --ignore-errors --geo-bypass --no-check-certificates --extractor-args "${extractorArgs}" "ytsearch1:${query}"`;
        
        exec(cmd, (err, stdout) => {
            if (err) return reject(err);
            const url = stdout.trim().split('\n').filter(l => l.startsWith('http'))[0];
            if (!url) return reject(new Error('No URL from yt-dlp'));
            resolve(url);
        });
    });
}

function downloadTrack(track) {
    if (track.status === 'ready' || track.status === 'downloading') return;
    
    track.status = 'downloading';
    broadcast(getStatus());

    const localPath = path.join(downloadsDir, `${track.id}.mp3`);
    const extractorArgs = 'youtube:player_client=default,android_sdkless';
    const cmd = `"${YTDLP_PATH}" -x --audio-format mp3 --no-playlist --ignore-errors --geo-bypass --no-check-certificates --extractor-args "${extractorArgs}" -o "${localPath}" "ytsearch1:${track.youtubeQuery || (track.artist + ' ' + track.title)}"`;

    console.log(`[DOWNLOAD] Starting: ${track.title}`);
    exec(cmd, (err) => {
        if (err) {
            console.error(`[DOWNLOAD] Fail: ${track.title}`, err.message);
            track.status = 'error';
        } else {
            console.log(`[DOWNLOAD] Success: ${track.title}`);
            track.status = 'ready';
            track.localPath = localPath;
        }
        saveState();
        broadcast(getStatus());
    });
}

function startPlayback() {
    if (isPlaying && currentProcess) return;
    isPlaying = true;
    if (queue.length === 0) {
        const pl = playlists[0];
        queue = (pl && pl.tracks.length > 0) ? pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) })) : [];
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
    
    // If still downloading, wait a bit
    if (currentTrack.status === 'downloading') {
        console.log(`[PLAY] Waiting for download: ${currentTrack.title}`);
        broadcast({ type: 'nowPlaying', track: { ...currentTrack, status: 'downloading' } });
        playNextTimeout = setTimeout(playNext, 2000);
        isTransitioning = false;
        return;
    }

    console.log('[PLAY] Loading:', currentTrack.title);
    broadcast({ type: 'nowPlaying', track: currentTrack });
    broadcast(getStatus());

    try {
        let inputSource = currentTrack.localPath;
        if (!inputSource || !fs.existsSync(inputSource)) {
            console.log(`[PLAY] Local file missing for ${currentTrack.title}, fetching URL...`);
            inputSource = await getYouTubeUrl(currentTrack.youtubeQuery || currentTrack.title);
        }

        if (currentProcess) {
            currentProcess.removeAllListeners();
            try { currentProcess.kill('SIGKILL'); } catch(e) {}
            currentProcess = null;
        }

        const userAgent = 'Mozilla/5.0 (Android 12; Mobile; rv:102.0) Gecko/102.0 Firefox/102.0'; 
        const musicVolume = (serverMicState === 2) ? 0 : (volume / 100);
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
            '-user_agent', userAgent,
            '-headers', `Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n`,
            '-i', inputSource,
            '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', '-', // Input 1: Mic from Stdin
            '-vn',
            '-filter_complex', `[0:a]volume=${musicVolume}[music];[1:a]asplit[mic][sc];[music][sc]sidechaincompress=threshold=0.01:ratio=20:attack=10:release=1000[ducked];[ducked][mic]amix=inputs=2:duration=first,asplit=2[out][vu]`,
            '-map', '[out]', '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-',
            '-map', '[vu]',  '-f', 's16le', '-ar', '22050', '-ac', '1', 'pipe:3'
        ];

        currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        
        // Monitoring Pipe (Pipe 3)
        currentProcess.stdio[3].on('data', chunk => {
            let sum = 0;
            const samples = chunk.length / 2;
            for (let i = 0; i < chunk.length; i += 2) {
                const s = chunk.readInt16LE(i) / 32768;
                sum += s * s;
            }
            const rms = Math.sqrt(sum / samples);
            const level = Math.min(100, Math.floor(rms * 250)); // Scale to 0-100
            
            // Broadcast level strictly to admins
            const msg = JSON.stringify({ type: 'vu', level });
            clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN && ws.isAdmin) ws.send(msg);
            });
        });

        let bytesOut = 0;

        const silenceBuffer = Buffer.alloc(4096, 0); 
        const silenceTimer = setInterval(() => {
            if (currentProcess && currentProcess.stdin && currentProcess.stdin.writable) {
                try { currentProcess.stdin.write(silenceBuffer); } catch(e) {}
            }
        }, 100);

        currentProcess.stdout.on('data', chunk => {
            bytesOut += chunk.length;
            lastDataTime = Date.now();
            streamClients.forEach(client => {
                try { client.write(chunk); } catch(e) { streamClients.delete(client); }
            });
        });

        currentProcess.stdin.on('error', err => { if (err.code !== 'EPIPE') console.error('[FFMPEG] Stdin error:', err.message); });

        currentProcess.stderr.on('data', data => {
            const msg = data.toString();
            if (msg.includes('403') || msg.includes('Forbidden')) {
                console.error('[FFMPEG] YouTube Block Detected (403)');
                consecutiveFailures++;
            }
        });

        currentProcess.on('close', code => {
            console.log(`[FFMPEG] Track closed (code: ${code}, delivery: ${bytesOut} bytes)`);
            clearInterval(silenceTimer);
            if (bytesOut < 1000 && isPlaying) consecutiveFailures++;
            else consecutiveFailures = 0;
            if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
            if (isPlaying) {
                queue.shift(); saveState();
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 1500);
            }
        });

        currentProcess.on('error', err => {
            console.error('[FFMPEG] Spawn error:', err.message);
            isTransitioning = false;
            if (isPlaying) playNextTimeout = setTimeout(playNext, 3000);
        });

        isTransitioning = false;

    } catch(e) {
        console.error('[PLAY] Error in engine:', e.message);
        isTransitioning = false;
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
            startFallbackStream(SAFE_FALLBACK_URL);
            return;
        }
        const retryDelay = Math.min(30000, 5000 * consecutiveFailures);
        queue.shift(); if (queue.length === 0) queue = seedQueue();
        saveState();
        // Removed: playNextTimeout = setTimeout(playNext, retryDelay);
    }
}

function startFallbackStream(url) {
    if (currentProcess) try { currentProcess.kill('SIGKILL'); } catch(e) {}
    console.log('[PLAY] Starting Safe-Fail Stream:', url);
    const args = ['-hide_banner', '-reconnect', '1', '-i', url, '-af', `volume=${volume / 100}`, '-f', 'mp3', '-b:a', '128k', '-'];
    currentProcess = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    currentProcess.stdout.on('data', chunk => {
        lastDataTime = Date.now();
        streamClients.forEach(c => { try { c.write(chunk); } catch(e) {} });
    });
    currentProcess.on('close', () => {
        consecutiveFailures = 0;
        playNextTimeout = setTimeout(playNext, 3000);
    });
}

function stopPlayback() {
    isPlaying = false;
    if (currentProcess) { try { currentProcess.kill('SIGKILL'); } catch(e) {} currentProcess = null; }
    broadcast(getStatus());
}

function skipTrack() {
    if (currentProcess) {
        currentProcess.removeAllListeners();
        try { currentProcess.kill('SIGKILL'); } catch(e) {}
        currentProcess = null;
    }
    queue.shift(); if (queue.length === 0) { isPlaying = false; broadcast(getStatus()); return; }
    saveState();
    isTransitioning = false;
    if (isPlaying) playNext();
    else  broadcast(getStatus());
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
    clients.add(ws);
    listeners = clients.size;
    ws.send(JSON.stringify(getStatus()));
    broadcast({ type: 'listeners', count: listeners });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
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
                case 'getStatus': ws.send(JSON.stringify(getStatus())); break;
                case 'play':   if (!isPlaying) startPlayback(); break;
                case 'pause':  pausePlayback(); break;
                case 'skip':   skipTrack(); break;
                case 'volume':
                    volume = Math.min(100, Math.max(0, parseInt(msg.value) || 80));
                    saveState(); broadcast({ type: 'volume', value: volume });
                    break;
                case 'addSong':
                    if (msg.song) {
                        const track = { id: Math.random().toString(36).slice(2), status: 'pending', ...msg.song };
                        queue.push(track);
                        saveState(); 
                        broadcast(getStatus());
                        downloadTrack(track);
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

app.post('/api/play',  (req, res) => { if (!isPlaying) startPlayback(); res.json({ success: true }); });
app.post('/api/pause', (req, res) => { pausePlayback(); res.json({ success: true }); });
app.post('/api/skip',  (req, res) => { skipTrack(); res.json({ success: true }); });
app.post('/api/queue/skip', (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', (req, res) => {
    volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80));
    saveState(); broadcast({ type: 'volume', value: volume });
    res.json({ success: true, volume });
});

app.post('/api/duck', (req, res) => {
    const { state } = req.body;
    serverMicState = parseInt(state) || 0;
    res.json({ success: true, serverMicState });
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
  res.json({ success: true, name, village });
});

app.post('/api/queue', (req, res) => {
    const { url, title, artist, youtubeQuery } = req.body;
    const entry = { id: Math.random().toString(36).slice(2), status: 'pending', title: title || url, artist: artist || 'Unknown', youtubeQuery: youtubeQuery || url || title };
    queue.push(entry); 
    saveState(); 
    broadcast(getStatus());
    downloadTrack(entry);
    if (!isPlaying) startPlayback();
    res.json({ success: true, id: entry.id });
});

app.post('/api/queue/add', (req, res) => {
    const { videoId, title, duration, url } = req.body;
    const vid = videoId || (url && url.match(/[?&]v=([^&]+)/)?.[1]);
    const entry = {
        id: Math.random().toString(36).slice(2),
        status: 'pending',
        title: title || 'Unknown', artist: 'YouTube',
        youtubeQuery: vid ? ('https://www.youtube.com/watch?v=' + vid) : (url || title),
        duration: duration || ''
    };
    queue.push(entry); 
    saveState(); 
    broadcast(getStatus());
    downloadTrack(entry);
    if (!isPlaying) startPlayback();
    res.json({ success: true, id: entry.id });
});

app.delete('/api/queue/:id', (req, res) => {
    const before = queue.length;
    queue = queue.filter(t => t.id !== req.params.id);
    if (queue.length !== before) saveState();
    broadcast(getStatus());
    res.json({ success: true });
});

app.get('/api/youtube/search', (req, res) => {
    const q = req.query.q?.replace(/['"\\]/g, '');
    if (!q) return res.json({ results: [] });
    const cmd = `"${YTDLP_PATH}" "ytsearch5:${q}" --flat-playlist --print "%(id)s|||%(title)s|||%(duration_string)s" --no-warnings`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
        if (err || !stdout?.trim()) return res.json({ results: [] });
        const results = stdout.trim().split('\n').map(line => {
            const [vid, title, dur] = line.split('|||').map(s => s?.trim());
            return { videoId: vid, title, url: 'https://www.youtube.com/watch?v=' + vid, thumbnail: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg', duration: dur };
        });
        res.json({ results });
    });
});

app.post('/api/playlists', (req, res) => {
    const { name } = req.body;
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

app.get('/health', (req, res) => res.json({
    status: 'ok', uptime: process.uptime(), isPlaying,
    currentTrack: currentTrack ? currentTrack.title : null,
    queueLength: queue.length, streamClients: streamClients.size,
    lastDataAgeMs: Date.now() - lastDataTime
}));

// ── Boot ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`[BUKUMA] Station live on port ${PORT}`);
    verifyBinaries();
    loadState();
    startMonitor();
    setTimeout(() => { if (isPlaying) startPlayback(); }, 2000);
});
