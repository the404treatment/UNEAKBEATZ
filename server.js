// UNEAKBEATZ studio server. No dependencies: run with `node server.js`.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SONGS = path.join(ROOT, 'songs');
const API = 'https://api.elevenlabs.io';
const MODEL = 'music_v2_5';

// Load .env (KEY=value lines) without a dependency.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.ELEVENLABS_API_KEY || '';
fs.mkdirSync(SONGS, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type });
  res.end(data);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

// Turn an ElevenLabs error body into one readable sentence.
function describeError(status, text) {
  let msg = text;
  try {
    const d = JSON.parse(text).detail;
    if (Array.isArray(d)) msg = d.map((e) => `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join('; ');
    else if (d && typeof d === 'object') msg = d.message || d.status || JSON.stringify(d);
    else if (d) msg = String(d);
  } catch {}
  if (status === 401) msg = `API key rejected. ${msg}`;
  return Object.assign(new Error(msg.slice(0, 600) || `ElevenLabs returned ${status}`), { status: 502 });
}

async function eleven(pathname, body) {
  const r = await fetch(API + pathname, {
    method: 'POST',
    // Without a local key a placeholder is sent, for setups where a proxy injects the real one.
    headers: { 'xi-api-key': KEY || 'injected-by-proxy', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw describeError(r.status, await r.text());
  return r;
}

const clampMs = (sec) => Math.round(Math.min(600, Math.max(3, Number(sec) || 60)) * 1000);
const safeId = (id) => (/^[a-f0-9]{12}$/.test(id) ? id : null);

function listSongs() {
  return fs.readdirSync(SONGS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(SONGS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const routes = {
  'GET /api/status': async () => ({ keyConfigured: Boolean(KEY), model: MODEL }),

  // Free: turns a prompt into an editable plan (sections, lyrics, styles).
  'POST /api/plan': async (req) => {
    const { prompt, lengthSec, instrumental } = await readJson(req);
    if (!prompt || !String(prompt).trim()) throw Object.assign(new Error('Describe the song first.'), { status: 400 });
    const full = instrumental ? `${prompt}\n\nInstrumental only, no vocals, no lyrics.` : String(prompt);
    const r = await eleven('/v1/music/plan', { prompt: full, music_length_ms: clampMs(lengthSec), model_id: MODEL });
    return { plan: await r.json() };
  },

  // Costs credits: renders audio from either a prompt or an edited plan.
  'POST /api/compose': async (req) => {
    const { prompt, plan, lengthSec, instrumental, title } = await readJson(req);
    const body = { model_id: MODEL };
    if (plan && Array.isArray(plan.chunks) && plan.chunks.length) {
      body.composition_plan = plan;
    } else if (prompt && String(prompt).trim()) {
      body.prompt = String(prompt);
      body.music_length_ms = clampMs(lengthSec);
      if (instrumental) body.force_instrumental = true;
    } else {
      throw Object.assign(new Error('Describe the song first.'), { status: 400 });
    }
    const r = await eleven('/v1/music?output_format=mp3_48000_192', body);
    const audio = Buffer.from(await r.arrayBuffer());
    const id = crypto.randomBytes(6).toString('hex');
    const song = {
      id,
      title: String(title || prompt || 'Untitled').trim().slice(0, 80) || 'Untitled',
      prompt: String(prompt || ''),
      plan: body.composition_plan || null,
      instrumental: Boolean(instrumental),
      createdAt: new Date().toISOString(),
      file: `/songs/${id}.mp3`,
    };
    fs.writeFileSync(path.join(SONGS, `${id}.mp3`), audio);
    fs.writeFileSync(path.join(SONGS, `${id}.json`), JSON.stringify(song, null, 2));
    return { song };
  },

  'GET /api/songs': async () => ({ songs: listSongs() }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req));

    const del = req.method === 'DELETE' && url.pathname.match(/^\/api\/songs\/([^/]+)$/);
    if (del) {
      const id = safeId(del[1]);
      if (!id) return send(res, 400, { error: 'Bad song id' });
      for (const ext of ['.mp3', '.json']) fs.rmSync(path.join(SONGS, id + ext), { force: true });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      const isSong = url.pathname.startsWith('/songs/');
      const base = isSong ? SONGS : PUBLIC;
      const rel = isSong ? url.pathname.slice(7) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(base, path.normalize(rel));
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(res, 404, { error: 'Not found' });
      }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      const size = fs.statSync(file).size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) { // lets the audio player seek
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 500, { error: err.message || 'Something went wrong' });
  }
});

server.listen(PORT, () => {
  console.log(`UNEAKBEATZ studio running at http://localhost:${PORT}`);
  if (!KEY) console.log('No ELEVENLABS_API_KEY set. Copy .env.example to .env and add your key.');
});
