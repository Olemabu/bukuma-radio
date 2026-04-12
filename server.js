const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const mm = require('music-metadata');
const crypto = require('crypto');
const multer = require('multer');

/**
 * AGUM BUKUMA RADIO - PURE DRIVE (STABLE VERSION)
 * Features: 3D Glassmorphism UI, Pro Mixer with Mic Gate/Comp/AGC
 */

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'downloads'); // Pointing back to 'downloads' where existing library sits
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MUSIC_DIR),
    filename: (req, file, cb) => {
        // Keep original filename but ensure it ends in .mp3 for the scanner
        let name = file.originalname;
        if (!name.toLowerCase().endsWith('.mp3')) name += '.mp3';
        cb(null, name);
    }
});
const upload = multer({ storage });

// State
let state = {
    isPlaying: false,
    currentTrack: null,
    queue: [],
    library: [],
    volume: 80,
    micMode: 'OFF', // OFF, DUCK, SOLO
    micGate: 0.05,
    micDuckLevel: 30, // % of music volume when ducking (0=silent, 100=no duck)
    elapsedTime: 0,
    duration: 0,
    currentMusicIdx: 0,
    listenerStats: { vu: 0, latency: 0 }
};

// --- CORE UTILS ---
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            state.isPlaying = saved.isPlaying || false;
            state.currentMusicIdx = saved.currentMusicIdx || 0;
            state.volume = saved.volume || 80;
        }
    } catch(e) {}
}

function saveState() {
    try {
        const toSave = {
            isPlaying: state.isPlaying,
            currentMusicIdx: state.currentMusicIdx,
            volume: state.volume
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(toSave));
    } catch(e) {}
}

// Persistent metadata cache stored on disk so titles survive restarts
const META_CACHE_FILE = path.join(DATA_DIR, 'meta_cache.json');
let metaCache = {};

function loadMetaCache() {
    try {
        if (fs.existsSync(META_CACHE_FILE)) {
            metaCache = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8'));
        }
    } catch(e) { metaCache = {}; }
}

function saveMetaCache() {
    try { fs.writeFileSync(META_CACHE_FILE, JSON.stringify(metaCache)); } catch(e) {}
}

// Fetch title for a YouTube video ID via yt-dlp (no re-download, metadata only)
function fetchYtTitle(videoId) {
    return new Promise(resolve => {
        const ytProc = spawn('yt-dlp', [
            '--no-playlist', '--print', '%(title)s|||%(uploader)s',
            '--no-warnings', '--quiet',
            `https://www.youtube.com/watch?v=${videoId}`
        ]);
        let out = '';
        ytProc.stdout.on('data', d => { out += d.toString(); });
        let errOut = '';
        ytProc.stderr.on('data', d => { errOut += d.toString(); });
        ytProc.on('close', code => {
            if (code === 0 && out.trim()) {
                const parts = out.trim().split('|||');
                const title = (parts[0] || '').trim();
                const artist = (parts[1] || '').trim() || 'Unknown Artist';
                console.log(`[META] Got title for ${videoId}: "${title}" / "${artist}"`);
                resolve({ title, artist });
            } else {
                if (errOut) console.log(`[META] yt-dlp error for ${videoId} (code=${code}): ${errOut.slice(0, 200)}`);
                resolve(null);
            }
        });
        // Timeout after 15 seconds to avoid hanging
        setTimeout(() => { try { ytProc.kill(); } catch(e) {} resolve(null); }, 15000);
    });
}

async function getTrackMeta(filename) {
    if (metaCache[filename]) return metaCache[filename];
    // Derive video ID from filename (strip extension)
    const videoId = filename.replace(/\.mp3$/i, '');
    // Check if it looks like a YouTube video ID (11 alphanumeric chars)
    const isYtId = /^[a-zA-Z0-9_-]{10,13}$/.test(videoId);
    if (isYtId) {
        const ytMeta = await fetchYtTitle(videoId);
        if (ytMeta && ytMeta.title) {
            metaCache[filename] = ytMeta;
            saveMetaCache();
            return ytMeta;
        }
    }
    // Fallback: use filename as title
    const fallback = { title: videoId, artist: 'Permanent Drive' };
    metaCache[filename] = fallback;
    saveMetaCache();
    return fallback;
}

