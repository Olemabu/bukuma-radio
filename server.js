const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const mm = require('music-metadata');
const crypto = require('crypto');

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

// State
let state = {
    isPlaying: false,
    currentTrack: null,
    queue: [],
    library: [],
    volume: 80,
    micMode: 'OFF', // OFF, DUCK, SOLO
    micGate: 0.05,
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

// In-memory metadata cache: filename -> { title, artist }
const metaCache = {};

async function getTrackMeta(filename, filePath) {
    if (metaCache[filename]) return metaCache[filename];
    try {
        const meta = await mm.parseFile(filePath, { duration: false });
        const title = (meta.common.title || '').trim() || filename.replace(/\.mp3$/i, '');
        const artist = (meta.common.artist || meta.common.albumartist || '').trim() || 'Permanent Drive';
        metaCache[filename] = { title, artist };
    } catch(e) {
        metaCache[filename] = { title: filename.replace(/\.mp3$/i, ''), artist: 'Permanent Drive' };
    }
    return metaCache[filename];
}

async function scanLibrary() {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));

        // Resolve metadata for any files not yet cached
        const newFiles = files.filter(f => !metaCache[f]);
        await Promise.all(newFiles.map(f => getTrackMeta(f, path.join(MUSIC_DIR, f))));

        state.library = files.map(f => {
            const meta = metaCache[f] || { title: f.replace(/\.mp3$/i, ''), artist: 'Permanent Drive' };
            return {
                id: crypto.createHash('md5').update(f).digest('hex').slice(0, 12),
                title: meta.title,
                artist: meta.artist,
                path: path.join(MUSIC_DIR, f)
            };
        });

        // Refresh queue and stay in sync with current track
        state.queue = [...state.library];
        if (state.currentTrack) {
            const newIdx = state.queue.findIndex(t => t.id === state.currentTrack.id);
            if (newIdx !== -1) state.currentMusicIdx = newIdx;
        }

        if (!state.isPlaying) broadcastStatus();
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
        let musicVol = state.volume / 100;
        if (state.micMode === 'DUCK') musicVol *= 0.15;
        if (state.micMode === 'SOLO') musicVol = 0;
        const micChunk = micStream.read(chunk.length);
        for (let i = 0; i < chunk.length; i += 2) {
            let mSample = chunk.readInt16LE(i) * musicVol;
            let micSample = 0;
            if (state.micMode !== 'OFF' && micChunk && i < micChunk.length) {
                micSample = micChunk.readInt16LE(i);
            }
            let out = Math.max(-32768, Math.min(32767, mSample + micSample));
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
    micFilterProc = spawn('ffmpeg', args);
    micFilterProc.stdout.pipe(micStream, { end: false });
    
    micFilterProc.on('exit', () => {
        console.log('[MIXER] Mic Filter Closed.');
        micFilterProc = null;
    });
}

// --- API & WEBSOCKET ---
wss.on('connection', ws => {
    // Send initial status
    ws.send(JSON.stringify({ type: 'status', ...state, timestamp: Date.now() }));

    ws.on('message', data => {
        if (Buffer.isBuffer(data)) {
            // Incoming Raw PCM from Admin Mic
            if (micFilterProc) micFilterProc.stdin.write(data);
        } else {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'feedback') {
                    // Update global stats from listener feedback
                    state.listenerStats.vu = msg.vu;
                    state.listenerStats.latency = Date.now() - msg.timestamp;
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
app.post('/api/mic', (req, res) => { state.micMode = req.body.mode; if(state.micMode !== 'OFF') startMicFilter(); broadcastStatus(); res.json({ok:true}); });
app.post('/api/volume', (req, res) => { state.volume = req.body.volume; saveState(); broadcastStatus(); res.json({ok:true}); });

app.get('/api/debug-meta', async (req, res) => {
    try {
        const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
        if (files.length === 0) return res.json({ error: 'no files' });
        const f = files[0];
        const filePath = path.join(MUSIC_DIR, f);
        const meta = await mm.parseFile(filePath);
        res.json({ filename: f, common: meta.common, native_keys: Object.keys(meta.native || {}) });
    } catch(e) {
        res.json({ error: e.message });
    }
});

// --- INIT ---
loadState();
startMaster();
scanLibrary();
// Periodic scan to detect new files from the drive
setInterval(scanLibrary, 30000);

// Start playback if it was previously playing
if (state.isPlaying) playTrack();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bukuma Radio Pure Drive online on port ${PORT}`));
