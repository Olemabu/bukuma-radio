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
    return [
        { id: 'seed001', status: 'pending', title: 'Ozigizaga', artist: 'Alfred J King', youtubeQuery: 'Alfred J King Ozigizaga Ijaw highlife', duration: 'Unknown' },
        { id: 'seed002', status: 'pending', title: 'Earth Song', artist: 'Wizard Chan', youtubeQuery: 'Wizard Chan Earth Song Ijaw', duration: 'Unknown' },
        { id: 'seed003', status: 'pending', title: 'Paddle of the Niger Delta', artist: 'Barrister Smooth', youtubeQuery: 'Chief Barrister Smooth Ijaw highlife Niger Delta', duration: 'Unknown' },
        { id: 'seed004', status: 'pending', title: 'Tompolo', artist: 'Alfred J King', youtubeQuery: 'Alfred J King Tompolo Ijaw', duration: 'Unknown' },
        { id: 'seed005', status: 'pending', title: 'Halo Halo', artist: 'Wizard Chan', youtubeQuery: 'Wizard Chan Halo Halo Ijaw', duration: 'Unknown' },
        { id: 'seed006', status: 'pending', title: 'Ijaw Cultural Heritage', artist: 'Barrister Smooth', youtubeQuery: 'Barrister Smooth Ijaw cultural highlife best', duration: 'Unknown' },
        { id: 'seed007', status: 'pending', title: 'Adaka Boro', artist: 'Alfred J King', youtubeQuery: 'Alfred J King Adaka Boro', duration: 'Unknown' },
        { id: 'seed008', status: 'pending', title: 'HighLife', artist: 'Wizard Chan', youtubeQuery: 'Wizard Chan HighLife Ijaw Afro Teme', duration: 'Unknown' },
        { id: 'seed009', status: 'pending', title: 'Miss You', artist: 'Wizard Chan', youtubeQuery: 'Wizard Chan Miss You Thousand Voice', duration: 'Unknown' },
        { id: 'seed010', status: 'pending', title: 'Miekemedonmo', artist: 'Alfred J King', youtubeQuery: 'Alfred J King Miekemedonmo', duration: 'Unknown' }
    ].map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
}

// ── State ────────────────────────────────────────────────────────────────────
let queue        = seedQueue();
let currentTrack = null;
let isPlaying    = false; // Music playback state
let isOnAir      = false; // Global Broadcast state (STATION POWER)
let volume       = 80;
let micGain      = 150; // default 1.5x (150%)
let playlists    = [];
let programs     = []; // Priority List for Programming
let currentProgramIdx = -1;
let currentProcess   = null;
let isTransitioning  = false;
let playNextTimeout  = null;
let silenceInterval  = null;
let autoJingles      = { start: false, random: false };

// Neutral fallback (Station Ident) 
const SAFE_FALLBACK_URL = 'https://archive.org/download/bukuma-radio-ident/ident.mp3'; 
let consecutiveFailures = 0;
let serverMicState      = 0; // 0=Off, 1=Talk/Duck, 2=Solo
let lastLatencyMs       = 0; 

// Confidence Monitor (Watchdog) & Atomic Locking
let engineEpoch = 0;
let lastDataTime = Date.now();
let monitorTimer = null;
let lastMicTime = 0;

let autoJingleTimer = null;
let activeJingleProcess = null;

function startAutoJingleLoop() {
    if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
    if (!autoJingles.start) return;
    
    // Random between 2 and 4 minutes
    const nextInterval = Math.floor(Math.random() * (240000 - 120000 + 1)) + 120000;
    
    autoJingleTimer = setTimeout(() => {
        dropJingle();
        startAutoJingleLoop();
    }, nextInterval);
}

function dropJingle(jingleFile = 'ident.mp3') {
    if (!isOnAir || !currentProcess || !currentProcess.stdin || !currentProcess.stdin.writable) return;
    if (activeJingleProcess) return; 
    
    // Check in app folder first, then data/jingles
    let jinglePath = path.join(__dirname, 'public/app', jingleFile);
    if (!fs.existsSync(jinglePath)) {
        jinglePath = path.join(dataDir, 'jingles', jingleFile);
    }
    if (!fs.existsSync(jinglePath)) {
        console.warn(`[JINGLE] File not found: ${jinglePath}`);
        return;
    }
    
    console.log(`[JINGLE] Triggering branding: ${jingleFile}`);
    const args = ['-hide_banner', '-loglevel', 'error', '-i', jinglePath, '-f', 's16le', '-ar', '22050', '-ac', '1', '-'];
    activeJingleProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    
    activeJingleProcess.stdout.on('data', chunk => {
        try { if (currentProcess?.stdin?.writable) currentProcess.stdin.write(chunk); } catch(e) {}
    });
    
    activeJingleProcess.on('close', () => { activeJingleProcess = null; });
}


