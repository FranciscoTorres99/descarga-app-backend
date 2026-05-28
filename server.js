require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

const TMP_DIR = path.join(os.tmpdir(), 'descarga-app');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const BIN_DIR = path.join(os.tmpdir(), 'bins');
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');

const fileTokens = new Map();

function downloadYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP_PATH)) {
      console.log('[yt-dlp] ya existe en', YTDLP_PATH);
      return resolve();
    }
    console.log('[yt-dlp] descargando binario...');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
    const file = fs.createWriteStream(YTDLP_PATH);
    const request = (reqUrl) => {
      https.get(reqUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return request(res.headers.location);
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          fs.chmodSync(YTDLP_PATH, '755');
          console.log('[yt-dlp] binario listo en', YTDLP_PATH);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(YTDLP_PATH, () => {});
        reject(err);
      });
    };
    request(url);
  });
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') || origin.startsWith('file://')) return callback(null, true);
    const allowed = (process.env.ALLOWED_ORIGINS || 'https://descarga-app.up.railway.app').split(',').map(s => s.trim());
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
}));

app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'yt-dlp', timestamp: new Date().toISOString() });
});

app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: true, message: 'URL requerida' });
  exec(`"${YTDLP_PATH}" --dump-json --no-playlist --js-runtimes node "${url}"`, { timeout: 20000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: true, message: 'No se pudo obtener info' });
    try {
      const d = JSON.parse(stdout);
      res.json({ title: d.title, thumbnail: d.thumbnail, duration: d.duration, uploader: d.uploader || d.channel });
    } catch { res.status(500).json({ error: true, message: 'Error parseando' }); }
  });
});

function cleanFilename(title) {
  return title
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u2600-\u27BF]/gu, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100) || 'descarga';
}

app.post('/api/download', (req, res) => {
  const { url, downloadMode, videoQuality, audioFormat } = req.body;
  if (!url) return res.status(400).json({ error: true, message: 'URL requerida' });
  try { new URL(url); } catch { return res.status(400).json({ error: true, message: 'URL invalida' }); }

  const isAudio = downloadMode === 'audio';
  const quality = (videoQuality === 'max' || videoQuality === '9000') ? '9000' : (videoQuality || '1080');
  const uid = crypto.randomBytes(8).toString('hex');

  exec(`"${YTDLP_PATH}" --dump-json --no-playlist --js-runtimes node "${url}"`, { timeout: 20000 }, (infoErr, infoStdout) => {
    let videoTitle = 'descarga';
    if (!infoErr && infoStdout) {
      try { videoTitle = JSON.parse(infoStdout).title || 'descarga'; } catch {}
    }
    const safeTitle = cleanFilename(videoTitle);
    console.log('[titulo]', safeTitle);

    let outputTemplate, ytdlpCmd;
    if (isAudio) {
      outputTemplate = path.join(TMP_DIR, `${uid}.%(ext)s`);
      ytdlpCmd = `"${YTDLP_PATH}" --no-playlist --js-runtimes node -x --audio-format ${audioFormat || 'mp3'} --audio-quality 0 -o "${outputTemplate}" "${url}"`;
    } else {
      outputTemplate = path.join(TMP_DIR, `${uid}.mp4`);
      let fmt = quality === '9000'
        ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
        : `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
      ytdlpCmd = `"${YTDLP_PATH}" --no-playlist --js-runtimes node -f "${fmt}" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;
    }

    console.log('[cmd]', ytdlpCmd);

    exec(ytdlpCmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[error]', stderr);
        return res.status(500).json({ error: true, message: 'yt-dlp fallo: ' + (stderr || err.message).substring(0, 200) });
      }

      const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(uid));
      if (!files.length) return res.status(500).json({ error: true, message: 'Archivo no encontrado' });

      const filePath = path.join(TMP_DIR, files[0]);
      const ext = path.extname(filePath).slice(1);
      const filename = `${safeTitle}.${ext}`;

      const token = crypto.randomBytes(16).toString('hex');
      fileTokens.set(token, { filePath, filename, ext, expires: Date.now() + 5 * 60 * 1000 });

      console.log('[token creado]', filename);
      res.json({ token, filename });
    });
  });
});

app.get('/api/file/:token', (req, res) => {
  const entry = fileTokens.get(req.params.token);
  if (!entry) return res.status(404).json({ error: true, message: 'Token no encontrado o expirado' });
  if (!fs.existsSync(entry.filePath)) return res.status(404).json({ error: true, message: 'Archivo no encontrado' });

  const mimeTypes = {
    mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska',
    mp3:'audio/mpeg', ogg:'audio/ogg', opus:'audio/opus', wav:'audio/wav', m4a:'audio/mp4'
  };
  const mime = mimeTypes[entry.ext] || 'application/octet-stream';
  const asciiName = entry.filename.replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(entry.filename).replace(/'/g, '%27');

  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', fs.statSync(entry.filePath).size);

  const stream = fs.createReadStream(entry.filePath);
  stream.pipe(res);
  stream.on('close', () => {
    fileTokens.delete(req.params.token);
    fs.unlink(entry.filePath, () => {});
    console.log('[OK]', entry.filename);
  });
});

app.get('/api/platforms', (req, res) => {
  res.json({ platforms: [
    { name:'YouTube', icon:'brand-youtube', color:'#FF0000', supports:['video','audio'] },
    { name:'Instagram', icon:'brand-instagram', color:'#E1306C', supports:['video','foto'] },
    { name:'TikTok', icon:'brand-tiktok', color:'#69C9D0', supports:['video','audio'] },
    { name:'Twitter / X', icon:'brand-x', color:'#fff', supports:['video','gif'] },
    { name:'Reddit', icon:'brand-reddit', color:'#FF4500', supports:['video'] },
    { name:'SoundCloud', icon:'brand-soundcloud', color:'#FF5500', supports:['audio'] },
    { name:'Vimeo', icon:'brand-vimeo', color:'#1AB7EA', supports:['video'] },
    { name:'Twitch', icon:'brand-twitch', color:'#9146FF', supports:['video'] },
    { name:'Facebook', icon:'brand-facebook', color:'#1877F2', supports:['video'] },
    { name:'Dailymotion', icon:'video', color:'#0066DC', supports:['video'] },
    { name:'Pinterest', icon:'brand-pinterest', color:'#E60023', supports:['video'] },
    { name:'Bilibili', icon:'brand-bilibili', color:'#00A1D6', supports:['video'] },
    { name:'+ 1000 sitios', icon:'world', color:'#888', supports:['varios'] },
  ]});
});

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of fileTokens.entries()) {
    if (now > entry.expires) { fileTokens.delete(token); fs.unlink(entry.filePath, ()=>{}); }
  }
  fs.readdirSync(TMP_DIR).forEach(f => {
    const fp = path.join(TMP_DIR, f);
    try { if (now - fs.statSync(fp).mtimeMs > 600000) fs.unlinkSync(fp); } catch {}
  });
}, 60000);

app.use(express.static(path.join(__dirname, 'frontend')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

app.use((req, res) => res.status(404).json({ error: true, message: 'Ruta no encontrada' }));

downloadYtDlp().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Descarga.app Backend en http://localhost:${PORT}`);
    console.log(`📁 Temp: ${TMP_DIR}\n`);
  });
}).catch(err => {
  console.error('Error descargando yt-dlp:', err);
  process.exit(1);
});