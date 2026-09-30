import crypto from 'node:crypto';
import express from 'express';
import { createWasmCrypto } from './wasm-crypto.js';

const API_BASE = process.env.VIDUKI_API_BASE || 'https://api.viduki.net';
const ORIGIN = process.env.VIDUKI_ORIGIN || 'https://www.viduki.net';
const PORT = Number(process.env.PORT || 8787);
const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/137 Safari/537.36',
  Origin: ORIGIN, Referer: `${ORIGIN}/`, 'Accept-Language': 'en-US,en;q=0.9'
};
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*'); next(); });

let wasm;
let pepperReady = false;
let pepperExpires = 0;
let bootstrapNonce = null;
let bootstrapPromise = null;
let pepperPromise = null;
const randomHex = n => crypto.randomBytes(n).toString('hex');

async function solveAltcha(challenge) {
  const target = String(challenge.challenge).toLowerCase();
  const salt = String(challenge.salt);
  for (let number = 0; number <= Number(challenge.maxnumber ?? 50000); number++) {
    const digest = crypto.createHash('sha256').update(salt + String(number)).digest('hex');
    if (digest === target) {
      return Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, number, salt, signature: challenge.signature, took: 0 })).toString('base64');
    }
  }
  throw new Error('Altcha solution not found');
}

