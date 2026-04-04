const { exec, spawn } = require('child_process');
const fs = require('fs');

const ytdlpPath = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python312\\Scripts\\yt-dlp.exe';
const ffmpegPath = 'C:\\Users\\USER\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.WinGet.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe';

const query = 'https://www.youtube.com/watch?v=nhta-hYCXJQ';

console.log('Resolving URL...');
exec(`"${ytdlpPath}" --get-url --format bestaudio "${query}"`, (err, stdout, stderr) => {
    if (err) {
        console.error('YT-DLP ERROR:', err.message);
        return;
    }
    const url = stdout.trim().split('\n')[0];
    console.log('Resolved URL length:', url.length);
    console.log('Spawning FFmpeg...');

    // Trying with minimal arguments first
    const ff = spawn(ffmpegPath, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-i', url,
        '-f', 'null', '-' // Output to nothing, just testing input
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ff.stderr.on('data', (d) => {
        const msg = d.toString();
        // Print everything to see what ffmpeg says
        fs.appendFileSync('ff_debug.log', msg);
        if (msg.includes('Error') || msg.includes('fail') || msg.includes('Invalid')) {
            console.log('FF-ERROR-DETECTED:', msg);
        }
    });

    ff.on('close', (code) => {
        console.log('FFmpeg exited with code:', code);
        process.exit();
    });

    setTimeout(() => {
        console.log('FFmpeg still running after 5s, looks good.');
        ff.kill();
    }, 5000);
});
