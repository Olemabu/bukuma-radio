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
 * AGUM BUKUMA RADIO — STABLE ENGINE v2
 * Fixes: mic stream lifecycle, mic WebSocket isolation, feedback VU/latency,
 *        sample-rate handling, gate API, and sidechain accuracy.
 */

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Prioritize /data for Railway volumes, but fallback to local ./data
let DATA_DIR = path.join(__dirname, 'data');
if (process.platform !== 'win32' && fs.existsSync('/data')) DATA_DIR = '/data';

const MUSIC_DIR  = path.join(DATA_DIR, 'downloads');
const NEWS_DIR   = path.join(DATA_DIR, 'news');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
if (!fs.existsSync(NEWS_DIR))  fs.mkdirSync(NEWS_DIR, { recursive: true });

// ─── MULTER ──────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MUSIC_DIR),
  filename:    (req, file, cb) => {
    let name = file.originalname;
    if (!name.toLowerCase().endsWith('.mp3')) name += '.mp3';
    cb(null, name);
  }
});
const upload = multer({ storage });

// ─── RADIO STATE ─────────────────────────────────────────────────────────────
let state = {
  isPlaying:     false,
  currentTrack:  null,
  queue:         [],
  library:       [],
  volume:        80,
  micMode:       'OFF',   // OFF | DUCK | SOLO
  micGate:       0.05,    // RMS gate threshold (0.01–0.30)
  micDuckLevel:  30,      // % of music volume when ducking (0 = mute, 100 = no duck)
  onAirMessage:  '',       // custom on-air display text (empty = use track title)
  elapsedTime:   0,
  duration:      0,
  currentMusicIdx: 0,
  listenerStats: { vu: 0, latency: 0 },
  newsLibrary:   [],       // tracking our mastered news items
  overlayActive: false,    // true when a news item or stinger is playing
  overlayTitle:  '',       // title of current overlay
  newsVolume:    100,      // separate volume for news/overlay (0-200)
  isRecording:   false,    // true when capturing mic to a news item
  schedule:      [],       // list of { id, newsId, time, dayOfWeek }
  micHoldTime:   1000,     // ms to keep music ducked after speech ends
  activeOverlayId: null,   // ID of the currently playing news item
  playbackMode:  'REPEAT_ALL', // LINEAR | REPEAT_ONE | REPEAT_ALL
  shuffle:       false      // true if queue is randomized
};

// ─── PERSIST STATE ───────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.isPlaying      = saved.isPlaying      || false;
      state.currentMusicIdx = saved.currentMusicIdx || 0;
      state.volume         = saved.volume         || 80;
      state.schedule       = saved.schedule       || [];
      state.micDuckLevel   = saved.micDuckLevel   || 30;
      state.micGate        = saved.micGate        || 0.05;
      state.newsVolume      = saved.newsVolume      || 100;
    }
  } catch(e) { console.error('[STATE] Failed to load:', e.message); }
}
function saveState() {
  try {
    const data = JSON.stringify({
      isPlaying:       state.isPlaying,
      currentMusicIdx: state.currentMusicIdx,
      volume:          state.volume,
      newsVolume:      state.newsVolume,
      schedule:        state.schedule,
      micDuckLevel:    state.micDuckLevel,
      micGate:         state.micGate,
      playbackMode:    state.playbackMode,
      shuffle:         state.shuffle
    });
    fs.writeFileSync(STATE_FILE, data);
  } catch(e) { console.error('[STATE] Failed to save:', e.message); }
}

// ─── METADATA CACHE ──────────────────────────────────────────────────────────
const META_CACHE_FILE = path.join(DATA_DIR, 'meta_cache.json');
let metaCache = {};
function loadMetaCache() {
  try { if (fs.existsSync(META_CACHE_FILE)) metaCache = JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8')); }
  catch(e) { metaCache = {}; }
}
function saveMetaCache() {
  try { fs.writeFileSync(META_CACHE_FILE, JSON.stringify(metaCache)); } catch(e) {}
}

function fetchYtTitle(videoId) {
  return new Promise(resolve => {
    const proc = spawn('yt-dlp', [
      '--no-playlist', '--print', '%(title)s|||%(uploader)s',
      '--no-warnings', '--quiet',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);
    let out = '', errOut = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { errOut += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && out.trim()) {
        const parts = out.trim().split('|||');
        resolve({ title: (parts[0] || '').trim(), artist: (parts[1] || '').trim() || 'Unknown Artist' });
      } else {
        if (errOut) console.log(`[META] yt-dlp error for ${videoId}: ${errOut.slice(0, 200)}`);
        resolve(null);
      }
    });
    setTimeout(() => { try { proc.kill(); } catch(e) {} resolve(null); }, 15000);
  });
}

