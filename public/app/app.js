const DOMElements = {
        audio: document.getElementById('audioPlayer'),
        fileInput: document.getElementById('localFileInput'),
        title: document.getElementById('currTitle'),
        artist: document.getElementById('currArtist'),
        dialTitle: document.getElementById('dialTitle'),
        btnPlayPause: document.getElementById('btnPlayPause'),
        playIcon: document.getElementById('playIcon'),
        btnNext: document.getElementById('btnNext'),
        btnPrev: document.getElementById('btnPrev'),
        navRadio: document.getElementById('navRadio'),
        navLocal: document.getElementById('navLocal'),
        dial: document.getElementById('mainDial'),
        canvas: document.getElementById('waveformCanvas')
};
const ctx = DOMElements.canvas.getContext('2d');
function resizeCanvas() { DOMElements.canvas.width = window.innerWidth; DOMElements.canvas.height = 160; }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// FIX #1: Single declaration - no duplicates
    let audioCtx, analyser, dataArray;
let isVisualizerInit = false;
let appMode = 'radio';
let isPlaying = false;
let localPlaylist = [];
let localIndex = 0;
let ws = null;
let lastRadioTrack = { title: 'AWAITING SIGNAL...', artist: 'Radio Mode' };

// FIX #5: /ws path
function connectWS() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(proto + '://' + location.host + '/ws');
        ws.onopen = () => ws.send(JSON.stringify({ action: 'getStatus' }));
        ws.onmessage = (e) => {
                    try {
                                    const d = JSON.parse(e.data);
                                    if (d.type === 'status' || d.type === 'nowPlaying') {
                                                        const track = d.currentTrack || d.track;
                                                        lastRadioTrack = { title: track ? track.title : 'STATION IDLE', artist: track ? track.artist : 'Awaiting Signal' };
                                                        if (d.isPlaying === false && appMode === 'radio' && isPlaying) togglePlayback();
                                                        if (appMode === 'radio') updateUIFromState();
                                    }
                    } catch(err) {}
        };
        ws.onclose = () => setTimeout(connectWS, 3000);
}

function updateUIFromState() {
        if (appMode === 'radio') {
                    DOMElements.title.textContent = lastRadioTrack.title;
                    DOMElements.artist.textContent = lastRadioTrack.artist;
                    DOMElements.dialTitle.innerHTML = 'Agum Bukuma<br>Radio';
        } else {
                    if (localPlaylist.length === 0) {
                                    DOMElements.title.textContent = 'No Music Loaded';
                                    DOMElements.artist.textContent = 'Tap to select files';
                                    DOMElements.dialTitle.innerHTML = 'Local<br>Library';
                        } else {
                                    const title = localPlaylist[localIndex].name.replace(/\.[^/.]+$/, '');
                                    DOMElements.title.textContent = title;
                                    DOMElements.artist.textContent = 'Local Device';
                        DOMElements.dialTitle.innerHTML = title.substring(0, 15) + '...';
        }
        }
        if (isPlaying) {
                    // FIX #2: setAttribute for ion-icon
            DOMElements.playIcon.setAttribute('name', 'pause');
                    DOMElements.btnPlayPause.classList.add('playing');
                    DOMElements.dial.classList.add('alive');
        } else {
                    DOMElements.playIcon.setAttribute('name', 'play');
                                                DOMElements.btnPlayPause.classList.remove('playing');
                    DOMElements.dial.classList.remove('alive');
        }
}

// FIX #1: No re-declaration
function initVisualizer() {
                            if (isVisualizerInit) return;
        try {
                    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    analyser = audioCtx.createAnalyser();
                    analyser.fftSize = 128;
                    const source = audioCtx.createMediaElementSource(DOMElements.audio);
                    source.connect(analyser);
                    analyser.connect(audioCtx.destination);
                    dataArray = new Uint8Array(analyser.frequencyBinCount);
                    isVisualizerInit = true;
                    drawWaveform();
        } catch(e) { console.error('Visualizer:', e); }
}

