// Teste local: assina o JWT com uma chave RSA de mentira e simula Firestore/FCM.
import { generateKeyPairSync } from 'node:crypto';
import { enviarPendentes, enviarLembretes, fromFs } from './src/index.js';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = { PROJECT_ID: 'p', FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'x@y', private_key: privateKey }) };
const S = s => ({ stringValue: s });
const hoje = new Date(Date.now() - 3 * 3600e3 + 55 * 60e3); // evento daqui a ~45 min (UTC-3)
const dia = hoje.toISOString().slice(0, 10), hm = hoje.toISOString().slice(11, 16);
const enviados = [], gravados = [];
globalThis.fetch = async (url, o = {}) => {
  url = String(url); const body = o.body && !url.includes('oauth') ? JSON.parse(o.body) : null;
  const J = (x, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => x, text: async () => JSON.stringify(x) });
  if (url.includes('oauth2')) return J({ access_token: 't', expires_in: 3600 });
  if (url.includes('messages:send')) { enviados.push(body.message.data.titulo); return J({}); }
  if (url.includes('/pushTokens?')) return J({ documents: [{ name: '.../pushTokens/a', fields: { token: S('tk'), usuario: S('ana') } }] });
  if (url.includes(':runQuery')) {
    const c = body.structuredQuery.from[0].collectionId;
    if (c === 'pushTokens') return J([{ document: { name: '.../pushTokens/a', fields: { token: S('tk'), usuario: S('ana') } } }]);
    if (c === 'itens') return J([{ document: { name: 'projects/p/databases/(default)/documents/notificacoes/ana/itens/n1', fields: { titulo: S('Aviso'), corpo: S('x'), criadoEm: S(new Date().toISOString()) } } }]);
    if (c === 'eventos') return J([{ document: { name: '.../eventos/e1', fields: { data: S(dia), inicio: S(hm), titulo: S('Aula X'), discentes: S('1 | Ana Silva') } } }]);
    return J([{}]);
  }
  if (url.includes('lembretesEnviados') && o.method !== 'PATCH') return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  if (url.includes('/usuarios')) return J({ documents: [{ name: '.../usuarios/ana', fields: { nome: S('Ana Silva') } }] });
  if (o.method === 'PATCH') { gravados.push(url.split('/documents/')[1] || url); return J({}); }
  return J({});
};
console.log('pendentes', await enviarPendentes(env), 'lembretes', await enviarLembretes(env), enviados, gravados.length);
console.log(fromFs({ mapValue: { fields: { a: { arrayValue: { values: [{ integerValue: '3' }] } } } } }));
