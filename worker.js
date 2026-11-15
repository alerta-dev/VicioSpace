// Secrets requeridos: USERS ("ana:clave1,juan:clave2"), SECRET (texto largo al azar), YT_KEY (YouTube Data API v3)
const enc = new TextEncoder();
async function sign(s, k) {
  const key = await crypto.subtle.importKey('raw', enc.encode(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(s)))));
}
const dec = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const J = (o, s = 200) => Response.json(o, { status: s });
const BGS = ['noche', 'atardecer', 'bosque', 'oceano'];

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    const users = Object.fromEntries((env.USERS || '').split(',').map(x => x.trim()).filter(Boolean)
      .map(x => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));

    if (path === '/api/login') {
      const hub = env.HUB.get(env.HUB.idFromName('hub')), ip = req.headers.get('cf-connecting-ip') || 'x';
      const rl = a => hub.fetch(new Request('https://hub/rl/' + a, { headers: { 'x-ip': ip } }));
      const c = await (await rl('check')).json();
      if (c.blocked) return J({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${c.wait} min` }, 429);
      const { u, p } = await req.json();
      if (users[u] && users[u] === p) { await rl('ok'); return J({ u, t: u + '.' + await sign(u, env.SECRET) }); }
      await rl('fail');
      return J({ error: 'Usuario o contraseña incorrectos' }, 401);
    }
    const tk = (req.headers.get('authorization') || '').slice(7), i = tk.lastIndexOf('.'), user = tk.slice(0, i);
    if (!users[user] || tk.slice(i + 1) !== await sign(user, env.SECRET)) return J({ error: 'No autorizado' }, 401);

    if (path === '/api/search') {
      const q = url.searchParams.get('q');
      if (!q) return J([]);
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&q=${encodeURIComponent(q)}&key=${env.YT_KEY}`);
      if (!r.ok) return J({ error: 'YouTube no respondió (¿se acabó la cuota diaria?)' }, 502);
      const j = await r.json();
      return J(j.items.map(x => ({ id: x.id.videoId, title: dec(x.snippet.title), ch: dec(x.snippet.channelTitle) })));
    }
    const stub = env.HUB.get(env.HUB.idFromName('hub'));
    return stub.fetch(new Request('https://hub' + path.slice(4), {
      method: req.method, body: req.method === 'POST' ? req.body : undefined, headers: { 'x-user': user }
    }));
  }
};

export class Hub {
  constructor(s) { this.s = s; this.pr = {}; }
  who(id) { return Object.entries(this.pr[id] || {}).filter(([, t]) => Date.now() - t < 6000).map(x => x[0]); }
  async fetch(req) {
    const u = req.headers.get('x-user'), p = new URL(req.url).pathname.split('/').filter(Boolean), now = Date.now();
    const d = (await this.s.storage.get('d')) || { rooms: {} };
    const b = req.method === 'POST' ? await req.json() : {};
    let o, w = 0;
    if (p[0] === 'rl') { // límite de intentos de login: 5 fallos = bloqueo de 15 min por IP
      const k = 'rl:' + req.headers.get('x-ip'), e = (await this.s.storage.get(k)) || { n: 0, t: 0 }, W = 15 * 60000;
      if (p[1] === 'check') return J(e.n >= 5 && now - e.t < W ? { blocked: true, wait: Math.ceil((W - (now - e.t)) / 60000) } : {});
      if (p[1] === 'fail') await this.s.storage.put(k, { n: now - e.t > W ? 1 : e.n + 1, t: now });
      else await this.s.storage.delete(k);
      return J({});
    }
    if (!p[1]) {
      if (req.method === 'POST') {
        const id = crypto.randomUUID().slice(0, 8);
        d.rooms[id] = { id, name: String(b.name || 'Sala').slice(0, 40), owner: u, color: '#8b5cf6', emoji: '🎧', bg: 'noche', board: [], bv: 0, queue: [], idx: -1, playing: false, pos: 0, at: now, pomo: { mode: 'idle', end: 0 } };
        w = 1; o = { id };
      } else o = Object.values(d.rooms).map(r => ({ id: r.id, name: r.name, owner: r.owner, color: r.color, emoji: r.emoji, now: r.queue[r.idx]?.title, n: this.who(r.id).length }));
    } else {
      const r = d.rooms[p[1]];
      if (!r) return J({ error: 'No existe' }, 404);
      (this.pr[r.id] ??= {})[u] = now;
      if (p[2] === 'del') {
        if (r.owner !== u) return J({ error: 'Solo quien creó la sala puede eliminarla' }, 403);
        delete d.rooms[r.id]; w = 1; o = {};
      } else {
        r.board ??= []; r.bv ??= 0;
        if (p[2] === 'board') {
          const sp = new URL(req.url).searchParams, same = Number(sp.get('v')) === r.bv;
          return J({ v: r.bv, reset: !same, strokes: r.board.slice(same ? Number(sp.get('from')) || 0 : 0) });
        }
        if (p[2] === 'act') { act(r, b, u, now); w = 1; }
        const { board, ...rest } = r;
        o = { ...rest, bn: board.length, now, users: this.who(r.id) };
      }
    }
    if (w) await this.s.storage.put('d', d);
    return J(o);
  }
}

