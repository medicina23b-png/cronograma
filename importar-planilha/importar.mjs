// Importa a planilha (Site - Cronograma da Turma.xlsx) para o Firestore do projeto novo.
//   Simulação (não grava nada):   node importar.mjs planilha.xlsx --simular
//   Importar de verdade:          GOOGLE_APPLICATION_CREDENTIALS=chave.json node importar.mjs planilha.xlsx
// Pode rodar mais de uma vez: os documentos têm IDs fixos e são apenas sobrescritos.
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

const [arquivo, ...flags] = process.argv.slice(2);
const simular = flags.includes('--simular');
if (!arquivo) { console.error('Uso: node importar.mjs planilha.xlsx [--simular]'); process.exit(1); }

const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(arquivo);
const val = v => { if (v == null) return null; if (typeof v === 'object') { if (v.text) return String(v.text); if (v.result != null) return String(v.result); if (v instanceof Date) return v.toISOString(); } return String(v); };
function linhas(aba) {
  const ws = wb.getWorksheet(aba); if (!ws) return [];
  const cab = ws.getRow(1).values.slice(1).map(c => (val(c) || '').trim());
  const out = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const o = {}; let tem = false;
    cab.forEach((c, j) => { if (!c) return; const v = val(row.getCell(j + 1).value); if (v !== null && v !== '') { o[c] = v; tem = true; } });
    if (tem) out.push(o);
  });
  return out;
}
const json = s => { try { return JSON.parse(s); } catch { return undefined; } };
const sha = t => createHash('sha256').update(String(t)).digest('hex');
const limpa = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const plano = []; // [colecao, id, dados]
for (const r of linhas('Eventos')) { const { id, ...d } = r; delete d.arquivosAnexados; plano.push(['eventos', id, d]); }
for (const r of linhas('Mural')) { const { id, ...d } = r; ['eventoIds', 'arquivoIds', 'opcoes'].forEach(k => { d[k] = json(d[k]) || []; }); plano.push(['mural', id, d]); }
for (const r of linhas('Arquivos')) { const { id, ...d } = r; plano.push(['arquivos', id, d]); }
for (const r of linhas('DatasImportantes')) { const { id, ...d } = r; plano.push(['datasImportantes', id, d]); }
for (const r of linhas('Avaliacoes')) { const { id, ...d } = r; plano.push(['avaliacoes', id, d]); }
for (const r of linhas('Notas')) { const { id, ...d } = r; plano.push(['notas', id, d]); }
for (const r of linhas('SessoesTutoria')) { const { eventoId, ...d } = r; d.objetivos = json(d.objetivos) || []; if (d.relatorio) d.relatorio = json(d.relatorio); plano.push(['sessoesTutoria', eventoId, d]); }
for (const r of linhas('Acompanhados')) plano.push(['acompanhados', `${r.usuario}_${r.eventoId}`, { usuario: r.usuario, eventoId: r.eventoId }]);
for (const r of linhas('MuralLido')) plano.push(['muralLido', `${r.usuario}_${r.avisoId}`, { usuario: r.usuario, avisoId: r.avisoId }]);
for (const r of linhas('MuralVotos')) plano.push(['muralVotos', `${r.usuario}_${r.avisoId}_${r.opcao}`, { usuario: r.usuario, avisoId: r.avisoId, opcao: String(r.opcao) }]);
for (const r of linhas('Usuarios')) {
  const d = { nome: r.nome, email: r['e-mail'], aniversario: r.aniversario, matricula: r.matricula, telefone: r.telefone };
  // A senha das notas vinha em texto puro na planilha; o app só guarda o hash (SHA-256). A senha em si NÃO é enviada.
  if (r.senhanotas) d.senhaNotasHash = sha(r.senhanotas);
  plano.push(['usuarios', r.usuario, d]);
}

const resumo = {}; plano.forEach(([c]) => { resumo[c] = (resumo[c] || 0) + 1; });
console.table(resumo);
if (simular) { console.log('Simulação: nada foi gravado. Exemplo:', JSON.stringify(plano.find(p => p[0] === 'usuarios'), null, 1)); process.exit(0); }

const { default: admin } = await import('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
for (let i = 0; i < plano.length; i += 400) {
  const lote = db.batch();
  plano.slice(i, i + 400).forEach(([c, id, d]) => lote.set(db.collection(c).doc(id), limpa(d)));
  await lote.commit(); console.log(`gravados ${Math.min(i + 400, plano.length)}/${plano.length}`);
}
console.log('Concluído.');
