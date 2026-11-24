// UNEAKBEATZ studio server. No dependencies: run with `node server.js`.
// Music is made by ACE-Step 1.5, a free open-source model running on this computer.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SONGS = path.join(ROOT, 'songs');

// Load .env (KEY=value lines) without a dependency.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const ENGINE = (process.env.ACESTEP_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
const ENGINE_KEY = process.env.ACESTEP_API_KEY || '';
fs.mkdirSync(SONGS, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json',
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw fail(413, 'Request too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'Bad JSON'); }
}

// --- ACE-Step engine client ---
async function engine(pathname, body) {
  let r;
  try {
    r = await fetch(ENGINE + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(ENGINE_KEY && { Authorization: `Bearer ${ENGINE_KEY}` }) },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw fail(503, `The music engine is not running at ${ENGINE}. Start ACE-Step (see README) and try again.`);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok || (json && json.code && json.code !== 200)) {
    const d = json && (json.error || json.detail);
    const msg = typeof d === 'string' ? d : d ? JSON.stringify(d) : text.slice(0, 300);
    throw fail(502, `Music engine error (${r.status}): ${msg || 'no details'}`);
  }
  return json && 'data' in json ? json.data : json;
}

async function engineOnline() {
  try { await engine('/health'); return true; } catch { return false; }
}

// Low-memory machines run the engine without its language model (the part that writes lyrics).
async function lyricWriterMissing() {
  try { const h = await engine('/health'); return h.models_initialized === true && h.llm_initialized === false; } catch { return false; }
}

// --- Jobs: a song can take minutes, so the browser polls instead of waiting on one request ---
const jobs = new Map();

async function runJob(job, input) {
  const instrumental = Boolean(input.instrumental);
  const lyrics = instrumental ? '[Instrumental]' : String(input.lyrics || '').trim();
  const prompt = String(input.prompt).trim();
  const body = {
    audio_duration: Math.min(600, Math.max(10, Number(input.lengthSec) || 90)),
    audio_format: 'mp3',
    batch_size: 1,
    thinking: true,
    vocal_language: /^[a-z]{2}$/.test(input.language || '') ? input.language : 'en',
  };
  if (lyrics) Object.assign(body, { prompt, lyrics });
  else Object.assign(body, { sample_query: prompt }); // the engine's language model writes the lyrics

  let item = await generate(job, body);
  if (!item && await lyricWriterMissing()) {
    if (!lyrics) throw fail(502, 'The music engine on this computer is running without its lyric writer (not enough memory). Type your own lyrics and try again.');
    item = await generate(job, { ...body, thinking: false });
  }
  if (!item) throw fail(502, 'The music engine could not make this song. Check the ACE-Step window for the reason.');
  {
    const audio = await fetch(new URL(item.file, ENGINE), { headers: ENGINE_KEY ? { Authorization: `Bearer ${ENGINE_KEY}` } : {} });
    if (!audio.ok) throw fail(502, `Could not download the finished song (${audio.status}).`);
    const id = crypto.randomBytes(6).toString('hex');
    const song = {
      id,
      title: String(input.title || prompt).trim().slice(0, 80) || 'Untitled',
      prompt,
      style: String(item.prompt || ''),
      lyrics: instrumental ? '' : String(item.lyrics || lyrics),
      instrumental,
      metas: item.metas || null,
      createdAt: new Date().toISOString(),
      file: `/songs/${id}.mp3`,
    };
    fs.writeFileSync(path.join(SONGS, `${id}.mp3`), Buffer.from(await audio.arrayBuffer()));
    fs.writeFileSync(path.join(SONGS, `${id}.json`), JSON.stringify(song, null, 2));
    return song;
  }
}

// Submits one request to the engine and waits. Returns the finished item, or null if the engine reported failure.
async function generate(job, body) {
  const { task_id } = await engine('/release_task', body);
  if (!task_id) throw fail(502, 'Music engine did not accept the song request.');
  for (;;) {
    await sleep(3000);
    let task;
    try { [task] = (await engine('/query_result', { task_id_list: [task_id] })) || []; }
    catch (err) {
      if (err.status === 503) throw fail(503, 'The music engine stopped while making the song. It may have run out of memory; restart ACE-Step and try a shorter song.');
      throw err;
    }
    if (!task) continue;
    let items = task.result; // arrives as a JSON string
    try { if (typeof items === 'string') items = JSON.parse(items); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    if (task.status === 0) {
      if (items[0] && typeof items[0].progress === 'number') job.progress = items[0].progress;
      continue;
    }
    return (task.status === 1 && items.find((i) => i && i.file)) || null;
  }
}

function listSongs() {
  return fs.readdirSync(SONGS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(SONGS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const routes = {
  'GET /api/status': async () => ({ engineOnline: await engineOnline(), engineUrl: ENGINE }),

  'POST /api/compose': async (req) => {
    const input = await readJson(req);
    if (!input.prompt || !String(input.prompt).trim()) throw fail(400, 'Describe the song first.');
    if (!(await engineOnline())) throw fail(503, `The music engine is not running at ${ENGINE}. Start ACE-Step (see README) and try again.`);
    const job = { id: crypto.randomBytes(6).toString('hex'), status: 'working', startedAt: Date.now() };
    jobs.set(job.id, job);
    runJob(job, input)
      .then((song) => Object.assign(job, { status: 'done', song }))
      .catch((err) => { if (!err.status) console.error(err); Object.assign(job, { status: 'failed', error: err.message }); })
      .finally(() => setTimeout(() => jobs.delete(job.id), 3600e3).unref());
    return { jobId: job.id };
  },

  'GET /api/songs': async () => ({ songs: listSongs() }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return send(res, 200, await route(req));

    const jobMatch = req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/([a-f0-9]{12})$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'That song request was lost (the server restarted). Try again.' });
    }

    const del = req.method === 'DELETE' && url.pathname.match(/^\/api\/songs\/([a-f0-9]{12})$/);
    if (del) {
      for (const ext of ['.mp3', '.json']) fs.rmSync(path.join(SONGS, del[1] + ext), { force: true });
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

server.listen(PORT, async () => {
  console.log(`UNEAKBEATZ studio running at http://localhost:${PORT}`);
  if (!(await engineOnline())) console.log(`Music engine not reachable at ${ENGINE}. Start ACE-Step (see README).`);
});