async function scanLibrary() {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));

        // Build library immediately with cached/fallback titles (non-blocking for playback)
        state.library = files.map(f => {
            const cached = metaCache[f];
            const videoId = f.replace(/\.mp3$/i, '');
            return {
                id: crypto.createHash('md5').update(f).digest('hex').slice(0, 12),
                title: cached ? cached.title : videoId,
                artist: cached ? cached.artist : 'Permanent Drive',
                path: path.join(MUSIC_DIR, f)
            };
        });
        state.queue = [...state.library];
        if (state.currentTrack) {
            const newIdx = state.queue.findIndex(t => t.id === state.currentTrack.id);
            if (newIdx !== -1) state.currentMusicIdx = newIdx;
        }
        if (!state.isPlaying) broadcastStatus();

        // Fetch missing titles in background (batched to avoid rate limits)
        const missing = files.filter(f => !metaCache[f]);
        if (missing.length > 0) {
            console.log(`[META] Fetching titles for ${missing.length} uncached tracks...`);
            // Process 3 at a time to avoid hammering YouTube
            for (let i = 0; i < missing.length; i += 3) {
                const batch = missing.slice(i, i + 3);
                await Promise.all(batch.map(f => getTrackMeta(f)));
                // Update library entries with newly fetched titles
                state.library = state.library.map(t => {
                    const cached = metaCache[t.path.split('/').pop()];
                    if (cached) { t.title = cached.title; t.artist = cached.artist; }
                    return t;
                });
                state.queue = [...state.library];
                broadcastStatus();
                // Small delay between batches to be gentle on the API
                await new Promise(r => setTimeout(r, 500));
            }
            console.log('[META] Title fetch complete.');
        }
    } catch(e) {
        console.error('Scan error', e);
    }
}

