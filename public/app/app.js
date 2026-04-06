const DOMElements = {
    audio: document.getElementById('audioPlayer'),
    fileInput: document.getElementById('localFileInput'),
    
    // UI text
    title: document.getElementById('currTitle'),
    artist: document.getElementById('currArtist'),
    dialTitle: document.getElementById('dialTitle'),
    
    // Transport
    btnPlayPause: document.getElementById('btnPlayPause'),
    playIcon: document.getElementById('playIcon'),
    btnNext: document.getElementById('btnNext'),
    btnPrev: document.getElementById('btnPrev'),
    
    // Nav
    navRadio: document.getElementById('navRadio'),
    navLocal: document.getElementById('navLocal'),
    
    // Animations
    dial: document.getElementById('mainDial'),
    waveLeft: document.getElementById('waveLeft'),
    waveRight: document.getElementById('waveRight')
};

// State
let appMode = 'radio'; // 'radio' or 'local'
let isPlaying = false;
let localPlaylist = [];
let localIndex = 0;
let ws = null;
let lastRadioTrack = { title: 'AWAITING SIGNAL...', artist: 'Radio Mode' };

// --- WEBSOCKET FOR RADIO MODE ---
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    
    ws.onopen = () => ws.send(JSON.stringify({ action: 'getStatus' }));
    
    ws.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.type === 'status' || d.type === 'nowPlaying') {
                const track = d.currentTrack || d.track;
                lastRadioTrack = {
                    title: track ? track.title : 'STATION IDLE',
                    artist: track ? track.artist : 'Awaiting Signal'
                };
                
                // If the station stops broadcasting, kill the audio engine
                if (d.isPlaying === false && appMode === 'radio' && isPlaying) {
                    togglePlayback();
                }

                if (appMode === 'radio') updateUIFromState();
            }
        } catch(err) {}
    };
    
    ws.onclose = () => setTimeout(connectWS, 3000);
}

// --- UI UPDATERS ---
function updateUIFromState() {
    if (appMode === 'radio') {
        DOMElements.title.textContent = lastRadioTrack.title;
        DOMElements.artist.textContent = lastRadioTrack.artist;
        DOMElements.dialTitle.innerHTML = "Agum Bukuma<br>Radio";
    } else {
        if (localPlaylist.length === 0) {
            DOMElements.title.textContent = "No Music Loaded";
            DOMElements.artist.textContent = "Tap here to select Local Files";
            DOMElements.dialTitle.innerHTML = "Local<br>Library";
        } else {
            const file = localPlaylist[localIndex];
            // Basic metadata parsing for local files.
            let title = file.name.replace(/\.[^/.]+$/, "");
            DOMElements.title.textContent = title;
            DOMElements.artist.textContent = "Local Device";
            DOMElements.dialTitle.innerHTML = title.substring(0, 15) + "...";
        }
    }

    if (isPlaying) {
        DOMElements.playIcon.name = 'pause';
        DOMElements.btnPlayPause.classList.add('playing');
        DOMElements.dial.classList.add('alive');
        DOMElements.waveLeft.classList.add('active');
        DOMElements.waveRight.classList.add('active');
    } else {
        DOMElements.playIcon.name = 'play';
        DOMElements.btnPlayPause.classList.remove('playing');
        DOMElements.dial.classList.remove('alive');
        DOMElements.waveLeft.classList.remove('active');
        DOMElements.waveRight.classList.remove('active');
    }
}

// --- AUDIO LOGIC ---
function togglePlayback() {
    if (isPlaying) {
        DOMElements.audio.pause();
        if (appMode === 'radio') DOMElements.audio.src = ''; // Kill buffer to prevent dead air
        isPlaying = false;
    } else {
        if (appMode === 'radio') {
            DOMElements.audio.src = '/stream?' + Date.now();
            DOMElements.audio.play().catch(()=>{});
        } else {
            if (localPlaylist.length === 0) {
                DOMElements.fileInput.click();
                return;
            }
            if (!DOMElements.audio.src) loadLocalTrack();
            DOMElements.audio.play().catch(()=>{});
        }
        isPlaying = true;
    }
    updateUIFromState();
}

function loadLocalTrack() {
    if (localPlaylist.length === 0) return;
    const file = localPlaylist[localIndex];
    const url = URL.createObjectURL(file);
    DOMElements.audio.src = url;
    updateUIFromState();
}

function skipLocal(direction) {
    if (appMode !== 'local' || localPlaylist.length === 0) return;
    if (direction === 'next') {
        localIndex = (localIndex + 1) % localPlaylist.length;
    } else {
        localIndex = (localIndex - 1 + localPlaylist.length) % localPlaylist.length;
    }
    loadLocalTrack();
    if (isPlaying) DOMElements.audio.play().catch(()=>{});
}

// --- EVENT LISTENERS ---

DOMElements.btnPlayPause.addEventListener('click', () => {
    // Adding a tiny delay to ensure the depression CSS animation is felt
    setTimeout(togglePlayback, 50); 
});

DOMElements.btnNext.addEventListener('click', () => {
    if (appMode === 'local') setTimeout(() => skipLocal('next'), 50);
});

DOMElements.btnPrev.addEventListener('click', () => {
    if (appMode === 'local') setTimeout(() => skipLocal('prev'), 50);
});

// Mode Switching Navigation
DOMElements.navRadio.addEventListener('click', () => {
    if (appMode === 'radio') return;
    if (isPlaying) togglePlayback(); // Pause current local playback
    appMode = 'radio';
    DOMElements.navRadio.classList.add('active');
    DOMElements.navLocal.classList.remove('active');
    updateUIFromState();
});

DOMElements.navLocal.addEventListener('click', () => {
    if (appMode === 'local') {
        // If they click local while already on local, open file picker to add more
        DOMElements.fileInput.click();
        return;
    }
    if (isPlaying) togglePlayback(); // Pause current radio playback
    appMode = 'local';
    DOMElements.navLocal.classList.add('active');
    DOMElements.navRadio.classList.remove('active');
    
    if (localPlaylist.length === 0) DOMElements.fileInput.click();
    updateUIFromState();
});

// File Input Handler
DOMElements.fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files).filter(f => f.type.startsWith('audio/'));
    if (files.length > 0) {
        localPlaylist = files;
        localIndex = 0;
        loadLocalTrack();
        if (!isPlaying) togglePlayback();
    }
});

// Auto-play next local track when current finishes
DOMElements.audio.addEventListener('ended', () => {
    if (appMode === 'local') skipLocal('next');
});

// Dial click also acts as a play/pause toggle (skeuomorphic fun)
DOMElements.dial.addEventListener('click', () => {
    DOMElements.btnPlayPause.classList.add('active'); // force visual depression
    setTimeout(() => {
        DOMElements.btnPlayPause.classList.remove('active');
        togglePlayback();
    }, 150);
});

// --- BOOT ---
connectWS();
updateUIFromState();

// Fixes for PWA audio context requirement on iOS: 
// The initial tap on the screen enables the audio subsystem.
document.body.addEventListener('touchstart', function() {
    if (!window.audioEnabled) {
        DOMElements.audio.load();
        window.audioEnabled = true;
    }
}, { once: true });
