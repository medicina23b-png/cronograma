# Cronograma 23B — PWA + notificações (Cloudflare + Firebase `cronograma-23b`)

## O que tem na pasta
- `index.html`: o site, já apontando para o projeto Firebase **cronograma-23b**, com registro de push.
- `manifest.json`, `sw.js`, ícones: transformam o site em app instalável (e recebem os pushes).
- `push-worker/`: Worker da Cloudflare que envia os pushes e os lembretes de 1 h antes.
- `importar-planilha/`: copia os dados da planilha para o Firestore novo.
- `firestore.rules`: regras de segurança do projeto novo.

## Passo a passo (nesta ordem)

### 1. Firebase (projeto cronograma-23b)
1. **Authentication** ▸ Começar ▸ ative **E-mail/senha**. As contas dos discentes são criadas sozinhas no primeiro login.
2. **Firestore Database** ▸ Criar banco (modo produção). Depois, em **Regras**, cole o conteúdo de `firestore.rules` e publique.
3. **Configurações do projeto ▸ Cloud Messaging ▸ Certificados push da Web** ▸ Gerar par de chaves. Cole a chave em `CONFIG.VAPID_KEY` no `index.html`.
4. **Configurações do projeto ▸ Contas de serviço** ▸ Gerar nova chave privada (um .json). Guarde fora do GitHub; vai ser usada nos passos 2 e 4.
5. Em **Authentication ▸ Configurações ▸ Domínios autorizados**, adicione o endereço do seu site na Cloudflare.

### 2. Importar os dados da planilha
```
cd importar-planilha && npm install
node importar.mjs "Site - Cronograma da Turma.xlsx" --simular     # só mostra o que vai gravar
GOOGLE_APPLICATION_CREDENTIALS=caminho/da/chave.json node importar.mjs "Site - Cronograma da Turma.xlsx"
```
Importa eventos, mural, arquivos, datas, avaliações, tutorias, acompanhados, leituras/votos do mural e usuários. As senhas da aba de notas entram só como hash; a senha em texto puro não é enviada. A planilha reflete o que foi exportado dela: se o site antigo recebeu mudanças depois, exporte de novo antes de importar.

### 3. Site na Cloudflare
Suba esta pasta (menos `push-worker/` e `importar-planilha/`, se preferir) no repositório que a Cloudflare Pages publica. `sw.js` e `manifest.json` ficam na raiz. Se o repositório antigo tiver uma pasta `functions/` (Cloud Functions do Firebase), apague ou renomeie: a Cloudflare Pages trata `functions/` como código dela.

### 4. Worker de push
```
cd push-worker
npm install -g wrangler        # se ainda não tiver
wrangler login
# edite wrangler.toml: ALLOWED_ORIGIN = endereço do seu site
wrangler secret put FIREBASE_SERVICE_ACCOUNT   # cole o conteúdo inteiro do .json
wrangler deploy
```
O deploy mostra o endereço do Worker. Cole em `CONFIG.PUSH_URL` no `index.html` e republique o site.

### 5. Discentes
Abrem o site, tocam no sino ▸ **Ativar notificações**. No iPhone: instalar antes (Compartilhar ▸ Adicionar à Tela de Início), iOS 16.4+.

## Observações
- Teste do Worker sem internet: `node push-worker/teste.mjs`.
- Para versões novas do site, aumente `VERSION` em `sw.js`.
- O Worker consulta o Firestore a cada 5 min; cabe no plano gratuito de ambos.