function broadcastStatus() {
    const msg = JSON.stringify({ type: 'status', ...state, timestamp: Date.now() });
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

let masterProc = null;
let musicProc = null;
const streamClients = new Set();

// Mixer Shared Stream (Jitter Buffer)
let micStream = new PassThrough();

function startMaster() {
    if (masterProc) return;
    console.log('[ENGINE] Initializing Master Mixer...');
    
    // Master: Takes Mixed PCM -> MP3 192k Stream
    const args = [
        '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
        '-f', 'mp3', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        '-content_type', 'audio/mpeg', 'pipe:1'
    ];
    
    masterProc = spawn('ffmpeg', args);
    masterProc.stderr.on('data', d => console.log(`[MASTER-FF] ${d}`));
    masterProc.stdout.on('data', chunk => {
        streamClients.forEach(res => {
            try { res.write(chunk); } catch(e) { streamClients.delete(res); }
        });
    });
    
    masterProc.stdin.on('drain', () => {
        if (musicProc) musicProc.stdout.resume();
    });

    masterProc.on('exit', () => {
        console.log('[ENGINE] Master Mixer exited. Restarting...');
        masterProc = null;
        setTimeout(startMaster, 1000);
    });
}

let trackStartTime = 0;
async function playTrack() {
    if (!state.isPlaying || state.queue.length === 0) return;
    const track = state.queue[state.currentMusicIdx];
    if (!track) return;
    console.log(`[ENGINE] Playing: ${track.title}`);
    state.currentTrack = track;
    try {
        const metadata = await mm.parseFile(track.path);
        state.duration = metadata.format.duration || 0;
    } catch (e) {
        console.error(`[ENGINE] Metadata error for ${track.path}`, e);
        state.duration = 0;
    }
    state.elapsedTime = 0;
    // Flush stale mic data to prevent 'Ghost Voices'
    while (micStream.read()) {}

    // Kill old music proc BEFORE setting trackStartTime so the old exit handler
    // cannot read a freshly-reset trackStartTime and trigger another advance
    if (musicProc) {
        musicProc.stdout.removeAllListeners('data');
        musicProc.removeAllListeners('exit');
        musicProc.kill();
        musicProc = null;
    }

    // Capture start time locally so each track's exit handler uses its own value
    const thisStartTime = Date.now();
    trackStartTime = thisStartTime;

    broadcastStatus();
    saveState();

    const args = ['-re', '-i', track.path, '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'];
    const thisProc = spawn('ffmpeg', args);
    musicProc = thisProc;

    thisProc.stderr.on('data', d => {
        const msg = d.toString();
        if (msg.includes('size=') || msg.includes('frame=')) return;
        console.log(`[MUSIC-FF] ${msg.trim()}`);
    });

    thisProc.stdout.on('data', chunk => {
        if (!masterProc || !masterProc.stdin || musicProc !== thisProc) return;
        const mixed = Buffer.alloc(chunk.length);
        const baseVol = state.volume / 100;

        // Read mic chunk for this frame
        const micChunk = (state.micMode !== 'OFF') ? micStream.read(chunk.length) : null;

        // --- Sidechain ducking ---
        // Compute RMS of mic chunk to measure actual mic level (not just mode on/off)
        let micRMS = 0;
        if (micChunk && micChunk.length >= 2) {
            let sumSq = 0;
            for (let i = 0; i < micChunk.length; i += 2) {
                const s = micChunk.readInt16LE(i) / 32768;
                sumSq += s * s;
            }
            micRMS = Math.sqrt(sumSq / (micChunk.length / 2));
        }

        // Determine target music volume
        let targetVol;
        if (state.micMode === 'SOLO') {
            targetVol = 0;
        } else if (state.micMode === 'DUCK') {
            // Smooth sidechain: duck proportional to mic level
            // When micRMS exceeds gate threshold, reduce music
            const gate = state.micGate || 0.05;
            const duckFloor = (state.micDuckLevel !== undefined ? state.micDuckLevel : 30) / 100;
            if (micRMS > gate) {
                // How much above gate? Scale duck smoothly 
                const duckDepth = Math.min(1, (micRMS - gate) / 0.1); // full duck within 0.1 RMS above gate
                targetVol = baseVol * (1 - duckDepth * (1 - duckFloor));
            } else {
                targetVol = baseVol; // mic quiet — full music
            }
        } else {
            targetVol = baseVol;
        }

        // Apply smoothing to volume (attack/release envelope on duck)
        // Use a simple one-pole IIR: attack fast (mic comes in quick), release slow
        const attackCoeff = 0.3;   // fast attack
        const releaseCoeff = 0.05; // slow release
        const prevVol = thisProc._smoothVol !== undefined ? thisProc._smoothVol : baseVol;
        const smoothVol = targetVol < prevVol
            ? prevVol + attackCoeff * (targetVol - prevVol)   // ducking down
            : prevVol + releaseCoeff * (targetVol - prevVol); // releasing up
        thisProc._smoothVol = smoothVol;

        // Mix music + mic
        for (let i = 0; i < chunk.length; i += 2) {
            let mSample = chunk.readInt16LE(i) * smoothVol;
            let micSample = 0;
            if (micChunk && i < micChunk.length) {
                micSample = micChunk.readInt16LE(i);
            }
            const out = Math.max(-32768, Math.min(32767, Math.round(mSample + micSample)));
            mixed.writeInt16LE(out, i);
        }

        if (!masterProc.stdin.write(mixed)) {
            thisProc.stdout.pause();
        }
    });

    thisProc.on('exit', (code, signal) => {
        // Only act if this is still the active music process (not a killed old one)
        if (musicProc !== thisProc) return;
        musicProc = null;
        if (!state.isPlaying) return;
        // Use local thisStartTime — not the global — to get accurate elapsed time
        const elapsed = (Date.now() - thisStartTime) / 1000;
        const playDelay = elapsed < 3 ? 3000 : 1000;
        console.log(`[ENGINE] Track ended after ${elapsed.toFixed(1)}s (code=${code}). Next in ${playDelay}ms...`);
        setTimeout(() => {
            if (state.isPlaying) {
                state.currentMusicIdx = (state.currentMusicIdx + 1) % state.queue.length;
                playTrack();
            }
        }, playDelay);
    });
}

// --- MIC OPTIMIZER (GATE / COMP / AGC) ---
let micFilterProc = null;

function startMicFilter() {
    if (micFilterProc) return;
    console.log('[MIXER] Activating Pro Mic Filter Chain...');
    
    //agate (gate), compand (compression), volume (AGC/Gain)
    const args = [
        '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', 'pipe:0',
        '-af', 'agate=threshold=0.03:range=0.1,compand=attacks=0.1:decays=1:points=-90/-90|-45/-30|-20/-10|0/-3,volume=2.5',
        '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
    ];
    
    try {
        micFilterProc = spawn('ffmpeg', args);
        
        // Prevent server crash if FFmpeg stdin is closed or process dies
        micFilterProc.stdin.on('error', err => {
            console.error('[MIXER] Mic Filter Stdin Error:', err.message);
            stopMicFilter();
        });

        micFilterProc.stderr.on('data', d => {
            const msg = d.toString();
            if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fatal')) {
                console.error(`[MIXER-FF-ERR] ${msg.trim()}`);
            }
        });

        micFilterProc.stdout.pipe(micStream, { end: false });
        
        micFilterProc.on('exit', (code) => {
            console.log(`[MIXER] Mic Filter Closed (code=${code}).`);
            micFilterProc = null;
        });
    } catch (e) {
        console.error('[MIXER] Failed to spawn Mic Filter:', e);
        micFilterProc = null;
    }
}

