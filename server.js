const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
// FIX: WebSocket server on explicit path /ws so client connectWS() matches
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bukuma2024';
const PORT           = process.env.PORT            || 3000;
const FFMPEG_PATH    = process.env.FFMPEG_PATH     || 'ffmpeg';
const YTDLP_PATH     = process.env.YTDLP_PATH      || 'yt-dlp';

// ── Persistence paths ────────────────────────────────────────────────────────
const dataDir      = process.env.DATA_DIR || path.join(__dirname, 'data');
const downloadsDir = path.join(dataDir, 'downloads');
const queueFile    = path.join(dataDir, 'queue.json');
const stateFile    = path.join(dataDir, 'state.json');
const playlistsFile= path.join(dataDir, 'playlists.json');
const newsFile     = path.join(dataDir, 'news.json');
if (!fs.existsSync(dataDir))      fs.mkdirSync(dataDir,      { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// ── State ────────────────────────────────────────────────────────────────────
let queue        = [];
let playlists    = [];
let programs     = [];
let news         = [];
let libraryIndex = 0;
let currentTrack = null;
let isPlaying    = false;
let isOnAir      = false;
let volume       = 80;
let currentProcess   = null;
let isTransitioning  = false;
let playNextTimeout  = null;
let engineEpoch      = 0;
let lastDataTime     = Date.now();
let monitorTimer     = null;
let consecutiveFailures = 0;
let autoJingles = { start: false };
let autoJingleTimer = null;
let activeJingleProcess = null;
let pendingIntro = false;

// FIX: single download lock — only ONE yt-dlp process at a time
let isDownloading = false;
let downloadQueue = [];

const clients      = new Set();
const streamClients= new Set();

// ── Seed tracks ──────────────────────────────────────────────────────────────
function seedQueue() {
        return [
            { title: 'Ozigizaga',             artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Ozigizaga Ijaw highlife' },
            { title: 'Earth Song',            artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Earth Song Ijaw' },
            { title: 'Paddle of the Niger Delta', artist: 'Barrister Smooth', youtubeQuery: 'Chief Barrister Smooth Ijaw highlife Niger Delta' },
            { title: 'Tompolo',               artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Tompolo Ijaw' },
            { title: 'Halo Halo',             artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Halo Halo Ijaw' },
            { title: 'Ijaw Cultural Heritage',artist: 'Barrister Smooth', youtubeQuery: 'Barrister Smooth Ijaw cultural highlife best' },
            { title: 'Adaka Boro',            artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Adaka Boro' },
            { title: 'HighLife',              artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan HighLife Ijaw Afro Teme' },
            { title: 'Miss You',              artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Miss You Thousand Voice' },
            { title: 'Miekemedonmo',          artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Miekemedonmo' }
                ].map(t => ({ ...t, id: Math.random().toString(36).slice(2), status: 'pending', duration: 'Unknown' }));
}

// ── Persistence ───────────────────────────────────────────────────────────────
function loadState() {
        try {
                    if (fs.existsSync(queueFile)) {
                                    const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
                                    if (Array.isArray(saved) && saved.length > 0) queue = saved;
                    }
                    if (fs.existsSync(stateFile)) {
                                    const d = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                                    volume       = Number(d.volume || 80); if (isNaN(volume)) volume = 80;
                                    libraryIndex = d.libraryIndex || 0;
                                    isOnAir      = d.isOnAir  || false;
                                    isPlaying    = d.isPlaying|| false;
                                    autoJingles  = d.autoJingles || { start: false };
                    }
                    if (fs.existsSync(playlistsFile)) playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
                    if (fs.existsSync(path.join(dataDir, 'programs.json')))
                                    programs = JSON.parse(fs.readFileSync(path.join(dataDir, 'programs.json'), 'utf8'));
                    if (fs.existsSync(newsFile)) {
                                    news = JSON.parse(fs.readFileSync(newsFile, 'utf8'));
                    } else {
                                    news = [
                                        { id: 'n1', date: new Date().toISOString(), status: 'news',
                                                           title: 'BUKUMA RADIO GOES GLOBAL',
                                                           summary: 'Agum Bukuma Radio now streams to the world.',
                                                           content: 'We are live.' }
                                                    ];
                                    saveNews();
                    }
                    // Self-heal: reset stuck downloads, restore missing files
            queue.forEach(t => {
                            if (t.status === 'downloading') { t.status = 'pending'; }
                            if (t.status === 'ready' && t.localPath && !fs.existsSync(t.localPath)) {
                                                console.log(`[HEAL] Missing file for ${t.title} — reverting to pending`);
                                                t.status = 'pending'; t.localPath = null;
                            }
            });
        } catch(e) { console.error('[INIT] loadState error:', e.message); }
}

function saveState() {
        try {
                    fs.writeFileSync(stateFile,  JSON.stringify({ volume, autoJingles, isOnAir, isPlaying, libraryIndex }, null, 2));
                    fs.writeFileSync(queueFile,  JSON.stringify(queue, null, 2));
        } catch(e) {}
                        }
function savePlaylists() { try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {} }
function saveNews()      { try { fs.writeFileSync(newsFile,      JSON.stringify(news, null, 2));      } catch(e) {} }

const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(msg) {
        const data = JSON.stringify(msg);
        clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function getStatus() {
        return {
                    isOnAir, isPlaying, volume, queue: queue.map((t, i) => ({
                                    ...t, isNowPlaying: i === libraryIndex && isPlaying && !currentTrack?.isSilence
                    })),
                    libraryIndex, currentTrack, autoJingles, timestamp: Date.now()
        };
}

// ── Scout/Downloader — FIX: serialised, one at a time, never touches engine ──
function enqueueDownload(track) {
        if (track.status === 'ready' || track.status === 'downloading') return;
        if (downloadQueue.find(t => t.id === track.id)) return;
        downloadQueue.push(track);
        processDownloadQueue();
}

function processDownloadQueue() {
        if (isDownloading || downloadQueue.length === 0) return;
        const track = downloadQueue.shift();
        // Recheck — another path may have already resolved it
    const live = queue.find(t => t.id === track.id);
        if (!live || live.status === 'ready') { processDownloadQueue(); return; }
        isDownloading = true;
        live.status = 'downloading';
        // Do NOT broadcast during download — it causes ghost flicker on the UI
    const cleanTitle = (live.artist + ' - ' + live.title).replace(/[^a-z0-9 _-]/gi, '_').replace(/\s+/g, '_');
        const localPath  = path.join(downloadsDir, `${cleanTitle}.mp3`);
        if (fs.existsSync(localPath)) {
                    live.status = 'ready'; live.localPath = localPath;
                    saveState();
                    isDownloading = false;
                    processDownloadQueue();
                    return;
        }
        const extractorArgs = 'youtube:player_client=default,android_sdkless';
        const cmd = `"${YTDLP_PATH}" -x --audio-format mp3 --no-playlist --ignore-errors --geo-bypass --no-check-certificates --extractor-args "${extractorArgs}" -o "${localPath}" "ytsearch1:${live.youtubeQuery || (live.artist + ' ' + live.title)}"`;
        console.log(`[SCOUT] Downloading: ${live.title}`);
        exec(cmd, { timeout: 120000 }, (err) => {
                    if (err || !fs.existsSync(localPath)) {
                                    console.error(`[SCOUT] Failed: ${live.title}`);
                                    // FIX: mark error but NEVER remove from queue — track stays visible
                        live.status = 'error';
                    } else {
                                    console.log(`[SCOUT] Ready: ${live.title}`);
                                    live.status = 'ready'; live.localPath = localPath;
                    }
                    saveState();
                    // Broadcast once when status changes — safe, not mid-transition
                     broadcast(getStatus());
                    isDownloading = false;
                    processDownloadQueue();
        });
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
function startMonitor() {
        if (monitorTimer) clearInterval(monitorTimer);
        monitorTimer = setInterval(() => {
                    // 1. Dead-air watchdog
                                           if (isOnAir) {
                                                           const idleMs = Date.now() - lastDataTime;
                                                           let isZombie = false;
                                                           if (currentProcess) {
                                                                               try { process.kill(currentProcess.pid, 0); } catch(e) { isZombie = true; }
                                                           }
                                                           if (idleMs > 25000 || (isOnAir && !currentProcess && !isTransitioning) || isZombie) {
                                                                               console.log(`[WATCHDOG] Recovery — idle ${idleMs}ms`);
                                                                               lastDataTime = Date.now();
                                                                               isTransitioning = false;
                                                                               playNext();
                                                           }
                                           }
                    // 2. FIX: Scout only queues downloads — doesn't call playNext/skipTrack
                                           // Prepare the next 3 tracks ahead of the pointer, serially
                                           const toFetch = [];
                    for (let i = 0; i < 3; i++) {
                                    const idx = (libraryIndex + i) % (queue.length || 1);
                                    if (queue[idx] && queue[idx].status === 'pending') toFetch.push(queue[idx]);
                    }
                    toFetch.forEach(t => enqueueDownload(t));
        }, 5000);
}

// ── Simple clean FFmpeg engine — FIX: no mic, no sidechain, just MP3→stream ──
async function playNext() {
        const myEpoch = engineEpoch;
        if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
        if (currentProcess && !isTransitioning) {
                    console.log('[PLAY] Already active.');
                    return;
        }
        isTransitioning = true;

    if (queue.length === 0) {
                if (isOnAir) {
                                currentTrack = { id: 'silence', title: 'STATION CONSOLE', artist: 'ON-AIR', status: 'ready', isSilence: true };
                } else { isTransitioning = false; return; }
    } else {
                if (libraryIndex >= queue.length) libraryIndex = 0;
                currentTrack = { ...queue[libraryIndex] };
    }

    if (!currentTrack) { isTransitioning = false; return; }

    // If track isn't ready, skip it cleanly — never block the engine
    if (!currentTrack.isSilence && currentTrack.status !== 'ready') {
                console.log(`[PLAY] Track not ready (${currentTrack.status}): ${currentTrack.title} — skipping`);
                // FIX: just advance pointer, do NOT shift/delete the track
            advanceQueue();
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 1000);
                return;
    }

    if (!currentTrack.isSilence && (!currentTrack.localPath || !fs.existsSync(currentTrack.localPath))) {
                console.log(`[PLAY] File missing for ${currentTrack.title} — skipping`);
                // FIX: revert to pending so scout can re-download it later
            const qi = queue.findIndex(t => t.id === currentTrack.id);
                if (qi !== -1) { queue[qi].status = 'pending'; queue[qi].localPath = null; }
                advanceQueue();
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 1000);
                return;
    }

    console.log('[PLAY] Starting:', currentTrack.isSilence ? 'SILENCE' : currentTrack.title);
        broadcast({ type: 'nowPlaying', track: currentTrack });
        broadcast(getStatus());

    // Kill old process
    if (currentProcess) {
                currentProcess.removeAllListeners();
                try { currentProcess.kill('SIGKILL'); } catch(e) {}
                currentProcess = null;
    }

    // FIX: Clean simple pipeline — music file → volume filter → MP3 out to all listeners
    // No mic, no sidechain, no VU meter, no stdin injection
    let ffmpegArgs;
        if (currentTrack.isSilence) {
                    ffmpegArgs = ['-hide_banner', '-loglevel', 'error',
                                              '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3600',
                                              '-f', 'mp3', '-b:a', '128k', '-'];
        } else {
                    ffmpegArgs = ['-hide_banner', '-loglevel', 'error',
            '-i', currentTrack.localPath,
                                              '-af', `volume=${volume / 100}`,
                                              '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-'];
        }

    try {
                currentProcess = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                let bytesOut = 0;

            currentProcess.stdout.on('data', chunk => {
                            bytesOut += chunk.length;
                            lastDataTime = Date.now();
                            streamClients.forEach(client => {
                                                try {
                                                                        const bufSize = client.writableLength || 0;
                                                                        if (bufSize > 1000000) { client.end(); streamClients.delete(client); return; }
                                                                        client.write(chunk);
                                                } catch(e) { streamClients.delete(client); }
                            });
            });

            currentProcess.on('close', code => {
                            if (myEpoch !== engineEpoch) return;
                            console.log(`[FFMPEG] Closed (code ${code}, ${bytesOut} bytes)`);
                            currentProcess = null;
                            if (bytesOut < 1000 && !currentTrack.isSilence) consecutiveFailures++;
                            else consecutiveFailures = 0;
                            if (isOnAir) {
                                                if (!currentTrack.isSilence) advanceQueue();
                                                isTransitioning = false;
                                                playNextTimeout = setTimeout(playNext, 1500);
                            }
            });

            currentProcess.on('error', err => {
                            if (myEpoch !== engineEpoch) return;
                            console.error('[FFMPEG] Spawn error:', err.message);
                            currentProcess = null;
                            isTransitioning = false;
                            if (isOnAir) playNextTimeout = setTimeout(playNext, 3000);
            });

            isTransitioning = false;
    } catch(e) {
                if (myEpoch !== engineEpoch) { isTransitioning = false; return; }
                console.error('[PLAY] Engine error:', e.message);
                currentProcess = null;
                isTransitioning = false;
                consecutiveFailures++;
                // FIX: on error, mark track as error but keep it in queue, advance pointer
            const qi = queue.findIndex(t => t.id === currentTrack.id);
                if (qi !== -1) queue[qi].status = 'error';
                advanceQueue();
                saveState(); broadcast(getStatus());
                if (isPlaying) playNextTimeout = setTimeout(playNext, 5000);
    }
}

function advanceQueue() {
        libraryIndex++;
        if (libraryIndex >= queue.length) { libraryIndex = 0; }
        saveState();
        broadcast(getStatus());
}

function startPlayback() {
        if (isOnAir && currentProcess) return;
        isOnAir = true; isPlaying = true;
        if (queue.length === 0) { queue = seedQueue(); saveState(); }
        lastDataTime = Date.now();
        playNext();
}

function stopPlayback() {
        isPlaying = false; isOnAir = false;
        engineEpoch++;
        if (currentProcess) {
                    currentProcess.removeAllListeners();
                    try { currentProcess.kill('SIGKILL'); } catch(e) {}
                    currentProcess = null;
        }
        broadcast(getStatus());
}

function skipTrack() {
        console.log('[ENGINE] Skip');
        engineEpoch++;
        if (currentProcess) {
                    currentProcess.removeAllListeners();
                    try { currentProcess.kill('SIGKILL'); } catch(e) {}
                    currentProcess = null;
        }
        advanceQueue();
        isTransitioning = false;
        if (isPlaying) playNext();
        else broadcast(getStatus());
}

// FIX: volume change restarts current track to apply new level
function setVolume(val) {
        volume = Math.min(100, Math.max(0, parseInt(val) || 80));
        saveState();
        broadcast({ type: 'volume', value: volume });
        // Restart current track so new volume takes effect immediately
    if (isPlaying && currentProcess) {
                engineEpoch++;
                currentProcess.removeAllListeners();
                try { currentProcess.kill('SIGKILL'); } catch(e) {}
                currentProcess = null;
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 500);
    }
}

// ── Jingles ───────────────────────────────────────────────────────────────────
function startAutoJingleLoop() {
        if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
        if (!autoJingles.start) return;
        const next = Math.floor(Math.random() * (240000 - 120000)) + 120000;
        autoJingleTimer = setTimeout(() => { dropJingle(); startAutoJingleLoop(); }, next);
}

function dropJingle(jingleFile = 'ident.mp3') {
        if (!isOnAir || !currentProcess) return;
        if (activeJingleProcess) return;
        let jinglePath = path.join(__dirname, 'public/app', jingleFile);
        if (!fs.existsSync(jinglePath)) jinglePath = path.join(dataDir, 'jingles', jingleFile);
        if (!fs.existsSync(jinglePath)) return;
        console.log(`[JINGLE] ${jingleFile}`);
        const args = ['-hide_banner', '-loglevel', 'error', '-i', jinglePath, '-f', 'mp3', '-b:a', '128k', '-'];
        activeJingleProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        activeJingleProcess.stdout.on('data', chunk => {
                    streamClients.forEach(c => { try { c.write(chunk); } catch(e) {} });
        });
        activeJingleProcess.on('close', () => { activeJingleProcess = null; });
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on('connection', ws => {
        clients.add(ws);
        ws.send(JSON.stringify(getStatus()));
        broadcast({ type: 'listeners', count: clients.size });

           ws.on('message', (data, isBinary) => {
                       if (isBinary) return; // mic/binary data no longer processed — engine is MP3-only
                         try {
                                         const msg = JSON.parse(data.toString());
                                         switch (msg.action) {
                                             case 'adminLogin':
                                                                     if (msg.password === ADMIN_PASSWORD) { ws.isAdmin = true; ws.send(JSON.stringify({ type: 'auth', success: true })); }
                                                                     break;
                                             case 'getStatus': ws.send(JSON.stringify(getStatus())); break;
                                             case 'play':   if (!isPlaying) startPlayback(); break;
                                             case 'pause':  stopPlayback(); break;
                                             case 'skip':   skipTrack(); break;
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
                                                                                                 queue.push(t); saveState(); broadcast(getStatus());
                                                                                                 enqueueDownload(t);
                                                                                                 if (!isPlaying) startPlayback();
                                                                     }
                                                                     break;
                                         }
                         } catch(e) {}
           });

           ws.on('close', () => {
                       clients.delete(ws);
                       broadcast({ type: 'listeners', count: clients.size });
           });
});

// ── HTTP Routes ───────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
        if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
        next();
};

// FIX: both /stream and /api/stream route to same handler
function streamHandler(req, res) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        streamClients.add(res);
        req.on('close', () => streamClients.delete(res));
}
app.get('/stream',     streamHandler);
app.get('/api/stream', streamHandler);

app.get('/api/status', (req, res) => res.json(getStatus()));
app.get('/api/queue',  (req, res) => res.json({ queue }));

app.post('/api/admin/login', (req, res) => {
        if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
        else res.status(401).json({ success: false });
});
app.get('/api/admin/verify', requireAuth, (req, res) => res.json({ success: true }));

app.post('/api/play',  requireAuth, (req, res) => { isOnAir = true; isPlaying = true; startPlayback(); res.json({ success: true }); });
app.post('/api/pause', requireAuth, (req, res) => { stopPlayback(); res.json({ success: true }); });
app.post('/api/skip',  requireAuth, (req, res) => { skipTrack(); res.json({ success: true }); });
app.post('/api/queue/skip', requireAuth, (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', requireAuth, (req, res) => {
        setVolume(req.body.value);
        res.json({ success: true, volume });
});

app.post('/api/admin/onair', requireAuth, (req, res) => {
        const { state } = req.body;
        if (state) { isOnAir = true; isPlaying = true; startPlayback(); }
        else stopPlayback();
        res.json({ success: true, isOnAir });
});

app.post('/api/admin/panic', requireAuth, (req, res) => {
        console.log('[PANIC] Resetting queue');
        stopPlayback();
        queue = seedQueue(); saveState(); broadcast(getStatus());
        res.json({ success: true });
});

app.post('/api/queue', requireAuth, (req, res) => {
        const { title, artist, youtubeQuery } = req.body;
        const entry = { id: Math.random().toString(36).slice(2), status: 'pending', title: title || 'Unknown', artist: artist || 'Unknown', youtubeQuery: youtubeQuery || title };
        queue.push(entry); saveState(); broadcast(getStatus());
        enqueueDownload(entry);
        if (!isPlaying) startPlayback();
        res.json({ success: true, id: entry.id });
});

app.post('/api/queue/add', requireAuth, (req, res) => {
        const { videoId, title, duration, url } = req.body;
        const vid = videoId || (url && url.match(/[?&]v=([^&]+)/)?.[1]);
        const entry = { id: Math.random().toString(36).slice(2), status: 'pending', title: title || 'Unknown', artist: 'YouTube',
                               youtubeQuery: vid ? ('https://www.youtube.com/watch?v=' + vid) : (url || title), duration: duration || '' };
        queue.push(entry); saveState(); broadcast(getStatus());
        enqueueDownload(entry);
        if (!isPlaying) startPlayback();
        res.json({ success: true, id: entry.id });
});

app.delete('/api/queue/:id', requireAuth, (req, res) => {
        const id = req.params.id;
        // FIX: track if currently playing so we can skip, but we do NOT shift — just filter
               const wasPlaying = currentTrack && currentTrack.id === id;
        const before = queue.length;
        queue = queue.filter(t => t.id !== id);
        if (queue.length !== before) saveState();
        if (wasPlaying && isPlaying) skipTrack();
        else broadcast(getStatus());
        res.json({ success: true });
});

app.post('/api/queue/:id/play-now', requireAuth, (req, res) => {
        const idx = queue.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ success: false });
        if (queue[idx].status !== 'ready') return res.status(400).json({ success: false, error: 'Not downloaded yet' });
        libraryIndex = idx;
        engineEpoch++;
        if (currentProcess) {
                    currentProcess.removeAllListeners();
                    try { currentProcess.kill('SIGKILL'); } catch(e) {}
                    currentProcess = null;
        }
        isOnAir = true; isPlaying = true;
        isTransitioning = false;
        playNext();
        res.json({ success: true });
});

app.post('/api/upload', requireAuth, upload.single('audio'), async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const ext  = path.extname(req.file.originalname);
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
        const track = { id: Math.random().toString(36).slice(2), status: 'ready', title, artist, youtubeQuery: 'LOCAL', localPath: newPath };
        queue.push(track); saveState(); broadcast(getStatus());
        if (!isPlaying) startPlayback();
        else if (currentTrack?.isSilence) skipTrack();
        res.json({ success: true, track });
});

app.get('/api/youtube/search', (req, res) => {
        const q = req.query.q?.replace(/['"\\]/g, '');
        if (!q) return res.json({ results: [] });
        const extractorArgs = 'youtube:player_client=default,android_sdkless';
        const cmd = `"${YTDLP_PATH}" --quiet --no-warnings --flat-playlist --print "%(id)s|||%(title)s|||%(duration_string)s" --extractor-args "${extractorArgs}" "ytsearch5:${q}"`;
        exec(cmd, { timeout: 30000 }, (err, stdout) => {
                    if (err || !stdout?.trim()) return res.json({ results: [] });
                    const results = stdout.trim().split('\n').filter(l => l.includes('|||')).map(line => {
                                    const [vid, title, dur] = line.split('|||').map(s => s?.trim());
                                    return { videoId: vid, title, url: 'https://www.youtube.com/watch?v=' + vid,
                                                                 thumbnail: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg', duration: dur };
                    });
                    res.json({ results });
        });
});

app.get('/api/herald',      (req, res) => res.json({ news }));
app.post('/api/herald',     requireAuth, (req, res) => { const item = { id: Date.now().toString(), date: new Date().toISOString(), ...req.body }; news.unshift(item); saveNews(); res.json({ success: true, item }); });
app.delete('/api/herald/:id', requireAuth, (req, res) => { news = news.filter(n => n.id !== req.params.id); saveNews(); res.json({ success: true }); });

app.get('/api/vault', (req, res) => {
        const pl = playlists[0] || { tracks: [] };
        res.json({ tracks: pl.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, thumbnail: t.thumbnail, status: 'ready' })) });
});

app.get('/api/admin/drive', requireAuth, (req, res) => {
        const dirs = [{ name: 'Downloads', path: downloadsDir }, { name: 'Jingles', path: path.join(dataDir, 'jingles') }];
        const validExts = ['.mp3', '.wav', '.ogg', '.m4a'];
        let files = [];
        dirs.forEach(dp => {
                    if (!fs.existsSync(dp.path)) return;
                    fs.readdirSync(dp.path).forEach(f => {
                                    if (!validExts.includes(path.extname(f).toLowerCase())) return;
                                    const stat = fs.statSync(path.join(dp.path, f));
                                    if (stat.isFile()) files.push({ name: f, size: stat.size, category: dp.name, fullPath: path.join(dp.path, f) });
                    });
        });
        res.json({ files });
});

app.get('/api/playlists', (req, res) => res.json({ playlists }));
app.post('/api/playlists', requireAuth, (req, res) => {
        const pl = { id: Date.now().toString(), name: req.body.name, tracks: [...queue] };
        playlists.push(pl); savePlaylists(); res.json({ success: true, playlists });
});
app.post('/api/playlists/:id/load', requireAuth, (req, res) => {
        const pl = playlists.find(p => p.id === req.params.id);
        if (!pl) return res.status(404).json({ success: false });
        queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
        saveState(); broadcast(getStatus()); if (!isPlaying) startPlayback();
        res.json({ success: true });
});

app.post('/api/jingle/:id', requireAuth, (req, res) => {
        const map = { '01': 'ident.mp3', '02': 'jingle02.mp3', '03': 'jingle03.mp3' };
        dropJingle(map[req.params.id] || `${req.params.id}.mp3`);
        res.json({ success: true });
});

app.get('/health', (req, res) => res.json({
        status: 'ok', uptime: process.uptime(), isPlaying, isOnAir,
        currentTrack: currentTrack?.title || null,
        queueLength: queue.length, streamClients: streamClients.size,
        lastDataAgeMs: Date.now() - lastDataTime, downloadQueueLength: downloadQueue.length
}));

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
        console.log(`[BUKUMA] Internet Radio live on port ${PORT}`);
        loadState();
        startMonitor();
        if (autoJingles.start) startAutoJingleLoop();
        setTimeout(() => {
                    if (isPlaying) {
                                    startPlayback();
                    } else if (queue.length === 0) {
                                    queue = seedQueue(); saveState(); isPlaying = true; startPlayback();
                    }
        }, 5000);
});