async function getJson(path, options = {}) {
  const response = await fetch(API_BASE + path, { ...options, headers: { ...browserHeaders, Accept: 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`upstream ${path} returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`upstream ${path} failed (${response.status})`);
  return data;
}

async function freshNonce() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const challenge = await getJson('/altcha-challenge');
    const solution = await solveAltcha(challenge);
    const data = await getJson('/bootstrap', { headers: { 'X-Altcha': solution } });
    if (!data?.n || !/^[0-9a-f]{32}$/i.test(data.n)) throw new Error('invalid bootstrap nonce');
    bootstrapNonce = data.n;
    pepperReady = false;
    pepperExpires = 0;
    return bootstrapNonce;
  })().finally(() => { bootstrapPromise = null; });
  return bootstrapPromise;
}

async function ensurePepper() {
  if (pepperReady && Date.now() < pepperExpires) return;
  if (pepperPromise) return pepperPromise;
  pepperPromise = (async () => {
    const nonce = bootstrapNonce || await freshNonce();
    const challenge = await getJson('/altcha-challenge');
    const solution = await solveAltcha(challenge);
    const envelope = await getJson('/pepper-key', { headers: { 'X-Nonce': nonce, 'X-Altcha': solution } });
    if (envelope?.v !== 1) throw new Error('invalid pepper envelope');
    wasm.reset();
    if (!wasm.decryptPepper({ nonce, bucket: envelope.bucket, iv: envelope.iv, ct: envelope.ct, tag: envelope.tag })) throw new Error('pepper decrypt failed');
    pepperReady = true;
    pepperExpires = Date.now() + 4 * 60 * 1000;
  })().catch(error => { bootstrapNonce = null; pepperReady = false; throw error; }).finally(() => { pepperPromise = null; });
  return pepperPromise;
}

async function resolvePath(path) {
  await ensurePepper();
  const clientNonce = randomHex(16);
  const requestId = randomHex(16);
  const envelope = await getJson(path, { headers: { 'X-Nonce': bootstrapNonce, 'X-Client-Nonce': clientNonce, 'X-Request-Id': requestId } });
  if (envelope?.v !== 1) throw new Error('invalid encrypted envelope');
  const clear = wasm.decryptEnvelope({ clientNonce, serverNonce: envelope.sn, tb: envelope.tb, requestId, iv2: envelope.iv2, wk: envelope.wk, tag2: envelope.tag2, iv1: envelope.iv1, ct: envelope.ct, tag1: envelope.tag1 });
  if (!clear) throw new Error('response decrypt failed');
  return JSON.parse(Buffer.from(clear).toString('utf8'));
}

async function getServers() {
  const data = await getJson('/main/servers');
  return Array.isArray(data) ? data : (Array.isArray(data?.servers) ? data.servers : data?.data || []);
}

function sourcePath({ type, tmdb_id, season, episode, server }) {
  const id = encodeURIComponent(String(tmdb_id));
  const srv = encodeURIComponent(String(server));
  if (type === 'tv') return `/main/tv/${id}/${encodeURIComponent(String(season))}/${encodeURIComponent(String(episode))}?srv=${srv}`;
  return `/main/movie/${id}?srv=${srv}`;
}

function findUrl(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) return value.url;
  for (const child of Object.values(value)) { const found = findUrl(child); if (found) return found; }
  return null;
}

async function resolveAll(input) {
  const servers = await getServers();
  const results = [];
  for (let i = 0; i < servers.length; i += 3) {
    const batch = servers.slice(i, i + 3);
    const rows = await Promise.all(batch.map(async server => {
      const name = typeof server === 'string' ? server : server.name;
      try {
        const data = await resolvePath(sourcePath({ ...input, server: name }));
        return { server: name, ok: true, stream_url: findUrl(data), data };
      } catch (error) { return { server: name, ok: false, error: error.message }; }
    }));
    results.push(...rows);
  }
  return { servers, results, success_count: results.filter(x => x.ok && x.stream_url).length };
}

const page = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>فاحص مصادر التشغيل</title><style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#141b31;--line:#2a3559;--text:#edf2ff;--muted:#9ca8c7;--accent:#7c9cff;--ok:#50d890;--bad:#ff7185}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#1b2850 0,#0b1020 45%);color:var(--text);font:16px system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:34px 18px}h1{margin:0 0 8px;font-size:30px}p{color:var(--muted)}.panel{background:rgba(20,27,49,.88);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:0 18px 60px #0004}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{display:flex;flex-direction:column;gap:7px}label{color:var(--muted);font-size:14px}input,select,button{border:1px solid var(--line);border-radius:10px;background:#0c1327;color:var(--text);padding:12px;font:inherit}button{background:var(--accent);border:0;color:#081027;font-weight:700;cursor:pointer;margin-top:16px}button:disabled{opacity:.5;cursor:wait}.stats{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 11px;color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:right;border-bottom:1px solid var(--line);padding:12px 8px;vertical-align:top}th{color:var(--muted);font-weight:500}.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:#a9bcff;word-break:break-all}.small{font-size:13px;color:var(--muted)}@media(max-width:700px){.grid{grid-template-columns:1fr}h1{font-size:24px}main{padding:20px 12px}}</style></head><body><main><div class="panel"><h1>فاحص مصادر التشغيل</h1><p>أدخل TMDB ID لفحص جميع السيرفرات التي يرجعها الموقع. الروابط مؤقتة وموقعة.</p><form id="form"><div class="grid"><div class="field"><label>النوع</label><select id="type"><option value="movie">فيلم</option><option value="tv">مسلسل</option></select></div><div class="field"><label>TMDB ID</label><input id="id" required inputmode="numeric" placeholder="مثال: 533535"></div><div class="field tv"><label>الموسم</label><input id="season" type="number" min="1" value="1"></div><div class="field tv"><label>الحلقة</label><input id="episode" type="number" min="1" value="1"></div></div><button id="submit">فحص كل السيرفرات</button></form><div id="status" class="small"></div><div id="stats" class="stats"></div><div id="out"></div></div></main><script>
const $=id=>document.getElementById(id),type=$('type');function toggle(){document.querySelectorAll('.tv').forEach(x=>x.style.display=type.value==='tv'?'flex':'none')}type.onchange=toggle;toggle();$('form').onsubmit=async e=>{e.preventDefault();const btn=$('submit');btn.disabled=true;$('status').textContent='جارِ طلب القائمة وفحص المصادر...';$('out').innerHTML='';$('stats').innerHTML='';const body={type:type.value,tmdb_id:Number($('id').value),season:Number($('season').value),episode:Number($('episode').value)};try{const r=await fetch('/resolve-all',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'فشل الطلب');$('status').textContent='اكتمل الفحص';$('stats').innerHTML='<span class="pill">إجمالي السيرفرات: '+d.servers.length+'</span><span class="pill">مصادر ناجحة: '+d.success_count+'</span>';const rows=d.results.map(x=>'<tr><td>'+x.server+'</td><td class="'+(x.ok?'ok':'bad')+'">'+(x.ok?'نجح':'فشل')+'</td><td>'+(x.stream_url?'<a href="'+x.stream_url+'" target="_blank" rel="noreferrer">فتح الرابط</a><div class="small">'+x.stream_url+'</div>':'<span class="small">'+(x.error||'لا يوجد رابط')+'</span>')+'</td></tr>').join('');$('out').innerHTML='<table><thead><tr><th>السيرفر</th><th>الحالة</th><th>المصدر</th></tr></thead><tbody>'+rows+'</tbody></table>'}catch(err){$('status').textContent='خطأ: '+err.message}finally{btn.disabled=false}};
</script></body></html>`;

app.get('/', (req, res) => res.type('html').send(page));
app.get('/health', (req, res) => res.json({ ok: true, wasm: Boolean(wasm), pepper_cached: pepperReady && Date.now() < pepperExpires }));
app.get('/servers', async (req, res) => { try { res.json({ ok: true, servers: await getServers() }); } catch (error) { res.status(502).json({ ok: false, error: error.message }); } });
app.post('/resolve', async (req, res) => { try { const data = await resolvePath(sourcePath({ type: 'movie', ...req.body, server: req.body?.server || 'Leon' })); res.json({ ok: true, stream_url: findUrl(data), data }); } catch (error) { res.status(502).json({ ok: false, error: error.message }); } });
app.post('/resolve-all', async (req, res) => { const body = req.body || {}; if (!['movie', 'tv'].includes(body.type) || !Number.isInteger(Number(body.tmdb_id)) || Number(body.tmdb_id) <= 0 || (body.type === 'tv' && (!Number.isInteger(Number(body.season)) || !Number.isInteger(Number(body.episode)) || Number(body.season) < 1 || Number(body.episode) < 1))) return res.status(400).json({ ok: false, error: 'type, tmdb_id, season and episode are invalid' }); try { res.json({ ok: true, ...(await resolveAll(body)) }); } catch (error) { res.status(502).json({ ok: false, error: error.message }); } });

wasm = await createWasmCrypto();
app.listen(PORT, '0.0.0.0', () => console.log(`viduki resolver listening on 0.0.0.0:${PORT}`));