async function getTrackMeta(filename) {
  if (metaCache[filename]) return metaCache[filename];
  // For uploaded MP3s: use filename as title — no yt-dlp calls (avoid 15s hangs)
  const title = filename.replace(new RegExp('\\.mp3$', 'i'), '').replace(new RegExp('[_+-]', 'g'), ' ');
  const meta  = { title, artist: 'Community Radio' };
  metaCache[filename] = meta;
  saveMetaCache();
  return meta;
}

async function scanLibrary() {
  try {
    const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
    state.library = files.map(f => {
      const cached = metaCache[f];
      return {
        id:     crypto.createHash('md5').update('mus_'+f).digest('hex').slice(0, 12),
        title:  cached ? cached.title  : f.replace(/\.mp3$/i, ''),
        artist: cached ? cached.artist : 'Community Radio',
        path:   path.join(MUSIC_DIR, f)
      };
    });

    const missing = files.filter(f => !metaCache[f]);

    // 2. Scan News Library (Dedicated Folder)
    const nFiles = fs.readdirSync(NEWS_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
    state.newsLibrary = nFiles.map(f => {
      const cached = metaCache[f];
      return {
        id:     crypto.createHash('md5').update('nws_'+f).digest('hex').slice(0, 12),
        title:  cached ? cached.title  : f.replace(/\.mp3$/i, '').replace(/_/g, ' '),
        artist: cached ? cached.artist : 'Bukuma News',
        path:   path.join(NEWS_DIR, f)
      };
    });

    state.queue = [...state.library];
    if (state.currentTrack) {
      const idx = state.queue.findIndex(t => t.id === state.currentTrack.id);
      if (idx !== -1) state.currentMusicIdx = idx;
    }
    
    broadcastStatus();

    // Background scan for metadata (non-blocking)
    if (missing.length > 0) {
      (async () => {
        console.log(`[META] Fetching titles for ${missing.length} uncached tracks in background...`);
        for (let i = 0; i < missing.length; i += 3) {
          const chunk = missing.slice(i, i + 3);
          await Promise.all(chunk.map(f => getTrackMeta(f)));
          
          // Re-map title/artist from cache
          state.library = state.library.map(t => {
            const f = path.basename(t.path);
            if (metaCache[f]) {
              return { ...t, title: metaCache[f].title, artist: metaCache[f].artist };
            }
            return t;
          });
          state.queue = [...state.library];
          saveMetaCache();
          broadcastStatus();
        }
        console.log('[META] Background scan complete.');
      })();
    }
  } catch(e) { console.error('Scan error', e); }
}

function broadcastStatus() {
  const msg = JSON.stringify({ type: 'status', ...state, timestamp: Date.now() });
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ─── ENGINE: MASTER MIXER (FFmpeg MP3 encoder) ───────────────────────────────
let masterProc = null;
const streamClients = new Set();

function startMaster() {
  if (masterProc) return;
  console.log('[ENGINE] Initializing Master Mixer...');
  masterProc = spawn('ffmpeg', [
    '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
    '-af', 'alimiter=level_in=1:level_out=0.9:limit=0.95:attack=5:release=50',
    '-f', 'mp3', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-content_type', 'audio/mpeg', 'pipe:1'
  ]);
  masterProc.stderr.on('data', d => {
    const msg = d.toString();
    if (msg.toLowerCase().includes('error')) console.error(`[MASTER-ERR] ${msg.trim()}`);
  });
  masterProc.stdin.on('error', err => {
    console.error('[MASTER-STDIN] Pipe Error (likely closed):', err.message);
  });
  masterProc.stdout.on('data', chunk => {
    streamClients.forEach(res => { try { res.write(chunk); } catch(e) { streamClients.delete(res); } });
  });
  masterProc.stdin.on('drain', () => { if (musicProc) musicProc.stdout.resume(); });
  masterProc.on('exit', () => {
    console.log('[ENGINE] Master Mixer exited. Restarting...');
    // Force disconnect all streaming listeners so they immediately trigger reconnect
    streamClients.forEach(res => { try { res.end(); } catch(e) {} });
    streamClients.clear();
    masterProc = null;
    setTimeout(startMaster, 1000);
  });
}

function restartMixer() {
  console.log('[ENGINE] Manual Mixer Restart triggered...');
  if (masterProc) masterProc.kill();
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  // Init sequence / interval will handle restarts
  setTimeout(startHeartbeat, 500);
}

// ─── ENGINE: MUSIC PLAYER ────────────────────────────────────────────────────
let musicProc     = null;
let trackStartTime = 0;

// ─── ENGINE: OVERLAY PLAYER ──────────────────────────────────────────────────
let overlayProc = null;
let activeOverlayStream = new PassThrough();

function stopOverlay() {
  if (overlayProc) {
    console.log('[ENGINE] Stopping Overlay Broadcast...');
    try { overlayProc.kill('SIGKILL'); } catch(e) {}
    overlayProc = null;
  }
  state.overlayActive = false;
  state.overlayTitle = '';
  state.activeOverlayId = null;
  // Drain any remaining audio data to ensure clean slate for next broadcast
  if (activeOverlayStream) {
    let chunk;
    while ((chunk = activeOverlayStream.read()) !== null) {}
  }
  broadcastStatus();
}

function startOverlay(filePath) {
  stopOverlay(); // ensure clean state
  console.log(`[ENGINE] Starting Overlay: ${filePath}`);
  activeOverlayStream = new PassThrough();
  
  overlayProc = spawn('ffmpeg', [
    '-re', '-i', filePath,
    '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
  ]);
  
  overlayProc.stdout.on('data', chunk => {
    activeOverlayStream.write(chunk);
  });
  
  overlayProc.on('exit', () => {
    console.log('[ENGINE] Overlay Finished.');
    overlayProc = null;
    state.overlayActive = false;
    state.overlayTitle = '';
    broadcastStatus();
  });
  
  const item = state.newsLibrary.find(n => n.path === filePath);
  state.overlayTitle = item ? item.title : 'News Broadcast';
  state.activeOverlayId = item ? item.id : null;
  state.overlayActive = true;
  broadcastStatus();
}

// ─── ENGINE: NEWS RECORDER ───────────────────────────────────────────────────
let newsRecordStream = null;
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

function startNewsRecording() {
  const filename = `report_${Date.now()}.raw`;
  const filePath = path.join(RECORDINGS_DIR, filename);
  console.log(`[RECORDER] Starting capture: ${filename}`);
  newsRecordStream = fs.createWriteStream(filePath);
  state.isRecording = true;
  broadcastStatus();
}

function stopNewsRecording() {
  if (!newsRecordStream) return;
  const rawPath = newsRecordStream.path;
  newsRecordStream.end();
  newsRecordStream = null;
  state.isRecording = false;
  console.log(`[RECORDER] Capture stopped. Mastering...`);

  // Master the recording: RAW (48k mono) -> MP3 (Broadcast Chain)
  const outFilename = `news_report_${Date.now()}.mp3`;
  const outPath     = path.join(NEWS_DIR, outFilename);
  
  const args = [
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', rawPath,
    '-af', [
      'asubcut=cutoff=60', // sub-bass rumble removal
      'highpass=f=120', // room mud removal
      'afftdn=nf=-25', // FFT-based noise reduction
      'agate=threshold=0.05:range=0.05:attack=10:release=100', // snap-gate for echo
      'anequalizer=c0 f=100 w=50 g=4|c0 f=3500 w=1000 g=3|c0 f=10000 w=2000 g=2', // radio shine EQ
      'compand=attacks=0.01:decays=0.1:points=-90/-90|-40/-15|-10/-4|0/-1', // aggressive radio compression
      'loudnorm=I=-14:TP=-1.0', // loud broadcast standard
      'volume=2.7' // increased gain as requested (+35%)
    ].join(','),
    '-y', outPath
  ];
  
  const proc = spawn('ffmpeg', args);
  proc.on('close', code => {
    if (code === 0) {
      console.log(`[RECORDER] News item mastered: ${outFilename}`);
      scanLibrary(); // refresh newsLibrary
    } else {
      console.error(`[RECORDER] Mastering failed with code ${code}`);
    }
    try { fs.unlinkSync(rawPath); } catch(e) {} // cleanup raw
  });
  
  broadcastStatus();
}

async function playTrack() {
  if (!state.isPlaying || state.queue.length === 0) return;
  const track = state.queue[state.currentMusicIdx];
  if (!track) return;
  console.log(`[ENGINE] Playing: ${track.title}`);
  state.currentTrack = track;
  try { const metadata = await mm.parseFile(track.path); state.duration = metadata.format.duration || 0; }
  catch(e) { state.duration = 0; }
  state.elapsedTime = 0;

  // Flush stale mic buffer
  flushMicStream();

  // Kill old music process cleanly
  if (musicProc) {
    musicProc.stdout.removeAllListeners('data');
    musicProc.removeAllListeners('exit');
    musicProc.kill();
    musicProc = null;
  }

  const thisStartTime = Date.now();
  trackStartTime = thisStartTime;
  broadcastStatus();
  saveState();

  const thisProc = spawn('ffmpeg', [
    '-re', '-i', track.path,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
  ]);
  musicProc = thisProc;

  thisProc.stderr.on('data', d => {
    const msg = d.toString();
    if (msg.includes('size=') || msg.includes('frame=')) return;
    console.log(`[MUSIC-FF] ${msg.trim()}`);
  });

    thisProc.on('exit', (code, signal) => {
      if (musicProc !== thisProc) return;
      musicProc = null;
      if (!state.isPlaying) return;

      const elapsed   = (Date.now() - thisStartTime) / 1000;
      const playDelay = elapsed < 3 ? 3000 : 1000;
      console.log(`[ENGINE] Track ended. Mode: ${state.playbackMode}`);

      setTimeout(() => {
        if (!state.isPlaying) return;
        
        if (state.playbackMode === 'REPEAT_ONE') {
          // Play same track again
          playTrack();
        } else if (state.playbackMode === 'REPEAT_ALL') {
          // Move to next, loop back if at end
          state.currentMusicIdx = (state.currentMusicIdx + 1) % state.queue.length;
          playTrack();
        } else {
          // LINEAR: stop at end
          if (state.currentMusicIdx < state.queue.length - 1) {
            state.currentMusicIdx++;
            playTrack();
          } else {
            console.log('[ENGINE] Queue finished (Linear mode).');
            state.isPlaying = false;
            state.currentTrack = null;
            broadcastStatus();
          }
        }
      }, playDelay);
    });
}

// ─── ENGINE: CONTINUOUS HEARTBEAT & MIXER ────────────────────────────────────
let heartbeatInterval = null;

function startHeartbeat() {
  if (heartbeatInterval) return;
  console.log('[ENGINE] Starting High-Precision Heartbeat Mixer...');

  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const chunkSize = 4096; // ~46ms of audio per pulse
  
  heartbeatInterval = setInterval(() => {
    if (!masterProc || !masterProc.stdin || !masterProc.stdin.writable) return;

    const chunk = Buffer.alloc(chunkSize);
    const finalBuffer = Buffer.alloc(chunkSize);
    
    // Pull audio directly from source streams (using non-blocking .read())
    const mChunk   = (musicProc)   ? musicProc.stdout.read(chunkSize) : null;
    const micChunk = (state.micMode !== 'OFF') ? activeMicStream.read(chunkSize) : null;
    const overChunk = (state.overlayActive)   ? activeOverlayStream.read(chunkSize) : null;

    // Sidechain Logic (Ducking)
    let triggerRMS = 0;
    const activeTrigger = (micChunk) ? micChunk : (overChunk ? overChunk : null);
    if (activeTrigger && activeTrigger.length >= 2) {
      let sumSq = 0;
      for (let i = 0; i < activeTrigger.length; i += 2) {
        const s = activeTrigger.readInt16LE(i) / 32768;
        sumSq += s * s;
      }
      triggerRMS = Math.sqrt(sumSq / (activeTrigger.length / 2));
    }

    let targetVol;
    const baseVol = state.volume / 100;
    const isPaused = !state.isPlaying;

    if (state.micMode === 'SOLO') {
      targetVol = 0;
    } else if (state.micMode === 'DUCK' || state.overlayActive) {
      const gate = state.micGate || 0.05;
      const duckFloor = (state.micDuckLevel !== undefined ? state.micDuckLevel : 30) / 100;
      
      if (triggerRMS > gate) {
        state._micLastActive = Date.now();
        // Dynamic ducking depth based on how much the voice exceeds the gate
        const duckDepth = Math.min(1, (triggerRMS - gate) / 0.1);
        targetVol = isPaused ? 0 : baseVol * (1 - duckDepth * (1 - duckFloor));
      } else {
        // Voice is below gate (silence/breaths): check if we are in "hold" period
        const inHold = (Date.now() - (state._micLastActive || 0)) < state.micHoldTime;
        if (inHold) {
          targetVol = isPaused ? 0 : baseVol * duckFloor;
        } else {
          targetVol = isPaused ? 0 : baseVol;
        }
      }
    } else {
      targetVol = isPaused ? 0 : baseVol;
    }

    // Smooth volume transition
    // Fast ducking (down), slow recovery (up)
    const recoveryCoeff = 0.05, duckingCoeff = 0.8;
    if (state._smoothVol === undefined) state._smoothVol = baseVol;
    state._smoothVol = (targetVol > state._smoothVol) 
      ? state._smoothVol + recoveryCoeff * (targetVol - state._smoothVol) 
      : state._smoothVol + duckingCoeff * (targetVol - state._smoothVol);
    
    const smoothVol = state._smoothVol;

    // Mixing Loop
    let masterRMS = 0;
    const newsVol = state.newsVolume / 100;
    for (let i = 0; i < chunkSize; i += 2) {
      let mSample = (mChunk && i < mChunk.length) ? mChunk.readInt16LE(i) * smoothVol : 0;
      let micSample = (micChunk && i < micChunk.length) ? micChunk.readInt16LE(i) : 0;
      let overSample = (overChunk && i < overChunk.length) ? overChunk.readInt16LE(i) * newsVol : 0;

      const out = Math.max(-32768, Math.min(32767, Math.round(mSample + micSample + overSample)));
      finalBuffer.writeInt16LE(out, i);
      masterRMS += (out / 32768) ** 2;
    }

    // Silence Guard: If playing but RMS is 0 for too long, reset mixer
    masterRMS = Math.sqrt(masterRMS / (chunkSize / 2));
    if (state.isPlaying && masterRMS < 0.0001) {
      state._silenceCount = (state._silenceCount || 0) + 1;
      if (state._silenceCount > 1000) { // ~45 seconds (increased for high-cpu filters)
        console.warn('[GUARD] Silence detected, restarting master...');
        state._silenceCount = 0;
        restartMixer();
      }
    } else {
      state._silenceCount = 0;
    }

    try {
      masterProc.stdin.write(finalBuffer);
    } catch (e) {
      console.error('[MIXER] Write Error:', e.message);
    }
  }, Math.floor((chunkSize / (sampleRate * channels * bytesPerSample)) * 1000));
}

// ─── MIC FILTER (FFmpeg gate/comp/AGC) ───────────────────────────────────────
// FIX: Each mic activation creates a FRESH PassThrough so old pipes don't bleed
// in. activeMicStream is what the music mixer reads from.
let micFilterProc  = null;
let activeMicStream = new PassThrough();

function flushMicStream() {
  // Drain any buffered audio to prevent ghost voices at track start
  let chunk;
  while ((chunk = activeMicStream.read()) !== null) {}
}

function startMicFilter() {
  if (micFilterProc) return;
  console.log('[MIXER] Activating Pro Mic Filter Chain...');

  // Create a fresh stream for this mic session — prevents old data bleeding in
  activeMicStream = new PassThrough();

  // Accept raw PCM at 48000 Hz (standard browser WebAudio rate).
  // The old 22050 rate caused distortion when browsers defaulted to 48 kHz.
  // Output: 44100 Hz stereo to feed the master mixer directly.
  // Implementation of 250ms Jitter Buffer and Soft-Knee Compression
  // -thread_queue_size 4096 gives us the headroom for internet jitter.
  const args = [
    '-thread_queue_size', '4096',
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
    '-af', [
      'asubcut=cutoff=60', // absolute silence for floor rumble
      'highpass=f=120', // dry out the boxy room mid-bass
      'afftdn=nf=-25', // FFT-based noise reduction (strips room hum/air)
      'agate=threshold=0.04:range=0.1:attack=20:release=150', // tighter gate for room echo
      'anequalizer=c0 f=125 w=100 g=3|c0 f=3000 w=500 g=2', // radio warmth
      'compand=attacks=0.02:decays=0.3:points=-90/-90|-40/-20|-10/-5|0/-1', // tighter vocal compression
      'loudnorm=I=-14:TP=-1.0',
      'volume=2.7' // increased gain as requested
    ].join(','),
    '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
  ];

  try {
    micFilterProc = spawn('ffmpeg', args);
    micFilterProc.stdin.on('error', err => {
      console.error('[MIXER] Mic Filter Stdin Error:', err.message);
      stopMicFilter();
    });
    micFilterProc.stderr.on('data', d => {
      const msg = d.toString();
      if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fatal'))
        console.error(`[MIXER-FF-ERR] ${msg.trim()}`);
    });
    // Pipe into the freshly-created stream — no double-pipe risk
    micFilterProc.stdout.pipe(activeMicStream, { end: false });
    micFilterProc.on('exit', code => {
      console.log(`[MIXER] Mic Filter Closed (code=${code}).`);
      micFilterProc = null;
    });
  } catch(e) {
    console.error('[MIXER] Failed to spawn Mic Filter:', e);
    micFilterProc = null;
  }
}

function stopMicFilter() {
  if (!micFilterProc) return;
  console.log('[MIXER] Terminating Mic Filter Chain...');
  try { micFilterProc.stdin.end(); micFilterProc.kill('SIGKILL'); } catch(e) {}
  micFilterProc = null;
  flushMicStream();
}

// ─── WEBSOCKET HANDLER ───────────────────────────────────────────────────────
wss.on('connection', ws => {
  // Tag the connection so we can differentiate admin vs listener
  ws._isAdmin = false;
  ws._feedbackPending = 0;

  ws.send(JSON.stringify({ type: 'status', ...state, timestamp: Date.now() }));

  ws.on('message', data => {
    if (Buffer.isBuffer(data)) {
      // Raw PCM from admin mic — write to mic filter if open
      ws._isAdmin = true;
      if (micFilterProc && micFilterProc.stdin && micFilterProc.stdin.writable) {
        micFilterProc.stdin.write(data);
      }
      // If recording news, write the raw PCM to the file stream
      if (state.isRecording && newsRecordStream && newsRecordStream.writable) {
        newsRecordStream.write(data);
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'feedback') {
          // ─── FEEDBACK VU + LATENCY FIX ───────────────────────────────────
          // Smooth the incoming VU (70% new, 30% old) for responsiveness
          const newVU = Math.min(100, Math.max(0, msg.vu || 0));
          state.listenerStats.vu = (state.listenerStats.vu * 0.3) + (newVU * 0.7);

          // RTT latency: the admin sent { timestamp: Date.now() } when the
          // feedback ping left the browser. Round-trip = now - that timestamp.
          // We clamp to 0 to avoid negative values from clock skew.
          if (msg.timestamp) {
            const rtt = Date.now() - msg.timestamp;
            // Smooth: 80% new value so the display reacts quickly
            state.listenerStats.latency = Math.max(0,
              Math.round((state.listenerStats.latency * 0.2) + (rtt * 0.8))
            );
          }

          // Broadcast updated stats to all admin clients
          broadcastStatus();
        }
      } catch(e) {}
    }
  });

  ws.on('close', () => {
    // If this was the admin mic WebSocket and mic is SOLO/DUCK, we lose audio.
    // Log it so it's visible in server console.
    if (ws._isAdmin) console.log('[WS] Admin mic connection closed.');
  });
});

// ─── PROGRESS TRACKER ────────────────────────────────────────────────────────
setInterval(() => {
  if (state.isPlaying && state.duration > 0) {
    state.elapsedTime = Math.min(state.duration, (Date.now() - trackStartTime) / 1000);
    broadcastStatus();
  }
}, 1000);

// ─── HTTP STREAM ─────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');
  
  // ICY Metadata support (helps some players)
  res.setHeader('icy-name', 'Agum Bukuma Radio');
  res.setHeader('icy-genre', 'Community');
  res.setHeader('icy-metaint', '0');

  // Stream Flush: Send a tiny burst if possible to wake up the browser player
  // We'll add the client to the set for real-time data
  streamClients.add(res);
  
  req.on('close', () => {
    streamClients.delete(res);
  });
});