const clients       = new Set();
const streamClients = new Set();
let listeners = 0;

// ── Persistence ───────────────────────────────────────────────────────────────
const dataDir              = process.env.DATA_DIR || path.join(__dirname, 'data');
const downloadsDir         = path.join(dataDir, 'downloads');
const queueFile            = path.join(dataDir, 'queue.json');
const stateFile            = path.join(dataDir, 'state.json');
const playlistsFile        = path.join(dataDir, 'playlists.json');
const newsFile             = path.join(dataDir, 'news.json');

let news = [];

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
            volume      = Number(s.volume || 80);
            if (isNaN(volume)) volume = 80;
            micGain     = Number(s.micGain || 150);
            autoJingles = s.autoJingles || { start: false, random: false };
        }
        if (fs.existsSync(playlistsFile)) {
            playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
        }
        if (fs.existsSync(path.join(dataDir, 'programs.json'))) {
            programs = JSON.parse(fs.readFileSync(path.join(dataDir, 'programs.json'), 'utf8'));
        }
        if (fs.existsSync(newsFile)) {
            news = JSON.parse(fs.readFileSync(newsFile, 'utf8'));
        } else {
            // Seed defaults
            news = [
                { id:'n1', date: new Date().toISOString(), status:'news', title:'BUKUMA RADIO TRANSITIONS TO GLOBAL STREAMING', summary:'The historic Agum Bukuma Radio station announces a brand new high-fidelity digital broadcast wing for the diaspora.', content:'Today we celebrate a milestone in our history. Agum Bukuma Radio is now officially broadcasting live to the world from our newly hardened central station. Integrity, Culture, and Community remain our pillars.' },
                { id:'n2', date: new Date().toISOString(), status:'alert', title:'DELTA HIGHLIFE FESTIVAL ANNOUNCED', summary:'The annual Delta Highlife Cultural Festival will return to Bukuma Square this December.', content:'We are proud to announce the return of the Delta Highlife festival. Preparations are underway for the largest cultural gathering in the region. Stay tuned for the lineup!' }
            ];
            saveNews();
        }

        // --- HIGH-FIDELITY ARCHIVE ENABLED ---
        // Historical Rex Lawson purge policy removed. 
        // ----------------------------------

        // --- SELF-HEAL MISSING FILES ---
        // If a file is marked 'ready' but the physical file is gone, revert to 'pending'
        queue.forEach(t => {
            if (t.status === 'ready' && t.localPath && !fs.existsSync(t.localPath)) {
                console.log(`[HEAL] File missing for ${t.title}. Reverting to pending.`);
                t.status = 'pending';
                t.localPath = null;
            }
        });
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

function saveNews() {
    try { fs.writeFileSync(newsFile, JSON.stringify(news, null, 2)); } catch(e) {}
}

const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

function broadcast(msg) {
    const data = JSON.stringify(msg);
    clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function getStatus() {
    return { type: 'status', currentTrack, queue, isPlaying, isOnAir, volume, micGain, listeners, autoJingles, timestamp: Date.now(), serverMicState, latencyMs: lastLatencyMs };
}

// ── Watchdog & Downloader ────────────────────────────────────────────────────
function startMonitor() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(() => {
        // 1. Watchdog: Fix Dead Air
        if (isOnAir) {
            const idleMs = Date.now() - lastDataTime;
            
            // Check if process is actually alive
            let isZombie = false;
            if (currentProcess) {
                try { 
                    process.kill(currentProcess.pid, 0); 
                } catch(e) { 
                    isZombie = true; 
                    console.log('[WATCHDOG] Zombie process detected!');
                }
            }

            if (idleMs > 25000 || (isOnAir && !currentProcess && !isTransitioning) || isZombie) {
                console.log(`[WATCHDOG] Recovery triggered (Idle: ${idleMs}ms, Transit: ${isTransitioning}, Zombie: ${isZombie})`);
                lastDataTime = Date.now();
                isTransitioning = false; // Forced reset
                playNext();
            }
        }
        // 2. Downloader: Prepare next tracks
        const toDownload = queue.slice(0, 3).filter(t => t.status === 'pending');
        toDownload.forEach(t => downloadTrack(t));
    }, 5000);
}