function stopMicFilter() {
    if (micFilterProc) {
        console.log('[MIXER] Terminating Mic Filter Chain...');
        try {
            micFilterProc.stdin.end();
            micFilterProc.kill('SIGKILL'); // Force kill for fast cleanup
        } catch (e) {}
        micFilterProc = null;
    }
}

// --- API & WEBSOCKET ---
wss.on('connection', ws => {
    // Send initial status
    ws.send(JSON.stringify({ type: 'status', ...state, timestamp: Date.now() }));

    ws.on('message', data => {
        if (Buffer.isBuffer(data)) {
            // Incoming Raw PCM from Admin Mic - ensure pipe is healthy before writing
            if (micFilterProc && micFilterProc.stdin && micFilterProc.stdin.writable) {
                micFilterProc.stdin.write(data);
            }
        } else {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'feedback') {
                    // Update global stats from listener feedback
                    // Smoothing check
                    const newVU = msg.vu || 0;
                    const oldVU = state.listenerStats.vu || 0;
                    state.listenerStats.vu = (oldVU * 0.3) + (newVU * 0.7); // 70% new value for responsiveness
                    
                    // RTT Latency: Date.now() - captured refTime (the time the packet left the server)
                    if (msg.refTime) {
                        state.listenerStats.latency = Date.now() - msg.refTime;
                    } else if (msg.timestamp) {
                        state.listenerStats.latency = Date.now() - msg.timestamp;
                    }
                    
                    // Trigger status broadcast to update Admin UI with feedback
                    broadcastStatus();
                }
            } catch(e) {}
        }
    });
});

// Progress Tracker
setInterval(() => {
    if (state.isPlaying && state.duration > 0) {
        state.elapsedTime = (Date.now() - trackStartTime) / 1000;
        if (state.elapsedTime > state.duration) state.elapsedTime = state.duration;
        broadcastStatus();
    }
}, 1000);

app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'audio/mpeg');
    streamClients.add(res);
    req.on('close', () => streamClients.delete(res));
});