// ─── API ROUTES ──────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json(state));

app.post('/api/play', (req, res) => {
  state.isPlaying = true;
  playTrack(); saveState();
  res.json({ ok: true });
});

app.post('/api/play-id', (req, res) => {
  const idx = state.queue.findIndex(t => t.id === req.body.id);
  if (idx !== -1) {
    state.currentMusicIdx = idx;
    state.isPlaying = true;
    playTrack(); saveState();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Track not found' });
  }
});

app.post('/api/stop', (req, res) => {
  state.isPlaying = false;
  if (musicProc) musicProc.kill();
  state.currentTrack = null;
  saveState(); broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/skip', (req, res) => {
  state.currentMusicIdx = (state.currentMusicIdx + 1) % state.queue.length;
  playTrack(); saveState();
  res.json({ ok: true });
});

app.post('/api/mic', (req, res) => {
  state.micMode = req.body.mode;
  if (state.micMode !== 'OFF') startMicFilter(); else stopMicFilter();
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/volume', (req, res) => {
  state.volume = req.body.volume;
  saveState(); broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/news/volume', (req, res) => {
  const vol = parseInt(req.body.volume);
  if (!isNaN(vol) && vol >= 0 && vol <= 200) {
    state.newsVolume = vol;
    saveState(); broadcastStatus();
  }
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

// NEW: Playback Modes
app.post('/api/playback-mode', (req, res) => {
  const modes = ['LINEAR', 'REPEAT_ONE', 'REPEAT_ALL'];
  if (modes.includes(req.body.mode)) {
    state.playbackMode = req.body.mode;
    saveState(); broadcastStatus();
  }
  res.json({ ok: true, mode: state.playbackMode });
});

app.post('/api/shuffle', (req, res) => {
  state.shuffle = !!req.body.shuffle;
  
  if (state.shuffle) {
    // Shuffle the queue (Fisher-Yates)
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
  } else {
    // Restore default library order
    state.queue = [...state.library];
  }
  
  // Re-sync currentMusicIdx to keep current track playing if possible
  if (state.currentTrack) {
    const newIdx = state.queue.findIndex(t => t.id === state.currentTrack.id);
    if (newIdx !== -1) state.currentMusicIdx = newIdx;
  }

  saveState(); broadcastStatus();
  res.json({ ok: true, shuffle: state.shuffle });
});

// NEW: Expose the mic gate threshold so the admin UI slider can tune it live
app.post('/api/mic-gate', (req, res) => {
  const gate = parseFloat(req.body.gate);
  if (!isNaN(gate) && gate >= 0 && gate <= 1) {
    state.micGate = gate;
    console.log(`[MIXER] Gate threshold set to ${gate.toFixed(3)}`);
  }
  res.json({ ok: true, micGate: state.micGate });
});

// NEW: Custom on-air display message — broadcast to all listeners + admin
app.post('/api/on-air-message', (req, res) => {
  const msg = (req.body.message || '').toString().trim().slice(0, 120);
  state.onAirMessage = msg;
  broadcastStatus();
  res.json({ ok: true, onAirMessage: state.onAirMessage });
});

app.post('/api/rename-track', (req, res) => {
  const { id, title, artist } = req.body;
  if (!id || !title) return res.status(400).json({ error: 'id and title required' });
  const track = state.library.find(t => t.id === id);
  if (!track) return res.status(404).json({ error: 'track not found' });
  const filename = track.path.split('/').pop();
  metaCache[filename] = { title: title.trim(), artist: (artist || '').trim() || 'Community Radio' };
  saveMetaCache();
  state.library = state.library.map(t => t.id === id ? { ...t, title: title.trim(), artist: (artist || '').trim() || 'Community Radio' } : t);
  state.queue   = [...state.library];
  if (state.currentTrack && state.currentTrack.id === id) {
    state.currentTrack.title  = title.trim();
    state.currentTrack.artist = (artist || '').trim() || 'Community Radio';
  }
  broadcastStatus();
  res.json({ ok: true });
});

app.post('/api/seek', (req, res) => {
  const seconds = parseFloat(req.body.seconds);
  if (isNaN(seconds)) return res.status(400).json({ error: 'invalid seconds' });
  // Restart current track from the desired position
  if (musicProc) {
    musicProc.stdout.removeAllListeners('data');
    musicProc.removeAllListeners('exit');
    musicProc.kill();
    musicProc = null;
  }
  if (state.currentTrack) {
    const thisStartTime = Date.now() - seconds * 1000;
    trackStartTime = thisStartTime;
    const thisProc = spawn('ffmpeg', [
      '-re', '-ss', String(seconds),
      '-i', state.currentTrack.path,
      '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
    ]);
    musicProc = thisProc;
    thisProc.stderr.on('data', d => {
      const m = d.toString();
      if (!m.includes('size=') && !m.includes('frame=')) console.log(`[SEEK-FF] ${m.trim()}`);
    });
    thisProc.stdout.on('data', chunk => {
      if (!masterProc || !masterProc.stdin || musicProc !== thisProc) return;
      if (!masterProc.stdin.write(chunk)) thisProc.stdout.pause();
    });
    thisProc.on('exit', (code) => {
      if (musicProc !== thisProc) return;
      musicProc = null;
      if (state.isPlaying) {
        state.currentMusicIdx = (state.currentMusicIdx + 1) % state.queue.length;
        playTrack();
      }
    });
  }
  res.json({ ok: true });
});

app.post('/api/delete-track', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'missing id' });
  const track = state.library.find(t => t.id === id);
  if (!track) return res.status(404).json({ error: 'not found' });
  try { fs.unlinkSync(track.path); } catch(e) { return res.status(500).json({ error: e.message }); }
  state.library = state.library.filter(t => t.id !== id);
  state.queue   = state.queue.filter(t => t.id !== id);
  const fn = track.path.split('/').pop();
  if (metaCache[fn]) { delete metaCache[fn]; saveMetaCache(); }
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
  const isNews = req.query.type === 'news';
  if (isNews && req.files) {
    // Move files to NEWS_DIR
    req.files.forEach(f => {
      const newsPath = path.join(NEWS_DIR, f.filename);
      fs.renameSync(f.path, newsPath);
    });
  }
  await scanLibrary();
  res.json({ ok: true, count: req.files ? req.files.length : 0 });
});