// ── Audio engine ─────────────────────────────────────────────────────────────
async function getYouTubeUrl(query) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('YT-DLP Timeout after 20s'));
        }, 20000);

        const extractorArgs = 'youtube:player_client=default,android_sdkless';
        const cmd = `"${YTDLP_PATH}" --get-url --format "bestaudio/best" --no-playlist --ignore-errors --geo-bypass --no-check-certificates --extractor-args "${extractorArgs}" "ytsearch1:${query}"`;
        
        exec(cmd, { timeout: 25000 }, (err, stdout) => {
            clearTimeout(timeout);
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

function advanceQueue() {
    console.log('[ENGINE] Advancing Queue...');
    if (queue.length > 0) queue.shift();
    
    // --- Program Priority Check ---
    if (queue.length === 0 && programs.length > 0) {
        currentProgramIdx++;
        if (currentProgramIdx >= programs.length) {
            console.log('[ENGINE] Program Finished. Looping back to start.');
            currentProgramIdx = 0;
        }
        const block = programs[currentProgramIdx];
        if (block && block.type === 'set') {
            console.log(`[ENGINE] Transitioning to Program Block: ${block.name}`);
            const pl = playlists.find(p => p.id === block.playlistId);
            if (pl) queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2), status: 'pending' }));
        }
    }
    
    if (queue.length === 0) {
        console.log('[ENGINE] Refilling from seeds...');
        queue = seedQueue();
    }
    saveState();
    broadcast(getStatus());
}