// FIX #6: resume before click sound
function playMechanicalClick() {
        initVisualizer();
        if (!audioCtx) return;
        audioCtx.resume().then(() => {
                    if (audioCtx.state === 'suspended') return;
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.type = 'square';
                    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.04);
                    gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.04);
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.start(); osc.stop(audioCtx.currentTime + 0.05);
        });
}
document.querySelectorAll('button, .center-dial').forEach(btn => btn.addEventListener('pointerdown', playMechanicalClick));

function drawWaveform() {
        requestAnimationFrame(drawWaveform);
        ctx.clearRect(0, 0, DOMElements.canvas.width, DOMElements.canvas.height);
        if (!isPlaying || !isVisualizerInit) return;
        analyser.getByteFrequencyData(dataArray);
        const bw = (DOMElements.canvas.width / dataArray.length) * 2;
        let x = 0;
        for (let i = 0; i < dataArray.length; i++) {
                    const bh = (dataArray[i] / 255) * DOMElements.canvas.height * 0.8;
                    ctx.fillStyle = 'rgb(0,' + (180 + dataArray[i]/3) + ',255)';
                    ctx.fillRect(x, (DOMElements.canvas.height - bh) / 2, bw - 1, bh);
                    x += bw;
        }
}

function togglePlayback() {
        if (isPlaying) {
                    DOMElements.audio.pause();
                    if (appMode === 'radio') DOMElements.audio.src = '';
                    isPlaying = false;
        } else {
                    if (appMode === 'radio') {
                                    // FIX #7: /api/stream
                        DOMElements.audio.src = '/api/stream?' + Date.now();
                                    DOMElements.audio.play().catch(()=>{});
                    } else {
                                    if (localPlaylist.length === 0) { DOMElements.fileInput.click(); return; }
                                    if (!DOMElements.audio.src) loadLocalTrack();
                                    DOMElements.audio.play().catch(()=>{});
                    }
                    isPlaying = true;
        }
        updateUIFromState();
}

function loadLocalTrack() {
        if (!localPlaylist.length) return;
        DOMElements.audio.src = URL.createObjectURL(localPlaylist[localIndex]);
        updateUIFromState();
}

function skipLocal(dir) {
        if (appMode !== 'local' || !localPlaylist.length) return;
        localIndex = dir === 'next' ? (localIndex + 1) % localPlaylist.length : (localIndex - 1 + localPlaylist.length) % localPlaylist.length;
        loadLocalTrack();
        if (isPlaying) DOMElements.audio.play().catch(()=>{});
}

DOMElements.btnPlayPause.addEventListener('click', () => { initVisualizer(); setTimeout(togglePlayback, 50); });
DOMElements.btnNext.addEventListener('click', () => { initVisualizer(); if (appMode === 'local') setTimeout(() => skipLocal('next'), 50); });
DOMElements.btnPrev.addEventListener('click', () => { if (appMode === 'local') setTimeout(() => skipLocal('prev'), 50); });

DOMElements.navRadio.addEventListener('click', () => {
        if (appMode === 'radio') return;
        if (isPlaying) togglePlayback();
        appMode = 'radio';
        DOMElements.navRadio.classList.add('active');
        DOMElements.navLocal.classList.remove('active');
        updateUIFromState();
});
DOMElements.navLocal.addEventListener('click', () => {
        if (appMode === 'local') { DOMElements.fileInput.click(); return; }
        if (isPlaying) togglePlayback();
        appMode = 'local';
        DOMElements.navLocal.classList.add('active');
        DOMElements.navRadio.classList.remove('active');
        if (!localPlaylist.length) DOMElements.fileInput.click();
        updateUIFromState();
});
DOMElements.fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files).filter(f => f.type.startsWith('audio/'));
        if (files.length) { localPlaylist = files; localIndex = 0; loadLocalTrack(); if (!isPlaying) togglePlayback(); }
});
DOMElements.audio.addEventListener('ended', () => { if (appMode === 'local') skipLocal('next'); });
DOMElements.dial.addEventListener('click', () => {
        DOMElements.btnPlayPause.classList.add('active');
        setTimeout(() => { DOMElements.btnPlayPause.classList.remove('active'); togglePlayback(); }, 150);
});

connectWS();
updateUIFromState();
document.body.addEventListener('touchstart', function() {
        if (!window.audioEnabled) { DOMElements.audio.load(); window.audioEnabled = true; }
}, { once: true });