// ─── NEWS & PLAYLISTS ────────────────────────────────────────────────────────
app.post('/api/news/broadcast', (req, res) => {
  const { id } = req.body;
  const item = state.newsLibrary.find(n => n.id === id);
  if (!item) return res.status(404).json({ error: 'News item not found' });
  startOverlay(item.path);
  res.json({ ok: true });
});

app.post('/api/news/stop', (req, res) => {
  stopOverlay();
  res.json({ ok: true });
});

app.post('/api/playlists/create', (req, res) => {
  const { name, trackIds } = req.body;
  if (!name || !trackIds) return res.status(400).json({ error: 'name and trackIds required' });
  
  let playlists = [];
  try { if (fs.existsSync(path.join(DATA_DIR, 'playlists.json'))) playlists = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'playlists.json'))); } catch(e) {}
  
  const tracks = state.library.filter(t => trackIds.includes(t.id));
  const newPlaylist = {
    id: 'pl_' + Date.now(),
    name,
    tracks
  };
  
  playlists.push(newPlaylist);
  fs.writeFileSync(path.join(DATA_DIR, 'playlists.json'), JSON.stringify(playlists, null, 2));
  res.json({ ok: true, playlist: newPlaylist });
});

app.post('/api/news/record/start', (req, res) => {
  startNewsRecording();
  res.json({ ok: true });
});