function startPlayback() {
    if (isOnAir && currentProcess) {
        console.log('[ENGINE] Already On-Air.');
        return;
    }
    isOnAir = true;
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
    const myEpoch = engineEpoch; // Capture the current station lock ID
    if (!isOnAir) return;
    if (isTransitioning && myEpoch === engineEpoch) return;
    
    // Safety check: is an active process already running for this exact epoch?
    if (currentProcess && !isTransitioning) {
        console.log('[PLAY] Aborting - Engine already active for this epoch.');
        isTransitioning = false; // Maintenance: ensure state is clean
        return;
    }
    
    let isSilenceMode = false;
    if (queue.length === 0) {
        if (isOnAir) {
            isSilenceMode = true;
            currentTrack = { id: 'silence', title: 'STATION CONSOLE', artist: 'MASTER MODE (ON-AIR)', status: 'ready', isSilence: true };
        } else {
            advanceQueue();
        }
    } else {
        currentTrack = { ...queue[0] };
    }
    
    if (!currentTrack) return;
    
    // If still downloading, wait a bit
    if (currentTrack.status === 'downloading') {
        console.log(`[PLAY] Waiting for download: ${currentTrack.title}`);
        broadcast({ type: 'nowPlaying', track: { ...currentTrack, status: 'downloading' } });
        isTransitioning = false;
        playNextTimeout = setTimeout(playNext, 2000);
        return;
    }

    console.log('[PLAY] Loading:', currentTrack.title);
    broadcast({ type: 'nowPlaying', track: currentTrack });
    broadcast(getStatus());

    try {
        let inputSource = currentTrack.localPath;
        let ffmpegInputs = [];

        if (currentTrack.isSilence) {
            ffmpegInputs = ['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '3600']; // 1hr silence segments
        } else if (!inputSource || !fs.existsSync(inputSource)) {
            console.log(`[PLAY] Local file missing for ${currentTrack.title}, fetching live URL...`);
            
            const qIdx = queue.findIndex(t => t.id === currentTrack.id);
            if (qIdx !== -1) { 
                queue[qIdx].status = 'downloading'; 
                broadcast(getStatus()); 
            }
            
            inputSource = await getYouTubeUrl(currentTrack.youtubeQuery || currentTrack.title);
            
            if (myEpoch !== engineEpoch) {
                console.log('[PLAY] Transition overridden during URL fetch. Aborting.');
                isTransitioning = false;
                return;
            }
            
            if (qIdx !== -1) { 
                queue[qIdx].status = 'ready'; 
                broadcast(getStatus()); 
            }
            ffmpegInputs = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-i', inputSource];
        } else {
            ffmpegInputs = ['-i', inputSource];
        }

        if (currentProcess) {
            currentProcess.removeAllListeners();
            try { currentProcess.kill('SIGKILL'); } catch(e) {}
            currentProcess = null;
        }

        const userAgent = 'Mozilla/5.0 (Android 12; Mobile; rv:102.0) Gecko/102.0 Firefox/102.0'; 
        const musicVolume = (serverMicState === 2 || currentTrack.isSilence) ? 0 : (volume / 100);
        const mGain = micGain / 100; // default 1.5
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-user_agent', userAgent,
            '-headers', `Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n`,
            ...ffmpegInputs,
            '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', '-', // Input 1: Mic from Stdin
            '-vn',
            '-filter_complex', `[0:a]volume=${musicVolume}[music];[1:a]volume=${mGain},asplit[mic][sc];[music][sc]sidechaincompress=threshold=0.01:ratio=20:attack=10:release=1000[ducked];[ducked][mic]amix=inputs=2:duration=first,asplit=2[out][vu]`,
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
            if (Date.now() - lastMicTime < 300) return; // Prevent stuttering: don't inject silence if actively receiving mic data
            if (currentProcess && currentProcess.stdin && currentProcess.stdin.writable) {
                try { currentProcess.stdin.write(silenceBuffer); } catch(e) {}
            }
        }, 100);

        currentProcess.stdout.on('data', chunk => {
            bytesOut += chunk.length;
            lastDataTime = Date.now();
            streamClients.forEach(client => {
                try { 
                    const bufferSize = client.writableLength || (client.socket && client.socket.writableLength) || 0;
                    if (bufferSize > 1000000) { // ~1MB backpressure threshold
                        console.warn('[STREAM] Disconnecting lagging client to prevent memory bloat. Buffer size:', bufferSize);
                        client.end();
                        streamClients.delete(client);
                        return;
                    }
                    client.write(chunk); 
                } catch(e) { streamClients.delete(client); }
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
            if (myEpoch !== engineEpoch) return; // Completely ignore close events from aborted processes
            
            console.log(`[FFMPEG] Track closed (code: ${code}, delivery: ${bytesOut} bytes)`);
            clearInterval(silenceTimer);
            if (bytesOut < 1000 && isOnAir && !currentTrack.isSilence) consecutiveFailures++;
            else consecutiveFailures = 0;
            if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
            if (isOnAir) {
                if (!currentTrack.isSilence) advanceQueue();
                isTransitioning = false;
                playNextTimeout = setTimeout(playNext, 1500);
            }
        });

        currentProcess.on('error', err => {
            if (myEpoch !== engineEpoch) return;
            console.error('[FFMPEG] Spawn error:', err.message);
            isTransitioning = false;
            if (isOnAir) playNextTimeout = setTimeout(playNext, 3000);
        });

        isTransitioning = false;

    } catch(e) {
        if (myEpoch !== engineEpoch) {
            console.log('[PLAY] Soft abort during engine error block due to epoch change.');
            isTransitioning = false;
            return;
        }
        console.error('[PLAY] Error in engine:', e.message);
        isTransitioning = false;
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
            startFallbackStream(SAFE_FALLBACK_URL);
            return;
        }
        const retryDelay = Math.min(30000, 5000 * consecutiveFailures);
        
        queue[0].status = 'error';
        const failedTrack = queue.shift(); 
        queue.push(failedTrack); // Move to the bottom of the playlist instead of deleting it
        if (queue.length === 0) queue = seedQueue();
        
        saveState();
        broadcast(getStatus()); // Update UI immediately so they see the red error status
        
        if (isPlaying) playNextTimeout = setTimeout(playNext, retryDelay);
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
    advanceQueue();
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
                try { 
                    currentProcess.stdin.write(data); 
                    lastMicTime = Date.now();
                    
                    if (activeJingleProcess) {
                        try { activeJingleProcess.kill('SIGKILL'); } catch(e) {}
                        activeJingleProcess = null;
                        console.log('[JINGLE] Station Master mic keyed! Internal virtual DJ was violently preempted to prevent collision.');
                    }
                    
                    // Server-side Mic VU calculation to prove to the front-end that it is being received
                    if (data.length > 0) {
                        const recvTime = Date.now();
                        // Heartbeat/Latency calculation based on latest chunk arrival
                        lastLatencyMs = (recvTime - lastMicTime);
                        if (lastLatencyMs > 2000) lastLatencyMs = 120; // reset on long silence
                        
                        lastMicTime = recvTime;
                        
                        let sum = 0;
                        const samples = data.length / 2;
                        for (let i = 0; i < data.length; i += 2) {
                            const s = data.readInt16LE(i) / 32768; // 16-bit PCM to float
                            sum += s * s;
                        }
                        const rms = Math.sqrt(sum / samples);
                        const level = Math.min(100, Math.floor(rms * 400));
                        ws.send(JSON.stringify({ type: 'server_mic_vu', level }));
                    }
                } catch(e) {}
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
                case 'toggleAutoJingles':
                    autoJingles.start = !autoJingles.start;
                    saveState();
                    if (autoJingles.start) startAutoJingleLoop();
                    else if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
                    broadcast(getStatus());
                    break;
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

const requireAuth = (req, res, next) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    next();
};

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

app.get('/api/admin/verify', requireAuth, (req, res) => res.json({ success: true }));

app.post('/api/play', requireAuth, (req, res) => { 
    isOnAir = true;
    isPlaying = true; 
    startPlayback(); 
    res.json({ success: true, isOnAir }); 
});
app.post('/api/pause', requireAuth, (req, res) => { 
    isPlaying = false; // Stop music
    // Note: If isOnAir is still true, playNext will handle silence!
    broadcast(getStatus());
    res.json({ success: true, isPlaying }); 
});
app.post('/api/admin/onair', requireAuth, (req, res) => {
    const { state } = req.body;
    isOnAir = !!state;
    if (isOnAir) {
        isPlaying = true; // Auto-start music if turning on air? Or let user choose? 
        // Let's assume OnAir means "Active Station"
        startPlayback();
    } else {
        isPlaying = false;
        if (currentProcess) {
            currentProcess.removeAllListeners();
            try { currentProcess.kill('SIGKILL'); } catch(e) {}
            currentProcess = null;
        }
    }
    broadcast(getStatus());
    res.json({ success: true, isOnAir });
});
app.post('/api/skip', requireAuth, (req, res) => { skipTrack(); res.json({ success: true }); });
app.post('/api/queue/skip', requireAuth, (req, res) => { skipTrack(); res.json({ success: true }); });

app.post('/api/volume', requireAuth, (req, res) => {
    volume = Math.min(100, Math.max(0, parseInt(req.body.value) || 80));
    saveState(); broadcast({ type: 'volume', value: volume });
    res.json({ success: true, volume });
});

app.post('/api/volume/mic', requireAuth, (req, res) => {
    micGain = Math.min(300, Math.max(0, parseInt(req.body.value) || 100)); // up to 3x boost
    if (!isPlaying) return res.json({ success: true, micGain });
    
    // Live override tricky with ffmpeg complex filter, usually requires engine restart or live filter injection
    // For now, we update the state and next track will pick it up, or we force a restart
    broadcast({ type: 'micGain', value: micGain });
    res.json({ success: true, micGain });
});

app.post('/api/jingle/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    // Map ID to file
    const jingles = {
        '01': 'ident.mp3',
        '02': 'jingle02.mp3',
        '03': 'jingle03.mp3'
    };
    dropJingle(jingles[id] || `${id}.mp3`);
    res.json({ success: true });
});