function act(r, b, u, now) {
  const cur = () => r.pos + (r.playing ? (now - r.at) / 1000 : 0);
  const go = i => { r.idx = i; r.pos = 0; r.at = now; r.playing = true; };
  const q = r.queue;
  switch (b.type) {
    case 'add': case 'now': {
      const v = b.v || {};
      if (!/^[\w-]{11}$/.test(v.id)) break;
      const it = { id: v.id, title: String(v.title).slice(0, 120), by: u };
      if (b.type === 'now' && r.idx >= 0) { q.splice(r.idx + 1, 0, it); go(r.idx + 1); }
      else { q.push(it); if (r.idx < 0 || b.type === 'now') go(q.length - 1); }
      break;
    }
    case 'play': if (Number.isInteger(b.i) && q[b.i]) go(b.i); break;
    case 'next': if (b.from !== r.idx) break; if (r.idx + 1 < q.length) go(r.idx + 1); else { r.pos = 0; r.playing = false; } break;
    case 'prev': if (r.idx >= 0) go(Math.max(0, r.idx - 1)); break;
    case 'toggle': if (r.idx < 0) break; if (r.playing) { r.pos = cur(); r.playing = false; } else { r.playing = true; r.at = now; } break;
    case 'rm': {
      const i = b.i; if (!Number.isInteger(i) || !q[i]) break;
      q.splice(i, 1);
      if (i < r.idx) r.idx--;
      else if (i === r.idx) { if (!q.length) { r.idx = -1; r.playing = false; } else { r.idx = Math.min(r.idx, q.length - 1); r.pos = 0; r.at = now; } }
      break;
    }
    case 'theme':
      if (/^#[0-9a-f]{6}$/i.test(b.color)) r.color = b.color;
      if (BGS.includes(b.bg)) r.bg = b.bg;
      if (b.emoji) r.emoji = String(b.emoji).slice(0, 4);
      if (b.name && u === r.owner) r.name = String(b.name).slice(0, 40);
      break;
    case 'stroke': {
      const s = b.s || {};
      if (!Array.isArray(s.p) || !s.p.length || s.p.length > 800 || !/^#[0-9a-f]{6}$/i.test(s.c)) break;
      const pts = s.p.map(a => [Math.min(1, Math.max(0, +(a || [])[0] || 0)), Math.min(1, Math.max(0, +(a || [])[1] || 0))]);
      r.board.push({ c: s.c, w: Math.min(30, Math.max(1, +s.w || 3)), p: pts });
      if (r.board.length > 300) { r.board.shift(); r.bv++; }
      break;
    }
    case 'clear': r.board = []; r.bv++; break;
    case 'pomo':
      if (b.mode === 'idle') r.pomo = { mode: 'idle', end: 0 };
      else if (b.mode === 'work' || b.mode === 'rest') r.pomo = { mode: b.mode, end: now + (b.mode === 'work' ? 25 : 5) * 60000 };
      break;
  }
}