app.post('/api/news/record/stop', (req, res) => {
  stopNewsRecording();
  res.json({ ok: true });
});

app.get('/api/news/schedule', (req, res) => res.json(state.schedule));

app.post('/api/news/schedule', (req, res) => {
  const { newsId, time, day } = req.body; // time as "HH:mm", day as "mon"|"tue"|...
  if (!newsId || !time || !day) return res.status(400).json({ error: 'newsId, time, and day required' });
  state.schedule.push({ id: 'sch_'+Date.now(), newsId, time, dayOfWeek: day });
  saveState();
  res.json({ ok: true });
});

app.post('/api/news/schedule/clear', (req, res) => {
  state.schedule = [];
  saveState();
  res.json({ ok: true });
});

// ─── TICKER: SCHEDULER ───────────────────────────────────────────────────────
setInterval(() => {
  const now = new Date();
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayStr = days[now.getDay()];
  const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  
  const due = state.schedule.filter(s => s.time === timeStr && s.dayOfWeek === dayStr);
  if (due.length > 0) {
    if (!state.overlayActive) {
      const item = state.newsLibrary.find(n => n.id === due[0].newsId);
      if (item) {
        console.log(`[SCHEDULER] Triggering scheduled news: ${item.title}`);
        startOverlay(item.path);
      }
    }
  }
}, 30000); 

// ─── INIT ────────────────────────────────────────────────────────────────────
(async () => {
  loadState();
  loadMetaCache();
  startMaster();
  startHeartbeat(); 
  
  // Ensure we have some initial volume state
  if (state._smoothVol === undefined) state._smoothVol = state.volume / 100;
  
  // Await the first scan so state.queue is populated before we try to play
  await scanLibrary();
  
  if (state.isPlaying) {
    console.log('[INIT] Resuming broadcast...');
    playTrack();
  } else {
    console.log('[INIT] Station is idle (waiting for play command).');
  }

  setInterval(scanLibrary, 60000); // reduced refresh rate to save CPU

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Bukuma Radio Engine v2 online on port ${PORT}`));
})();