app.post('/api/duck', requireAuth, (req, res) => {
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
app.get('/api/admin/drive', requireAuth, (req, res) => {
    const drivePaths = [
        { name: 'Downloads (Permanent)', path: path.join(dataDir, 'downloads') },
        { name: 'Jingles', path: path.join(dataDir, 'jingles') }
    ];
    let files = [];
    const validExts = ['.mp3', '.wav', '.ogg', '.m4a'];
    drivePaths.forEach(dp => {
        if (fs.existsSync(dp.path)) {
            const list = fs.readdirSync(dp.path);
            list.forEach(f => {
                const ext = path.extname(f).toLowerCase();
                if (!validExts.includes(ext)) return;
                const stat = fs.statSync(path.join(dp.path, f));
                if (stat.isFile()) files.push({ name: f, size: stat.size, category: dp.name, path: f, fullPath: path.join(dp.path, f) });
            });
        }
    });
    res.json({ files });
});

app.post('/api/admin/drive/play', requireAuth, (req, res) => {
    const { filePath, fileName } = req.body;
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ success: false });
    
    const track = {
        id: 'drive-' + Date.now().toString(36),
        status: 'ready',
        title: fileName || path.basename(filePath),
        artist: 'STATION DRIVE',
        localPath: filePath
    };
    
    playWithIntro(track);
    res.json({ success: true });
});

