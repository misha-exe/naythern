// services/kv.js - tiny Redis client over the Upstash / Vercel KV REST API.
// Falls back to an in-memory store when no KV env vars are set (local development only: on Vercel every
// function instance has its own memory, so data would not persist or be shared).
const url = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = () => !!(url() && token());

async function post(path, body) {
  const res = await fetch(url() + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`KV request failed (${res.status})${data && data.error ? ': ' + data.error : ''}`);
  return data;
}

const str = (a) => (typeof a === 'number' ? a : String(a));

async function cmd(...args) {
  args = args.map(str);
  if (!enabled()) return mem(args);
  const d = await post('', args);
  if (d && d.error) throw new Error(d.error);
  return d.result;
}

async function pipeline(cmds) {
  if (!cmds.length) return [];
  cmds = cmds.map((c) => c.map(str));
  if (!enabled()) return cmds.map(mem);
  const d = await post('/pipeline', cmds);
  return d.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

/* ---------- in-memory fallback (subset of Redis) ---------- */
const store = new Map();
const expiry = new Map();
const alive = (k) => {
  const e = expiry.get(k);
  if (e && e <= Date.now()) { store.delete(k); expiry.delete(k); return false; }
  return store.has(k);
};
const range = (l, s, e) => {
  const n = l.length;
  if (s < 0) s = Math.max(n + s, 0);
  if (e < 0) e = n + e;
  return l.slice(s, e + 1);
};

function mem(args) {
  const [op, key, ...rest] = args;
  switch (String(op).toUpperCase()) {
    case 'GET': return alive(key) ? store.get(key) : null;
    case 'SET': {
      let nx = false, ex = null;
      for (let i = 1; i < rest.length; i++) {
        const f = String(rest[i]).toUpperCase();
        if (f === 'NX') nx = true; else if (f === 'EX') ex = Number(rest[++i]);
      }
      if (nx && alive(key)) return null;
      store.set(key, String(rest[0]));
      if (ex) expiry.set(key, Date.now() + ex * 1000); else expiry.delete(key);
      return 'OK';
    }
    case 'DEL': {
      let n = 0;
      for (const k of [key, ...rest]) if (alive(k)) { store.delete(k); expiry.delete(k); n++; }
      return n;
    }
    case 'INCR': {
      const n = (alive(key) ? Number(store.get(key)) : 0) + 1;
      store.set(key, String(n));
      return n;
    }
    case 'EXPIRE': if (!alive(key)) return 0; expiry.set(key, Date.now() + Number(rest[0]) * 1000); return 1;
    case 'MGET': return [key, ...rest].map((k) => (alive(k) ? store.get(k) : null));
    case 'SADD': { const s = alive(key) ? store.get(key) : new Set(); rest.forEach((m) => s.add(String(m))); store.set(key, s); return rest.length; }
    case 'SREM': { if (!alive(key)) return 0; const s = store.get(key); let n = 0; rest.forEach((m) => { if (s.delete(String(m))) n++; }); return n; }
    case 'SMEMBERS': return alive(key) ? [...store.get(key)] : [];
    case 'SCARD': return alive(key) ? store.get(key).size : 0;
    case 'LPUSH': { const l = alive(key) ? store.get(key) : []; rest.forEach((v) => l.unshift(String(v))); store.set(key, l); return l.length; }
    case 'LTRIM': if (alive(key)) store.set(key, range(store.get(key), Number(rest[0]), Number(rest[1]))); return 'OK';
    case 'LRANGE': return alive(key) ? range(store.get(key), Number(rest[0]), Number(rest[1])) : [];
    case 'LLEN': return alive(key) ? store.get(key).length : 0;
    case 'LREM': {
      if (!alive(key)) return 0;
      const l = store.get(key); const v = String(rest[1]); let n = 0;
      for (let i = 0; i < l.length && (Number(rest[0]) === 0 || n < Number(rest[0])); ) {
        if (l[i] === v) { l.splice(i, 1); n++; } else i++;
      }
      return n;
    }
    default: throw new Error(`In-memory KV does not support ${op}`);
  }
}

module.exports = { cmd, pipeline, enabled };
