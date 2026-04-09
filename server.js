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
const dataDir       = process.env.DATA_DIR || path.join(__dirname, 'data');
const downloadsDir  = path.join(dataDir, 'downloads');
const queueFile     = path.join(dataDir, 'queue.json');
const stateFile     = path.join(dataDir, 'state.json');
const playlistsFile = path.join(dataDir, 'playlists.json');
const newsFile      = path.join(dataDir, 'news.json');
if (!fs.existsSync(dataDir))      fs.mkdirSync(dataDir,      { recursive: true });
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// ── State ─────────────────────────────────────────────────────────────────────
let queue        = [];
let playlists    = [];
let news         = [];
let libraryIndex = 0;
let currentTrack = null;
let isPlaying    = false;
let volume       = 80;
let currentProcess  = null;
let playNextTimeout = null;
// A single flag: are we in the middle of starting a track right now?
let isStartingTrack = false;
let autoJingles = { start: false };
let autoJingleTimer   = null;
let activeJingleProcess = null;

// Scout: serialised, one download at a time
let isDownloading = false;
let downloadQueue = [];

const clients       = new Set();
const streamClients = new Set();

// ── Seed tracks ───────────────────────────────────────────────────────────────
function seedQueue() {
            return [
                    { title: 'Ozigizaga',              artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Ozigizaga Ijaw highlife' },
                    { title: 'Earth Song',             artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Earth Song Ijaw' },
                    { title: 'Paddle of the Niger Delta', artist: 'Barrister Smooth', youtubeQuery: 'Chief Barrister Smooth Ijaw highlife Niger Delta' },
                    { title: 'Tompolo',                artist: 'Alfred J King',    youtubeQuery: 'Alfred J King Tompolo Ijaw' },
                    { title: 'Halo Halo',              artist: 'Wizard Chan',      youtubeQuery: 'Wizard Chan Halo Halo Ijaw' },
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
                                                volume       = Number(d.volume || 80); if (isNaN(volume)) volume = 80;
                                                libraryIndex = d.libraryIndex || 0;
                                                isPlaying    = d.isPlaying || false;
                                                autoJingles  = d.autoJingles || { start: false };
                            }
                            if (fs.existsSync(playlistsFile)) playlists = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
                            if (fs.existsSync(newsFile)) {
                                                news = JSON.parse(fs.readFileSync(newsFile, 'utf8'));
                            } else {
                                                news = [{ id: 'n1', date: new Date().toISOString(), status: 'news',
                                                                         title: 'BUKUMA RADIO GOES GLOBAL', summary: 'Agum Bukuma Radio now streams to the world.', content: 'We are live.' }];
                                                saveNews();
                            }
                            // Self-heal stuck entries
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
                            fs.writeFileSync(stateFile, JSON.stringify({ volume, autoJingles, isPlaying, libraryIndex }, null, 2));
                            fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
            } catch(e) {}
}
function savePlaylists() { try { fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2)); } catch(e) {} }
function saveNews()      { try { fs.writeFileSync(newsFile, JSON.stringify(news, null, 2)); } catch(e) {} }

const upload = multer({ dest: path.join(__dirname, 'public/uploads') });

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(msg) {
            const data = JSON.stringify(msg);
            clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function getStatus() {
            return {
                            isPlaying, volume,
                            queue: queue.map((t, i) => ({ ...t, isNowPlaying: i === libraryIndex && isPlaying })),
                            libraryIndex, currentTrack, autoJingles, timestamp: Date.now()
            };
}

// ── Scout: background downloader, completely isolated from playback ───────────
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
            const cleanTitle = (live.artist + ' - ' + live.title).replace(/[^a-z0-9 _-]/gi, '_').replace(/\s+/g, '_');
            const localPath  = path.join(downloadsDir, `${cleanTitle}.mp3`);
            if (fs.existsSync(localPath)) {
                            live.status = 'ready'; live.localPath = localPath;
                            saveState(); broadcast(getStatus());
                            isDownloading = false; processDownloadQueue(); return;
            }
            const ea  = 'youtube:player_client=default,android_sdkless';
            const cmd = `"${YTDLP_PATH}" -x --audio-format mp3 --no-playlist --ignore-errors --geo-bypass --no-check-certificates --extractor-args "${ea}" -o "${localPath}" "ytsearch1:${live.youtubeQuery || (live.artist + ' ' + live.title)}"`;
            console.log(`[SCOUT] Downloading: ${live.title}`);
            exec(cmd, { timeout: 120000 }, (err) => {
                            live.status = (!err && fs.existsSync(localPath)) ? 'ready' : 'error';
                            if (live.status === 'ready') live.localPath = localPath;
                            console.log(`[SCOUT] ${live.status === 'ready' ? 'Ready' : 'Failed'}: ${live.title}`);
                            saveState(); broadcast(getStatus());
                            isDownloading = false; processDownloadQueue();
            });
}