app.get('/api/herald', (req, res) => res.json({ news }));

// --- Public Library / Music Player Vault ---
app.get('/api/vault', (req, res) => {
    // Return the first curated set as the public "Vault"
    const pl = playlists[0] || { tracks: [] };
    res.json({ tracks: pl.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, thumbnail: t.thumbnail, status:'ready' })) });
});

app.post('/api/admin/panic', requireAuth, (req, res) => {
    console.log('[PANIC] Manual override - nuking state and refilling.');
    stopPlayback();
    queue = seedQueue();
    saveState();
    broadcast(getStatus());
    res.json({ success: true });
});

app.post('/api/herald', requireAuth, (req, res) => {
    const item = { id: Date.now().toString(), date: new Date().toISOString(), ...req.body };
    news.unshift(item); // Push to top
    saveNews();
    res.json({ success: true, item });
});

app.delete('/api/herald/:id', requireAuth, (req, res) => {
    news = news.filter(n => n.id !== req.params.id);
    saveNews();
    res.json({ success: true });
});

app.get('/api/admin/playlists', requireAuth, (req, res) => res.json({ playlists }));

app.post('/api/admin/playlists', requireAuth, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const pl = { id: Date.now().toString(), name, tracks: [...queue], createdAt: new Date().toISOString() };
    playlists.push(pl);
    fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2));
    res.json({ success: true, playlist: pl });
});

app.post('/api/admin/playlists/:id/load', requireAuth, (req, res) => {
    const pl = playlists.find(p => p.id === req.params.id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    
    // "The curated playlist should now be the queue"
    queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2), status: 'pending' }));
    currentProgramIdx = -1; // Manual override stops program loop
    saveState();
    broadcast(getStatus());
    res.json({ success: true });
});

app.get('/api/admin/programs', requireAuth, (req, res) => res.json({ programs }));

app.post('/api/admin/programs', requireAuth, (req, res) => {
    programs = req.body.programs || [];
    fs.writeFileSync(path.join(dataDir, 'programs.json'), JSON.stringify(programs, null, 2));
    broadcast(getStatus());
    res.json({ success: true });
});

app.post('/api/admin/programs/reset', requireAuth, (req, res) => {
    currentProgramIdx = -1;
    res.json({ success: true });
});

app.post('/api/upload', requireAuth, upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    const originalName = req.file.originalname;
    const ext = path.extname(originalName);
    const newName = `${req.file.filename}${ext}`;
    const newPath = path.join(downloadsDir, newName);
    
    fs.renameSync(req.file.path, newPath);

    let title = req.body.title || originalName.replace(ext, '');
    let artist = req.body.artist || 'Local Upload';

    // ID3 Metallurgy Injection
    try {
        const mm = await import('music-metadata');
        const metadata = await mm.parseFile(newPath);
        if (metadata.common.title) title = metadata.common.title;
        if (metadata.common.artist) artist = metadata.common.artist;
        console.log(`[ID3] Extracted: ${artist} - ${title}`);
    } catch (e) {
        console.warn(`[ID3] Metadata extraction failed for ${originalName}:`, e.message);
    }

    // Auto-detect Rex Lawson edge case specifically for uploads to prevent bypassing
    if (artist.toLowerCase().includes('rex lawson') || title.toLowerCase().includes('jolly')) {
        try { fs.unlinkSync(newPath); } catch(e) {}
        return res.status(403).json({ error: "Cardinal Rex Lawson content is strictly prohibited." });
    }

    const track = {
        id: Math.random().toString(36).slice(2),
        status: 'ready',
        title: title,
        artist: artist,
        youtubeQuery: `LOCAL: ${title}`,
        duration: 'Unknown',
        localPath: newPath
    };

    queue.push(track);
    saveState();
    broadcast(getStatus());
    
    if (!isPlaying) startPlayback();
    res.json({ success: true, track });
});