app.get('/api/status', (req, res) => res.json(state));
app.post('/api/play', (req, res) => { state.isPlaying = true; playTrack(); saveState(); res.json({ok:true}); });
app.post('/api/play-id', (req, res) => {
    console.log(`[API] Play request for ID: ${req.body.id}`);
    const idx = state.queue.findIndex(t => t.id === req.body.id);
    if (idx !== -1) {
        state.currentMusicIdx = idx;
        state.isPlaying = true;
        playTrack();
        saveState();
        res.json({ok:true});
    } else {
        console.error(`[API] Track not found for ID: ${req.body.id}`);
        res.status(404).json({error: 'Track not found'});
    }
});
app.post('/api/stop', (req, res) => { state.isPlaying = false; if(musicProc) musicProc.kill(); state.currentTrack = null; saveState(); broadcastStatus(); res.json({ok:true}); });
app.post('/api/skip', (req, res) => { state.currentMusicIdx = (state.currentMusicIdx+1)%state.queue.length; playTrack(); saveState(); res.json({ok:true}); });
app.post('/api/mic', (req, res) => { 
    state.micMode = req.body.mode; 
    if (state.micMode !== 'OFF') {
        startMicFilter(); 
    } else {
        stopMicFilter();
    }
    broadcastStatus(); 
    res.json({ok:true}); 
});
app.post('/api/volume', (req, res) => { state.volume = req.body.volume; saveState(); broadcastStatus(); res.json({ok:true}); });

app.post('/api/rename-track', (req, res) => {
    const { id, title, artist } = req.body;
    if (!id || !title) return res.status(400).json({ error: 'id and title required' });
    const track = state.library.find(t => t.id === id);
    if (!track) return res.status(404).json({ error: 'track not found' });
    const filename = track.path.split('/').pop();
    metaCache[filename] = { title: title.trim(), artist: (artist || '').trim() || 'Permanent Drive' };
    saveMetaCache();
    // Update in-memory library and queue
    state.library = state.library.map(t => t.id === id ? { ...t, title: title.trim(), artist: (artist || '').trim() || 'Permanent Drive' } : t);
    state.queue = [...state.library];
    if (state.currentTrack && state.currentTrack.id === id) {
        state.currentTrack.title = title.trim();
        state.currentTrack.artist = (artist || '').trim() || 'Permanent Drive';
    }
    broadcastStatus();
    res.json({ ok: true });
});
app.post('/api/mic-duck', (req, res) => {
    const level = parseInt(req.body.duckLevel);
    if (!isNaN(level) && level >= 0 && level <= 100) {
        state.micDuckLevel = level;
        broadcastStatus();
    }
    res.json({ ok: true, micDuckLevel: state.micDuckLevel });
});
app.post('/api/delete-track', (req, res) => {
    const id = req.body.id;
    if (!id) return res.status(400).json({ error: 'missing id' });
    const track = state.library.find(t => t.id === id);
    if (!track) return res.status(404).json({ error: 'not found' });
    try {
        fs.unlinkSync(track.path);
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
    // Remove from library, queue, metaCache
    state.library = state.library.filter(t => t.id !== id);
    state.queue = state.queue.filter(t => t.id !== id);
    if (metaCache[track.path.split('/').pop().replace('.mp3','')]) {
        delete metaCache[track.path.split('/').pop().replace('.mp3','')];
        saveMetaCache();
    }
    if (state.currentTrack && state.currentTrack.id === id) {
        state.currentMusicIdx = 0;
        playTrack();
    } else {
        state.currentMusicIdx = Math.min(state.currentMusicIdx, state.queue.length - 1);
    }
    broadcastStatus();
    res.json({ ok: true, remaining: state.library.length });
});

app.post('/api/upload', upload.array('tracks'), async (req, res) => {
    console.log(`[API] Uploaded ${req.files ? req.files.length : 0} tracks.`);
    await scanLibrary();
    res.json({ ok: true, count: req.files ? req.files.length : 0 });
});

// --- INIT ---
loadState();
loadMetaCache();
startMaster();
scanLibrary();
// Periodic scan to detect new files from the drive
setInterval(scanLibrary, 30000);

// Start playback if it was previously playing
if (state.isPlaying) playTrack();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bukuma Radio Pure Drive online on port ${PORT}`));