// Background scout: pre-fetch next 3 tracks ahead of pointer every 10s
// Does NOT touch playback in any way
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

// ── The Player: plays one track fully, then advances. That's it. ──────────────
//
// RULES:
//  - playTrack() is the ONLY thing that spawns FFmpeg
//  - Nothing except the FFmpeg 'close' event and explicit user skip/stop
//    may call playTrack() again
//  - No watchdog. No timeout recovery loops. No bouncing.
//  - If a track isn't downloaded yet, wait for scout — do not skip forward

function playTrack() {
            // Guard: never start two at once
    if (isStartingTrack) return;

    if (!isPlaying) return;
            if (queue.length === 0) return;
            if (libraryIndex >= queue.length) libraryIndex = 0;

    const track = queue[libraryIndex];

    // If track isn't on disk yet, wait 3s and check again — do NOT advance
    if (track.status !== 'ready' || !track.localPath || !fs.existsSync(track.localPath)) {
                    console.log(`[PLAYER] Waiting for download: ${track.title} (${track.status})`);
                    if (track.status === 'pending') enqueueDownload(track);
                    if (track.status === 'error') {
                                        // Only error tracks get skipped — move pointer and try next
                        console.log(`[PLAYER] Track errored, advancing: ${track.title}`);
                                        libraryIndex = (libraryIndex + 1) % queue.length;
                                        saveState();
                                        playNextTimeout = setTimeout(playTrack, 1000);
                                        return;
                    }
                    // pending or downloading — just wait, don't skip
                playNextTimeout = setTimeout(playTrack, 3000);
                    return;
    }

    isStartingTrack = true;
            currentTrack = { ...track };
            broadcast({ type: 'nowPlaying', track: currentTrack });
            broadcast(getStatus());
            console.log(`[PLAYER] Playing: ${currentTrack.title}`);

    // Clean simple pipeline: file → volume → MP3 stream
    const args = [
                    '-hide_banner', '-loglevel', 'error',
                    '-i', currentTrack.localPath,
                    '-af', `volume=${volume / 100}`,
                    '-f', 'mp3', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-'
                ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            currentProcess = proc;
            isStartingTrack = false;
            let bytesOut = 0;

    proc.stdout.on('data', chunk => {
                    bytesOut += chunk.length;
                    streamClients.forEach(client => {
                                        try {
                                                                if ((client.writableLength || 0) > 1000000) { client.end(); streamClients.delete(client); return; }
                                                                client.write(chunk);
                                        } catch(e) { streamClients.delete(client); }
                    });
    });

    proc.on('close', (code) => {
                    // Only act if this is still the current process (not killed by stop/skip)
                    if (currentProcess !== proc) return;
                    currentProcess = null;
                    console.log(`[PLAYER] Finished: ${currentTrack.title} (${bytesOut} bytes, code ${code})`);
                    if (!isPlaying) return; // user stopped — don't advance
                    // Natural end of track: advance and play next
                    libraryIndex = (libraryIndex + 1) % queue.length;
                    saveState();
                    broadcast(getStatus());
                    playNextTimeout = setTimeout(playTrack, 500);
    });

    proc.on('error', err => {
                    if (currentProcess !== proc) return;
                    currentProcess = null;
                    isStartingTrack = false;
                    console.error('[PLAYER] FFmpeg error:', err.message);
                    if (!isPlaying) return;
                    libraryIndex = (libraryIndex + 1) % queue.length;
                    saveState();
                    playNextTimeout = setTimeout(playTrack, 2000);
    });
}

function startPlayback() {
            if (isPlaying && currentProcess) return; // already going
    isPlaying = true;
            if (queue.length === 0) { queue = seedQueue(); saveState(); }
            if (libraryIndex >= queue.length) libraryIndex = 0;
            if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
            broadcast(getStatus());
            playTrack();
}

function stopPlayback() {
            isPlaying = false;
            if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
            if (currentProcess) {
                            const p = currentProcess; currentProcess = null;
                            p.removeAllListeners();
                            try { p.kill('SIGKILL'); } catch(e) {}
            }
            saveState();
            broadcast(getStatus());
}

function skipTrack() {
            if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
            const old = currentProcess; currentProcess = null;
            if (old) { old.removeAllListeners(); try { old.kill('SIGKILL'); } catch(e) {} }
            isStartingTrack = false;
            libraryIndex = (libraryIndex + 1) % (queue.length || 1);
            saveState(); broadcast(getStatus());
            if (isPlaying) playTrack();
}

// Volume change: update value, save, tell clients — do NOT restart the track
// The current song keeps playing at its volume. Next track picks up the new level.
function setVolume(val) {
            volume = Math.min(100, Math.max(0, parseInt(val) || 80));
            saveState();
            broadcast({ type: 'volume', value: volume });
}

// ── Jingles ───────────────────────────────────────────────────────────────────
function startAutoJingleLoop() {
            if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
            if (!autoJingles.start) return;
            const next = Math.floor(Math.random() * 120000) + 120000;
            autoJingleTimer = setTimeout(() => { dropJingle(); startAutoJingleLoop(); }, next);
}

function dropJingle(jingleFile = 'ident.mp3') {
            if (!isPlaying || !currentProcess) return;
            if (activeJingleProcess) return;
            let p = path.join(__dirname, 'public/app', jingleFile);
            if (!fs.existsSync(p)) p = path.join(dataDir, 'jingles', jingleFile);
            if (!fs.existsSync(p)) return;
            const args = ['-hide_banner', '-loglevel', 'error', '-i', p, '-f', 'mp3', '-b:a', '128k', '-'];
            activeJingleProcess = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'ignore'] });
            activeJingleProcess.stdout.on('data', chunk => {
                            streamClients.forEach(c => { try { c.write(chunk); } catch(e) {} });
            });
            activeJingleProcess.on('close', () => { activeJingleProcess = null; });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
            clients.add(ws);
            ws.send(JSON.stringify(getStatus()));
            broadcast({ type: 'listeners', count: clients.size });

           ws.on('message', (data, isBinary) => {
                           if (isBinary) return;
                           try {
                                               const msg = JSON.parse(data.toString());
                                               switch (msg.action) {
                                                       case 'adminLogin':
                                                                                   if (msg.password === ADMIN_PASSWORD) { ws.isAdmin = true; ws.send(JSON.stringify({ type: 'auth', success: true })); }
                                                                                   break;
                                                       case 'getStatus':
                                                                                   ws.send(JSON.stringify(getStatus())); break;
                                                       case 'play':
                                                                                   startPlayback(); break;
                                                       case 'pause':
                                                                                   stopPlayback(); break;
                                                       case 'skip':
                                                                                   skipTrack(); break;
                                                       case 'volume':
                                                                                   setVolume(msg.value); break;
                                                       case 'toggleAutoJingles':
                                                                                   autoJingles.start = !autoJingles.start; saveState();
                                                                                   if (autoJingles.start) startAutoJingleLoop();
                                                                                   else if (autoJingleTimer) { clearTimeout(autoJingleTimer); autoJingleTimer = null; }
                                                                                   broadcast(getStatus()); break;
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

           ws.on('close', () => { clients.delete(ws); broadcast({ type: 'listeners', count: clients.size }); });
});

// ── HTTP Routes ───────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
            if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
            next();
};

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

app.post('/api/play',       requireAuth, (req, res) => { startPlayback(); res.json({ success: true }); });
app.post('/api/pause',      requireAuth, (req, res) => { stopPlayback();  res.json({ success: true }); });
app.post('/api/skip',       requireAuth, (req, res) => { skipTrack();     res.json({ success: true }); });
app.post('/api/queue/skip', requireAuth, (req, res) => { skipTrack();     res.json({ success: true }); });

app.post('/api/volume', requireAuth, (req, res) => {
            setVolume(req.body.value);
            res.json({ success: true, volume });
});

app.post('/api/admin/onair', requireAuth, (req, res) => {
            if (req.body.state) startPlayback(); else stopPlayback();
            res.json({ success: true, isPlaying });
});

app.post('/api/admin/panic', requireAuth, (req, res) => {
            stopPlayback();
            queue = seedQueue(); libraryIndex = 0;
            saveState(); broadcast(getStatus());
            res.json({ success: true });
});

app.post('/api/queue', requireAuth, (req, res) => {
            const entry = { id: Math.random().toString(36).slice(2), status: 'pending',
                                   title: req.body.title || 'Unknown', artist: req.body.artist || 'Unknown',
                                   youtubeQuery: req.body.youtubeQuery || req.body.title };
            queue.push(entry); saveState(); broadcast(getStatus());
            enqueueDownload(entry);
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
            queue.push(entry); saveState(); broadcast(getStatus());
            enqueueDownload(entry);
            if (!isPlaying) startPlayback();
            res.json({ success: true, id: entry.id });
});

app.delete('/api/queue/:id', requireAuth, (req, res) => {
            const id = req.params.id;
            const wasCurrentlyPlaying = currentTrack && currentTrack.id === id;
            queue = queue.filter(t => t.id !== id);
            if (libraryIndex >= queue.length) libraryIndex = Math.max(0, queue.length - 1);
            saveState();
            if (wasCurrentlyPlaying && isPlaying) skipTrack();
            else broadcast(getStatus());
            res.json({ success: true });
});

                                                                      app.post('/api/queue/:id/play-now', requireAuth, (req, res) => {
                                                                                  const idx = queue.findIndex(t => t.id === req.params.id);
                                                                                  if (idx === -1) return res.status(404).json({ success: false });
                                                                                  if (queue[idx].status !== 'ready') return res.status(400).json({ success: false, error: 'Not downloaded yet' });
                                                                                  libraryIndex = idx;
                                                                                  const old = currentProcess; currentProcess = null; isStartingTrack = false;
                                                                                  if (old) { old.removeAllListeners(); try { old.kill('SIGKILL'); } catch(e) {} }
                                                                                  if (playNextTimeout) { clearTimeout(playNextTimeout); playNextTimeout = null; }
                                                                                  isPlaying = true;
                                                                                  saveState(); playTrack();
                                                                                  res.json({ success: true });
                                                                      });

app.post('/api/upload', requireAuth, upload.single('audio'), async (req, res) => {
            if (!req.file) return res.status(400).json({ error: 'No file' });
            const ext     = path.extname(req.file.originalname);
            const newPath = path.join(downloadsDir, req.file.filename + ext);
            fs.renameSync(req.file.path, newPath);
            let title  = req.body.title  || req.file.originalname.replace(ext, '');
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
            res.json({ success: true, track });
});

app.get('/api/youtube/search', (req, res) => {
            const q = req.query.q?.replace(/['"\\]/g, '');
            if (!q) return res.json({ results: [] });
            const ea  = 'youtube:player_client=default,android_sdkless';
            const cmd = `"${YTDLP_PATH}" --quiet --no-warnings --flat-playlist --print "%(id)s|||%(title)s|||%(duration_string)s" --extractor-args "${ea}" "ytsearch5:${q}"`;
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

app.get('/api/herald',        (req, res) => res.json({ news }));
app.post('/api/herald',       requireAuth, (req, res) => {
            const item = { id: Date.now().toString(), date: new Date().toISOString(), ...req.body };
            news.unshift(item); saveNews(); res.json({ success: true, item });
});
app.delete('/api/herald/:id', requireAuth, (req, res) => {
            news = news.filter(n => n.id !== req.params.id); saveNews(); res.json({ success: true });
});

app.get('/api/vault', (req, res) => {
            const pl = playlists[0] || { tracks: [] };
            res.json({ tracks: pl.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, thumbnail: t.thumbnail, status: 'ready' })) });
});

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

app.get('/api/playlists',  (req, res) => res.json({ playlists }));
app.post('/api/playlists', requireAuth, (req, res) => {
            const pl = { id: Date.now().toString(), name: req.body.name, tracks: [...queue] };
            playlists.push(pl); savePlaylists(); res.json({ success: true, playlists });
});
app.post('/api/playlists/:id/load', requireAuth, (req, res) => {
            const pl = playlists.find(p => p.id === req.params.id);
            if (!pl) return res.status(404).json({ success: false });
            queue = pl.tracks.map(t => ({ ...t, id: Math.random().toString(36).slice(2) }));
            libraryIndex = 0; saveState(); broadcast(getStatus());
            if (!isPlaying) startPlayback();
            res.json({ success: true });
});

app.post('/api/jingle/:id', requireAuth, (req, res) => {
            const map = { '01': 'ident.mp3', '02': 'jingle02.mp3', '03': 'jingle03.mp3' };
            dropJingle(map[req.params.id] || `${req.params.id}.mp3`);
            res.json({ success: true });
});

app.get('/health', (req, res) => res.json({
            status: 'ok', uptime: process.uptime(), isPlaying,
            currentTrack: currentTrack?.title || null,
            queueLength: queue.length, streamClients: streamClients.size,
            downloadQueueLength: downloadQueue.length, isDownloading
}));

// ── Boot ──────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
            console.log(`[BUKUMA] Internet Radio — port ${PORT}`);
            loadState();
            startScout();
            if (autoJingles.start) startAutoJingleLoop();
            setTimeout(() => {
                            if (isPlaying && queue.length > 0) startPlayback();
            }, 5000);
});