app.post('/api/queue', requireAuth, (req, res) => {
    const { url, title, artist, youtubeQuery } = req.body;
    const entry = { id: Math.random().toString(36).slice(2), status: 'pending', title: title || url, artist: artist || 'Unknown', youtubeQuery: youtubeQuery || url || title };
    queue.push(entry); 
    saveState(); 
    broadcast(getStatus());
    downloadTrack(entry);
    if (!isPlaying) startPlayback();
    res.json({ success: true, id: entry.id });
});

app.post('/api/queue/add', requireAuth, (req, res) => {
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

app.delete('/api/queue/:id', requireAuth, (req, res) => {
    const before = queue.length;
    queue = queue.filter(t => t.id !== req.params.id);
    if (queue.length !== before) saveState();
    broadcast(getStatus());
    res.json({ success: true });
});

// --- Professional Manual Play Logic ('Signature Intro Pipelining') ---
function playWithIntro(track) {
    // 1. HARD OVERRIDE: Destroy old world
    engineEpoch++;
    isTransitioning = true;
    
    // 2. Clear old timers immediately
    if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
    
    // 3. Kill current process and REMOVE listeners to prevent any shifts
    if (currentProcess) {
        currentProcess.removeAllListeners();
        try { currentProcess.kill('SIGKILL'); } catch(e) {}
        currentProcess = null;
    }

    // 4. Retire the track that was just ended to prevent it shifting to index 1
    if (queue.length > 0) {
        console.log(`[ENGINE] Retiring aborted track: ${queue[0].title}`);
        queue.shift(); 
    }

    // 5. Build the Deployment Segment (Intro + Track)
    const intro = {
        id: 'ident-' + Date.now().toString(36),
        status: 'ready',
        title: 'STATION IDENT', artist: 'BUKUMA RADIO',
        localPath: path.join(__dirname, 'public/app', 'ident.mp3')
    };
    if (!fs.existsSync(intro.localPath)) {
        intro.localPath = path.join(dataDir, 'jingles', 'ident.mp3');
    }
    
    // 6. Deploy the sequence
    queue.unshift(track);
    if (fs.existsSync(intro.localPath)) {
        console.log('[ENGINE] Pipelining Branded Intro...');
        queue.unshift(intro);
    }
    
    saveState();
    isOnAir   = true; 
    isPlaying = true;
    isTransitioning = false;
    
    // Invoke playback in the new epoch world
    playNext();
}

app.post('/api/queue/:id/play-now', requireAuth, (req, res) => {
    const idx = queue.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false });
    if (queue[idx].status !== 'ready') return res.status(400).json({ success: false, error: 'Track not on disk yet. Wait for download.' });
    
    const track = queue.splice(idx, 1)[0];
    playWithIntro(track);
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

app.post('/api/playlists', requireAuth, (req, res) => {
    const { name } = req.body;
    const pl = { id: Date.now().toString(), name, tracks: [...queue] };
    playlists.push(pl); savePlaylists();
    res.json({ success: true, playlists });
});

app.post('/api/playlists/:id/load', requireAuth, (req, res) => {
    const pl = playlists.find(p => p.id === req.params.id);
    if (!pl) return res.status(404).json({ success: false });
    queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
    saveState(); broadcast(getStatus());
    if (!isPlaying) startPlayback();
    res.json({ success: true });
});

app.post('/api/admin/playlists/:id/add-track', requireAuth, (req, res) => {
    const { track } = req.body;
    const pl = playlists.find(p => p.id === req.params.id);
    if (!pl || !track) return res.status(404).json({ success: false });
    
    // Safety check for duplicates (optional but good)
    if (!pl.tracks.find(t => t.id === track.id)) {
        pl.tracks.push(track);
        savePlaylists();
    }
    res.json({ success: true, count: pl.tracks.length });
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
    if (autoJingles.start) startAutoJingleLoop();
    setTimeout(() => { if (isPlaying) { startPlayback(); } else if (queue.length === 0) { console.log('[BOOT] Auto-starting with seed queue'); queue = seedQueue(); if (queue.length > 0) { saveState(); isPlaying = true; startPlayback(); } } }, 5000);
});
