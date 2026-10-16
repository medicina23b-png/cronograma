// Worker da Cloudflare: envia push (FCM) para os discentes.
//  - POST  (do app, com token do Firebase Auth): envia já as notificações pendentes.
//  - cron  (a cada 5 min): lembretes ~1 h antes dos eventos + pendentes esquecidas.
// Fala com Firestore e FCM por REST (o firebase-admin não roda em Workers).

const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = s => b64u(enc.encode(s));

// ---------- OAuth da conta de serviço ----------
let tokenCache = { v: '', exp: 0 };
export async function accessToken(env) {
  if (tokenCache.v && Date.now() < tokenCache.exp - 60000) return tokenCache.v;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const head = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64uStr(JSON.stringify({
    iss: sa.client_email, sub: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + body)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + body + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth falhou: ' + JSON.stringify(j));
  tokenCache = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.v;
}

// ---------- Firestore REST ----------
export function fromFs(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return fromFsFields(v.mapValue.fields || {});
  return null;
}
const fromFsFields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fromFs(v)]));
export const toFs = v => typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) };
const docOut = d => ({ id: d.name.split('/').pop(), path: d.name, ...fromFsFields(d.fields || {}) });

function fs(env) {
  const base = `https://firestore.googleapis.com/v1/projects/${env.PROJECT_ID}/databases/(default)/documents`;
  const call = async (url, opt = {}) => {
    const r = await fetch(url, { ...opt, headers: { Authorization: 'Bearer ' + await accessToken(env), 'Content-Type': 'application/json' } });
    if (!r.ok && r.status !== 404) throw new Error(`Firestore ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.status === 404 ? null : r.json();
  };
  const run = async (parent, q) => {
    const j = await call(`${base}${parent}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery: q }) });
    return (j || []).filter(x => x.document).map(x => docOut(x.document));
  };
  return {
    base,
    async list(col) {
      let out = [], tok = '';
      do {
        const j = await call(`${base}/${col}?pageSize=300${tok ? '&pageToken=' + tok : ''}`);
        out = out.concat(((j && j.documents) || []).map(docOut)); tok = (j && j.nextPageToken) || '';
      } while (tok);
      return out;
    },
    where: (col, campo, valor, parent = '') => run(parent, {
      from: [{ collectionId: col }],
      where: { fieldFilter: { field: { fieldPath: campo }, op: 'EQUAL', value: toFs(valor) } }, limit: 300,
    }),
    get: async (col, id) => { const j = await call(`${base}/${col}/${id}`); return j ? docOut(j) : null; },
    set: (col, id, data) => call(`${base}/${col}/${id}`, { method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])) }) }),
    patchPath: (path, data) => call(`https://firestore.googleapis.com/v1/${path}?` + Object.keys(data).map(k => 'updateMask.fieldPaths=' + k).join('&'),
      { method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])) }) }),
    del: (col, id) => call(`${base}/${col}/${id}`, { method: 'DELETE' }),
  };
}

// ---------- FCM v1 ----------
async function enviarFcm(env, tokens, data) {
  const ok = [], mortos = [];
  await Promise.all(tokens.map(async t => {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${env.PROJECT_ID}/messages:send`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + await accessToken(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: t.token, data, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } }),
    });
    if (r.ok) ok.push(t.id);
    else { const e = await r.text(); if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(e)) mortos.push(t.id); }
  }));
  return { enviados: ok.length, mortos };
}

const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function enviarAoUsuario(env, db, usuario, n) {
  const tokens = (await db.where('pushTokens', 'usuario', usuario)).filter(t => t.token).map(t => ({ id: t.id, token: t.token }));
  if (!tokens.length) return 0;
  const data = {
    titulo: String(n.titulo || 'Cronograma Acadêmico').slice(0, 120), corpo: String(n.corpo || '').slice(0, 300),
    tipo: String(n.tipo || ''), refId: String(n.refId || ''), url: '/', tag: n.tag ? String(n.tag) : '',
  };
  const r = await enviarFcm(env, tokens, data);
  await Promise.all(r.mortos.map(id => db.del('pushTokens', id).catch(() => {})));
  return r.enviados;
}

export async function enviarPendentes(env) {
  const db = fs(env);
  const usuarios = [...new Set((await db.list('pushTokens')).map(t => t.usuario).filter(Boolean))];
  let total = 0;
  for (const u of usuarios) {
    const pend = await db.where('itens', 'pushEnviado', false, `/notificacoes/${u}`);
    for (const n of pend.slice(0, 20)) {
      const velha = Date.now() - new Date(n.criadoEm || 0).getTime() > 24 * 3600e3;
      if (!velha) total += await enviarAoUsuario(env, db, u, n);
      await db.patchPath(n.path.split('/documents/')[0] + '/documents/' + n.path.split('/documents/')[1], { pushEnviado: true });
    }
  }
  return total;
}

export async function enviarLembretes(env, antecedenciaMin = 60, janelaMin = 10) {
  const db = fs(env), agora = Date.now();
  const dia = ms => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10); // America/Belem = UTC-3
  let total = 0, usuarios = null;
  for (const d of new Set([dia(agora), dia(agora + antecedenciaMin * 60e3)])) {
    for (const e of await db.where('eventos', 'data', d)) {
      if (!e.inicio || String(e.cancelado || '').toLowerCase().startsWith('s')) continue;
      const falta = (new Date(`${e.data}T${e.inicio}:00-03:00`).getTime() - agora) / 60e3;
      if (falta <= 0 || falta > antecedenciaMin || falta <= antecedenciaMin - janelaMin) continue;
      const marca = `${e.id}_${e.data}_${e.inicio}`.replace(/[^\w-]/g, '_');
      if (await db.get('lembretesEnviados', marca)) continue;
      await db.set('lembretesEnviados', marca, { em: new Date().toISOString() });
      usuarios = usuarios || await db.list('usuarios');
      const publico = new Set((await db.where('acompanhados', 'eventoId', e.id)).map(x => x.usuario));
      const citados = String(e.discentes || '').split('\n').map(l => (l.match(/^\s*\d+\s*\|\s*(.+?)\s*$/) || [])[1]).filter(Boolean).map(norm);
      usuarios.forEach(u => { if (u.id !== 'presidente' && citados.includes(norm(u.nome))) publico.add(u.id); });
      for (const u of publico) total += await enviarAoUsuario(env, db, u, { tipo: 'evento', titulo: `Em ~1h: ${e.titulo || e.disciplina}`, corpo: `${e.inicio}${e.local ? ' · ' + e.local : ''}`, refId: e.id, tag: 'lembrete-' + e.id });
    }
  }
  return total;
}

// ---------- entrada ----------
const cors = env => ({ 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' });
let ultimo = 0;

export default {
  async fetch(req, env) {
    const h = cors(env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (req.method !== 'POST') return new Response('ok', { headers: h });
    try {
      const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer /i, '');
      const v = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
      if (!v.ok) return Response.json({ ok: false, erro: 'não autenticado' }, { status: 401, headers: h });
      if (Date.now() - ultimo < 3000) return Response.json({ ok: true, adiado: true }, { headers: h });
      ultimo = Date.now();
      return Response.json({ ok: true, enviados: await enviarPendentes(env) }, { headers: h });
    } catch (e) { return Response.json({ ok: false, erro: String(e.message || e) }, { status: 500, headers: h }); }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil((async () => console.log(JSON.stringify({ pendentes: await enviarPendentes(env), lembretes: await enviarLembretes(env) })))());
  },
};
