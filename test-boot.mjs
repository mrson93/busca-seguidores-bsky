// Roda o <script type="module"> real do index.html num DOM mínimo.
// Cobre o boot de contas (que o preview do navegador não reproduz) e o
// pipeline de busca -> contagens -> filtros -> limite.
// Fuso opcional: `node test-boot.mjs Asia/Tokyo`. Tem que vir antes do primeiro Date —
// e tem que ser aqui: a variável TZ do shell não chega ao Node neste ambiente.
if (process.argv[2]) process.env.TZ = process.argv[2];

import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const mod = src.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
writeFileSync(join(import.meta.dirname, 'boot.mjs'), mod);

// Estado inicial vindo do próprio HTML, para o falso DOM não divergir do real:
// valor do <select> (primeira <option>) e quem começa com o atributo hidden.
const PADRAO = {};
for (const m of src.matchAll(/<select id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g))
  PADRAO[m[1]] = m[2].match(/<option value="([^"]+)"/)?.[1] ?? '';

// conteúdo fixo escrito no HTML (o script para copiar, por exemplo)
const TEXTO = {};
for (const m of src.matchAll(/<(pre|code|p|span)[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/\1>/g))
  TEXTO[m[2]] = m[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const OCULTOS = new Set();
for (const [tag] of src.matchAll(/<[a-z]+\s[^>]*>/g)) {
  const id = tag.match(/id="(\w+)"/)?.[1];
  if (id && /\shidden[\s>]/.test(tag)) OCULTOS.add(id);
}

// Elemento falso: guarda o que for atribuído, ignora o que for chamado.
const fakeEl = (extra = {}) => new Proxy({ value: '', options: [], dataset: {}, ...extra }, {
  get: (t, k) => k in t ? t[k]
    : k === 'then' ? undefined
    : typeof k === 'string' ? () => fakeEl() : undefined,
  set: (t, k, v) => (t[k] = v, true),
});

const PERFIS = [
  { n: 'a', seguidores: 100, seguindo: 50, seguidoEm: '2026-01-10T00:00:00Z' },
  { n: 'b', seguidores: 750, seguindo: 900, seguindoJa: 'at://x/app.bsky.graph.follow/ja',
    meSegue: true, seguidoEm: '2026-03-20T00:00:00Z' },
  { n: 'c', seguidores: 5000, seguindo: 10, seguidoEm: '2026-06-30T00:00:00Z', repostouPorUltimo: true },
];
const did = p => 'did:plc:' + p.n;
const handle = p => p.n + '.bsky.social';

const els = {};

async function boot({ storage = {}, local = {}, BSKY = [], chamadas = [], cenario = {} } = {}) {
  for (const k of Object.keys(els)) delete els[k];
  const corpo = fakeEl({ rows: [] });
  corpo.replaceChildren = (...trs) => { corpo.rows = trs; };   // guarda as linhas para inspeção
  const el = id => els[id] ??= fakeEl({
    id, value: PADRAO[id] ?? '', hidden: OCULTOS.has(id), disabled: false,
    textContent: TEXTO[id] ?? '', tBodies: [corpo],
  });
  globalThis.document = { getElementById: el, createElement: () => fakeEl() };
  globalThis.localStorage = {
    getItem: k => local[k] ?? null,
    setItem: (k, v) => local[k] = String(v),
    removeItem: k => delete local[k],
  };
  globalThis.sessionStorage = {
    getItem: k => storage[k] ?? null,
    setItem: (k, v) => storage[k] = String(v),
    removeItem: k => delete storage[k],
  };
  globalThis.BSKY = BSKY;
  globalThis.confirm = () => cenario.confirmar !== false;
  const copiado = [];
  // o navigator do Node só tem getter, então a substituição é por defineProperty
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: t => (copiado.push(t), Promise.resolve()) } },
  });
  // o app loga o erro tecnico de proposito; aqui ele vira dado, nao ruido na saida
  const erros = [];
  globalThis.console = { ...console, error: e => erros.push(e) };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const path = u.pathname.split('/').pop();
    chamadas.push(path);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const json = d => new Response(JSON.stringify(d), { status: 200 });
    const vencido = () => new Response(
      JSON.stringify({ error: 'ExpiredToken', message: 'Token has expired' }), { status: 400 });

    // token vencido até alguém renovar
    if (cenario.tokenVencido && path.startsWith('app.bsky.')) return vencido();
    if (path === 'com.atproto.server.refreshSession') {
      if (cenario.refreshQuebrado) return vencido();
      cenario.tokenVencido = false;
      return json({ did: 'd1', handle: 'um.bsky.social', accessJwt: 'renovado', refreshJwt: 'r2' });
    }
    if (path === 'com.atproto.server.createSession') {
      if (body.password === 'senha-errada')
        return new Response(JSON.stringify({ message: 'senha invalida' }), { status: 401 });
      cenario.tokenVencido = false;   // login novo => token válido de novo
      return json({ did: 'did:plc:' + body.identifier, handle: body.identifier, accessJwt: 'novo', refreshJwt: 'r' });
    }
    if (path === 'app.bsky.feed.searchPostsV2') {
      cenario.paramsRecentes = Object.fromEntries(u.searchParams);
      cenario.idiomasRecentes = u.searchParams.getAll('languages');
      return json({ posts: PERFIS.map((p, i) => ({
        uri: `at://${did(p)}/app.bsky.feed.post/recente${i}`,
        author: { did: did(p), handle: handle(p), displayName: 'User ' + p.n },
        indexedAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
        record: { text: 'post recente de ' + handle(p), langs: i === 1 ? ['pt-BR'] : i === 2 ? ['en'] : ['pt'] },
      })), ...(cenario.cursorRecentes && { cursor: 'ainda-tem' }) });
    }
    if (path === 'app.bsky.feed.searchPosts')
      return json({ posts: PERFIS.map((p, i) => ({
        uri: `at://${did(p)}/app.bsky.feed.post/p${i}`,
        author: { did: did(p), handle: handle(p), displayName: 'User ' + p.n },
        indexedAt: `2026-07-2${i}T10:00:00Z`,
        record: { text: 'post de ' + handle(p) },
      })), ...(cenario.cursorPosts && { cursor: 'ainda-tem' }) });
    if (path === 'app.bsky.actor.getProfiles') {
      let pedidos = u.searchParams.getAll('actors');
      // simula a API omitindo um perfil do lote, só na primeira vez que ele é pedido
      if (cenario.omitir && pedidos.includes(cenario.omitir)) {
        pedidos = pedidos.filter(d => d !== cenario.omitir);
        cenario.omitir = null;
      }
      return json({ profiles: PERFIS.filter(p => pedidos.includes(did(p))).map(p => ({
        did: did(p), handle: handle(p),
        displayName: p.nome ?? 'User ' + p.n, description: p.bio,
        followersCount: p.seguidores, followsCount: p.seguindo,
        viewer: {
          ...(p.seguindoJa && { following: p.seguindoJa }),
          ...(p.meSegue && { followedBy: 'at://y/app.bsky.graph.follow/me' }),
        },
      })) });
    }
    if (path === 'app.bsky.graph.getFollowers') {
      if (u.searchParams.get('actor') !== 'alvo.bsky.social')
        return new Response(JSON.stringify({
          error: 'InvalidRequest', message: 'Actor not found: ' + u.searchParams.get('actor'),
        }), { status: 400 });
      // 2 páginas: força o uso do cursor
      const pagina = u.searchParams.get('cursor') ? PERFIS.slice(2) : PERFIS.slice(0, 2);
      return json({
        followers: pagina.map(p => ({ did: did(p), handle: handle(p), displayName: 'User ' + p.n })),
        cursor: cenario.cursorSeguidores ? 'ainda-tem'
          : u.searchParams.get('cursor') ? undefined : 'pag2',
      });
    }
    if (path === 'app.bsky.actor.searchActors') {
      // difuso de propósito: o 3º nao tem o termo em lugar nenhum, como a API real faz
      return json({ actors: [
        { did: 'did:plc:a', handle: handle(PERFIS[0]), displayName: 'User a',
          description: 'Fotógrafo de casamento em SP' },
        { did: 'did:plc:b', handle: handle(PERFIS[1]), displayName: 'User b',
          description: 'fotografo de CASAMENTO, orçamento no direct' },
        { did: 'did:plc:c', handle: handle(PERFIS[2]), displayName: 'User c',
          description: 'memes e futebol' },
        { did: 'did:plc:z', handle: 'perigoso.bsky.social',
          displayName: '<img src=x onerror="alert(1)">',
          description: 'fotógrafo de casamento <script>alert(2)</script>' },
      ], ...(cenario.cursorBio && { cursor: 'ainda-tem' }) });
    }
    if (path === 'app.bsky.actor.getProfile')
      return json({ did: u.searchParams.get('actor'), handle: 'um.bsky.social',
                    followersCount: 42, followsCount: 1861 - (cenario.desfeitos ?? 0) });
    if (path === 'com.atproto.repo.listRecords') {
      const rec = p => ({ uri: `at://me/app.bsky.graph.follow/${p.n}`,
                          value: { subject: did(p), createdAt: p.seguidoEm } });
      // nunca acaba: simula seguir mais gente do que o teto de páginas
      if (cenario.cursorInfinito)
        return json({ records: PERFIS.map(rec), cursor: 'sempre-tem-mais' });
      // 2 páginas, para exercitar o cursor
      const pagina = u.searchParams.get('cursor') ? PERFIS.slice(2) : PERFIS.slice(0, 2);
      return json({
        records: pagina.map(rec),
        cursor: u.searchParams.get('cursor') ? undefined : 'pag2',
      });
    }
    if (path === 'app.bsky.feed.getAuthorFeed') {
      const p = PERFIS.find(x => did(x) === u.searchParams.get('actor'));
      if (p && cenario.falhaAtividade === did(p))
        return new Response(JSON.stringify({ message: 'falha simulada' }), { status: 503 });
      const i = PERFIS.indexOf(p);
      // topo do feed é um repost: a data que vale é a do repost, não a do post
      if (p.repostouPorUltimo)
        return json({ feed: [{
          reason: { $type: 'app.bsky.feed.defs#reasonRepost', indexedAt: '2026-06-26T06:15:52Z' },
          post: { indexedAt: '2026-06-25T21:57:19Z' },
        }] });
      return json({ feed: [{ post: { indexedAt: p.ultimoPostEm ?? `2026-07-1${i}T08:00:00Z` } }] });
    }
    if (path === 'com.atproto.repo.createRecord') {
      if (cenario.followFalha === body.record.subject)
        return new Response(JSON.stringify({ error: 'RateLimitExceeded', message: 'limite simulado' }), { status: 429 });
      return json({ uri: 'at://me/app.bsky.graph.follow/novo' });
    }
    if (path === 'com.atproto.repo.deleteRecord') {
      cenario.desfeitos = (cenario.desfeitos ?? 0) + 1;   // o servidor passa a contar um a menos
      return json({});
    }
    return new Response('{}', { status: 404 });
  };
  await import('./boot.mjs?v=' + Math.random());
  return { chamadas, storage, local, els, el, copiado };
}

const CFG = [
  { handle: 'um.bsky.social', appPassword: 'p1' },
  { handle: '@dois.bsky.social', appPassword: 'p2' },
  { handle: 'ruim.bsky.social', appPassword: 'senha-errada' },
];
const SALVAS = {
  'um.bsky.social': { did: 'd1', handle: 'um.bsky.social', accessJwt: 'a1', refreshJwt: 'r1' },
  'dois.bsky.social': { did: 'd2', handle: 'dois.bsky.social', accessJwt: 'a2', refreshJwt: 'r2' },
};

// 1) reload: sessões salvas + conta ativa escolhida antes
{
  const storage = { bsky: JSON.stringify(SALVAS), ativa: 'dois.bsky.social' };
  const r = await boot({ storage, BSKY: CFG });
  assert.deepEqual(r.chamadas.filter(c => c.includes('Session')), ['com.atproto.server.createSession'],
    'só a conta sem sessão deve relogar');
  assert.equal(r.storage.ativa, 'dois.bsky.social', 'a conta ativa escolhida deve ser mantida');
  assert.equal(r.els.contaSel.value, 'dois.bsky.social', 'o seletor deve mostrar a conta ativa');
  assert.equal(JSON.parse(r.storage.bsky)['dois.bsky.social'].accessJwt, 'a2', 'token salvo intacto');
  console.log('ok 1 - reload nao reloga contas ja salvas e mantem a ativa');
}

// 2) primeira abertura: nenhuma sessão salva
{
  const r = await boot({ BSKY: CFG });
  assert.equal(r.chamadas.filter(c => c.includes('Session')).length, 3, 'deve tentar login nas 3 contas do config');
  assert.equal(r.storage.ativa, 'um.bsky.social', 'sem escolha previa, assume a 1a do config');
  assert.deepEqual(Object.keys(JSON.parse(r.storage.bsky)), ['um.bsky.social', 'dois.bsky.social'],
    'a conta com senha errada nao entra na lista');
  assert.match(r.els.status.textContent, /ruim\.bsky\.social/, 'a falha deve ser reportada');
  console.log('ok 2 - loga todas do config, ignora a que falhou, ativa = 1a');
}

// 3) migração do formato antigo (conta única)
{
  const antigo = { did: 'dv', handle: 'velho.bsky.social', accessJwt: 'av', refreshJwt: 'rv' };
  const r = await boot({ storage: { bsky: JSON.stringify(antigo) } });
  assert.deepEqual(r.chamadas.filter(c => c.includes('Session')), [], 'nao deve relogar');
  assert.equal(r.els.contaSel.value, 'velho.bsky.social', 'sessao antiga vira conta ativa');
  console.log('ok 3 - sessao no formato antigo e migrada');
}

// 4) config vazio e sem sessão: cai no formulário
{
  const r = await boot({ BSKY: [{ handle: '', appPassword: '' }] });
  assert.deepEqual(r.chamadas, [], 'campos vazios nao viram tentativa de login');
  assert.equal(r.els.login.hidden, false, 'formulario de login visivel');
  console.log('ok 4 - config vazio cai no formulario sem chamar a rede');
}

// 5) busca -> contagens -> filtros -> limite
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;   // cria o elemento sob demanda, como getElementById
  e('sort').value = 'last-desc';   // default do <select> no HTML
  const campos = { segMin: '', segMax: '', sguMin: '', sguMax: '', maxPerfis: '' };
  const aplicar = v => {
    Object.assign(campos, v);
    for (const k in campos) e(k).value = campos[k];
    e('filtros').oninput();
  };
  aplicar({});

  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'sem filtro, lista todos');
  assert.deepEqual(JSON.parse(r.local.hist), ['teste'], 'termo entra no historico persistente');

  aplicar({ segMin: 500, segMax: 1000 });
  assert.equal(e('status').textContent, '1 de 3 perfis.', 'so o perfil de 750 seguidores passa');

  aplicar({ segMin: '', segMax: '', sguMax: 100 });
  assert.equal(e('status').textContent, '2 de 3 perfis.', 'filtro de seguindo tambem funciona');

  aplicar({ sguMax: '', maxPerfis: 2 });
  assert.equal(e('status').textContent, '2 de 3 perfis no filtro (3 encontrados).', 'limite corta a lista');

  aplicar({ segMin: 5000, maxPerfis: 2 });
  assert.equal(e('status').textContent, '1 de 3 perfis.', 'limite maior que o filtro nao mente na contagem');

  aplicar({ segMin: '', maxPerfis: '' });
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'limpar tudo volta a lista inteira');
  console.log('ok 5 - busca, filtros de seguidores/seguindo e limite de perfis');
}

// 6) modo "seguidores de": mesma tabela, mesmos filtros, outra fonte
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';

  e('modo').value = 'seguidores';
  e('modo').onchange();
  assert.match(e('q').placeholder, /@ do perfil/, 'o placeholder pede o perfil, sem jargao');
  assert.match(e('ajudaModo').textContent, /segue o perfil/i, 'a linha de ajuda explica o modo');

  e('q').value = '@alvo.bsky.social';   // o @ deve ser aceito
  await e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'as 2 paginas de seguidores viram linhas');
  assert.equal(r.chamadas.filter(c => c === 'app.bsky.graph.getFollowers').length, 2, 'seguiu o cursor');
  assert.ok(r.chamadas.includes('app.bsky.actor.getProfiles'), 'busca as contagens');
  assert.ok(r.chamadas.includes('app.bsky.feed.getAuthorFeed'), 'busca o ultimo post');

  e('segMin').value = 500; e('segMax').value = 1000; e('filtros').oninput();
  assert.equal(e('status').textContent, '1 de 3 perfis.', 'filtro de seguidores vale aqui tambem');

  // ordenar por "post encontrado" não faz sentido sem post: o modo corrige
  e('sort').value = 'match-desc';
  e('modo').onchange();
  assert.equal(e('sort').value, 'last-desc', 'volta para ordenacao por ultimo post');

  // handle inexistente não pode derrubar a tela: mensagem em português na tela,
  // e o detalhe da API preservado no title para quem for depurar
  e('q').value = 'nao-existe.bsky.social';
  await e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('status').textContent, 'Perfil não encontrado. Confira o @ digitado.',
    'a tela nao pode falar em codigo HTTP nem em nome de endpoint');
  assert.match(e('status').title, /Actor not found: nao-existe\.bsky\.social/,
    'o motivo tecnico continua acessivel');
  assert.equal(e('btnBuscar').disabled, false, 'o botao volta a funcionar depois do erro');
  console.log('ok 6 - modo seguidores pagina, filtra e trata handle invalido');
}

// 7) o que se cola no campo vira um ator válido
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('modo').value = 'seguidores';

  for (const entrada of [
    'alvo.bsky.social',
    '@alvo.bsky.social',
    '  ALVO.bsky.social  ',
    'https://bsky.app/profile/alvo.bsky.social',
    'bsky.app/profile/alvo.bsky.social/',
  ]) {
    e('q').value = entrada;
    await e('search').onsubmit({ preventDefault() {} });
    assert.equal(e('status').textContent, '3 de 3 perfis.', `deveria aceitar: ${entrada}`);
  }
  console.log('ok 7 - aceita @, espacos, maiusculas e a URL do perfil');
}

// 8) token vencido (400 ExpiredToken, não 401) tem que renovar sozinho
{
  const r = await boot({
    storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
    cenario: { tokenVencido: true },
  });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  assert.ok(r.chamadas.includes('com.atproto.server.refreshSession'), 'deveria ter renovado o token');
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'a busca segue depois de renovar');
  assert.equal(JSON.parse(r.storage.bsky)['um.bsky.social'].accessJwt, 'renovado', 'token novo salvo');
  console.log('ok 8 - 400 ExpiredToken dispara a renovacao e a busca continua');
}

// 9) refresh também vencido: reloga pelo config.js, ou explica o erro
{
  // cenário novo a cada boot: o stub muta esse objeto
  const base = () => ({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
                        cenario: { tokenVencido: true, refreshQuebrado: true } });
  const buscar = async r => {
    const e = r.el;
    e('sort').value = 'last-desc';
    for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
    e('q').value = 'teste';
    await e('search').onsubmit({ preventDefault() {} });
    return e;
  };

  const comConfig = await buscar(await boot({ ...base(), BSKY: [{ handle: '@UM.bsky.social', appPassword: 'p1' }] }));
  assert.equal(comConfig('status').textContent, '3 de 3 perfis.', 'com a senha no config, refaz o login sozinho');

  const semConfig = await buscar(await boot(base()));
  assert.equal(semConfig('status').textContent, 'Sua sessão expirou. Entre novamente.',
    'sem config, a tela explica o que fazer');
  assert.match(semConfig('status').title, /Token has expired/, 'e o motivo tecnico fica no title');
  console.log('ok 9 - refresh vencido reloga pelo config, ou explica o erro');
}

// 10) handle digitado no modo "quem postou": busca mesmo assim, mas avisa
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';

  e('modo').value = 'posts';
  e('q').value = '@caramelopromocao.bsky.social';
  await e('search').onsubmit({ preventDefault() {} });
  assert.match(e('status').textContent, /seguidores de/, 'deve sugerir o outro modo');
  assert.match(e('status').textContent, /^3 de 3 perfis\./, 'sem deixar de fazer a busca pedida');

  e('q').value = 'promoção de caramelo';
  await e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'frase normal nao dispara o aviso');

  e('modo').value = 'seguidores';
  e('q').value = 'alvo.bsky.social';
  await e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('status').textContent, '3 de 3 perfis.', 'no modo certo nao ha o que avisar');
  console.log('ok 10 - avisa quando um handle e buscado como texto');
}

// 11) "sigo, mas não me seguem": lista só quem não retribui, com a data em que segui
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';   // default do <select> no HTML
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';

  e('modo').value = 'naoSeguem';
  e('modo').onchange();
  assert.equal(e('q').disabled, true, 'o campo de texto nao serve nesse modo');
  assert.equal(e('sort').value, 'seguido-desc', 'sem ultimo post, a ordenacao padrao vira "seguido em"');

  await e('search').onsubmit({ preventDefault() {} });
  // dos 3 que sigo, só o "b" me segue de volta
  assert.match(e('status').textContent, /^2 de 2 perfis\./, 'quem me segue de volta sai da lista');
  assert.equal(r.chamadas.filter(c => c === 'com.atproto.repo.listRecords').length, 2, 'seguiu o cursor');
  assert.ok(!r.storage.hist, 'modo sem termo nao suja o historico');

  // o último post não é usado nesse modo: nenhuma chamada por perfil
  assert.equal(r.chamadas.filter(c => c === 'app.bsky.feed.getAuthorFeed').length, 0,
    'nao pode gastar 1 requisicao por perfil com um dado que a tela nao mostra');

  // a data em que segui tem que estar disponível para ordenar
  e('sort').value = 'seguido-asc';
  e('sort').onchange();
  assert.match(e('status').textContent, /^2 de 2 perfis\./, 'ordenar por "seguido em" nao quebra');

  // os filtros de sempre continuam valendo
  e('segMin').value = 1000; e('filtros').oninput();
  assert.equal(e('status').textContent, '1 de 2 perfis.', 'filtro de seguidores vale aqui tambem');
  console.log('ok 11 - lista quem nao me segue de volta, com a data do follow');
}

// 12) trocar de modo não deixa uma ordenação sem sentido para trás
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'seguido-desc';
  e('modo').value = 'posts';
  e('modo').onchange();
  assert.equal(e('sort').value, 'last-desc', '"seguido em" so existe no modo naoSeguem');
  assert.equal(e('q').disabled, false, 'o campo volta a ser usavel');
  console.log('ok 12 - ordenacao e campo se ajustam ao trocar de modo');
}

// 13) perfil que a API não devolveu não pode virar "não me segue"
{
  // "b" me segue de volta; se o lote vier sem ele, a 2a tentativa tem que resgatá-lo
  const r = await boot({
    storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
    cenario: { omitir: 'did:plc:b' },
  });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('modo').value = 'naoSeguem';
  await e('search').onsubmit({ preventDefault() {} });
  assert.match(e('status').textContent, /^2 de 2 perfis\./,
    'quem me segue nao pode entrar na lista so porque o lote veio incompleto');
  assert.ok(!/ficaram de fora/.test(e('status').textContent), 'a 2a tentativa resgatou o perfil');
  assert.ok(r.chamadas.filter(c => c === 'app.bsky.actor.getProfiles').length >= 2, 'houve 2a tentativa');
  console.log('ok 13 - perfil faltando no lote e buscado de novo, nao vira falso positivo');
}

// 14) deixar de seguir em massa age só sobre o que está listado
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });

  // só "b" é seguido; o botão conta apenas ele
  assert.equal(e('unfollowTodos').hidden, false, 'botao aparece quando ha quem deixar de seguir');
  assert.match(e('unfollowTodos').textContent, /^Deixar de seguir os 1 /, 'conta so os que sigo');

  // o limite da tela é a seleção: com 0 listados, nada a fazer
  e('maxPerfis').value = 1; e('filtros').oninput();
  const soUm = e('unfollowTodos').textContent;

  e('maxPerfis').value = ''; e('filtros').oninput();
  await e('unfollowTodos').onclick();
  assert.equal(r.chamadas.filter(c => c === 'com.atproto.repo.deleteRecord').length, 1,
    'uma remocao por perfil seguido, e so');
  assert.match(e('status').textContent, /1 desfeitos/, 'reporta o resultado');
  assert.match(e('contaNums').textContent, /seguindo 1\.860 /,
    'o contador da barra tem que refletir o que acabou de ser desfeito');
  assert.equal(e('unfollowTodos').hidden, true, 'sem mais ninguem para desseguir, o botao some');
  assert.ok(soUm, 'o texto do botao acompanha o filtro');
  console.log('ok 14 - desseguir em massa respeita a lista visivel e reporta');
}

// 15) recusar a confirmação não muda nada
{
  const r = await boot({
    storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
    cenario: { confirmar: false },
  });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  await e('unfollowTodos').onclick();
  assert.equal(r.chamadas.filter(c => c === 'com.atproto.repo.deleteRecord').length, 0,
    'cancelar no confirm nao pode remover nada');
  console.log('ok 15 - cancelar a confirmacao nao desfaz nenhum follow');
}

// 16) contadores da conta logada e denominador do modo naoSeguem
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  assert.match(e('contaNums').textContent, /seguindo 1\.861 · seguidores 42/,
    'a barra mostra os numeros da propria conta');

  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('modo').value = 'naoSeguem';
  await e('search').onsubmit({ preventDefault() {} });
  // 3 follows lidos, 1 me segue de volta => 2 na lista, mas o total lido tem que aparecer
  assert.match(e('status').textContent, /^2 de 2 perfis\. 3 lidos dos que você segue\.$/,
    'o status precisa dizer de quantos partiu');
  assert.ok(!/teto/.test(e('status').textContent), 'sem truncamento, sem aviso de teto');
  console.log('ok 16 - contadores da conta e denominador do modo naoSeguem');
}

// 17) parar no teto de follows tem que ser dito, não silencioso
{
  const r = await boot({
    storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
    cenario: { cursorInfinito: true },
  });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('modo').value = 'naoSeguem';
  await e('search').onsubmit({ preventDefault() {} });
  assert.match(e('status').textContent, /parei no teto, há mais/, 'truncar em silencio esconde o problema');
  console.log('ok 17 - avisa quando para no teto de follows');
}

// 18) texto e classe do botão têm que andar juntos, nos dois sentidos
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });

  const btn = { dataset: { did: 'did:plc:b' }, textContent: '', className: '', disabled: false };
  const clicar = () => e('t').tBodies[0].onclick({ target: { closest: () => btn } });

  await clicar();   // "b" era seguido: vira Seguir
  assert.equal(btn.textContent, 'Seguir');
  assert.equal(btn.className, 'seguir', 'Seguir usa a classe seguir');

  await clicar();   // e volta
  assert.equal(btn.textContent, 'Seguindo');
  assert.equal(btn.className, 'seguindo', 'Seguindo usa a classe seguindo');
  console.log('ok 18 - classe do botao acompanha o texto nos dois estados');
}

// 19) quando a última atividade é um repost, a data é a do repost e vem marcada
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });

  const linhas = e('t').tBodies[0].rows;
  const doRepost = linhas.find(tr => tr.innerHTML.includes('did:plc:c'));
  const semRepost = linhas.find(tr => tr.innerHTML.includes('did:plc:a'));

  // 26/06/2026 06:15 UTC = 03:15 em Brasília, e é a data do repost, não a do post (25/06)
  assert.match(doRepost.innerHTML, /26\/06\/2026/, 'usa a data do repost');
  assert.ok(!doRepost.innerHTML.includes('25/06/2026'), 'nao usa a data do post original');
  assert.match(doRepost.innerHTML, /\(repost\)/, 'precisa dizer que a data veio de um repost');
  assert.ok(!semRepost.innerHTML.includes('(repost)'), 'post proprio nao leva a marca');
  console.log('ok 19 - data de repost vem marcada, para nao parecer divergente do perfil');
}

// 20) filtro percentual: seguidores dentro de X% do seguindo
{
  // o exemplo pedido: segue 500, então 10% aceita de 450 a 550
  PERFIS.push(
    { n: 'd', seguidores: 550, seguindo: 500, seguidoEm: '2026-05-01T00:00:00Z' },  // na borda: passa
    { n: 'x', seguidores: 560, seguindo: 500, seguidoEm: '2026-05-02T00:00:00Z' },  // 60 de folga: nao
  );
  try {
    const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
    const e = r.el;
    e('sort').value = 'last-desc';
    for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct']) e(k).value = '';
    e('q').value = 'teste';
    await e('search').onsubmit({ preventDefault() {} });
    assert.equal(e('status').textContent, '5 de 5 perfis.', 'sem o filtro, todos passam');

    const handles = () => e('t').tBodies[0].rows.map(tr => tr.innerHTML.match(/@([\w.]+)/)[1]);

    e('difPct').value = 10; e('filtros').oninput();
    assert.deepEqual(handles(), ['d.bsky.social'], '10% de 500 aceita 550, mas nao 560');

    // b: segue 900, tem 750 seguidores => 150 de diferenca = 16,67%
    e('difPct').value = 16; e('filtros').oninput();
    assert.ok(!handles().includes('b.bsky.social'), '16% de 900 sao 144, menos que a diferenca de 150');
    e('difPct').value = 17; e('filtros').oninput();
    assert.ok(handles().includes('b.bsky.social'), '17% de 900 sao 153, acima da diferenca de 150');

    e('difPct').value = ''; e('filtros').oninput();
    assert.equal(e('status').textContent, '5 de 5 perfis.', 'campo vazio volta a nao filtrar');
    console.log('ok 20 - filtro percentual entre seguidores e seguindo');
  } finally {
    PERFIS.length = 3;
  }
}

// 21) data inicial do último post
{
  // Os dois lados da borda, em horário local. Juntos, denunciam a comparação sem fuso
  // em qualquer TZ: à frente de UTC "m" seria excluído; atrás, "n" entraria indevidamente.
  const meiaNoite = new Date('2026-07-05T00:00');
  PERFIS.push(
    { n: 'm', seguidores: 10, seguindo: 10, seguidoEm: '2026-05-01T00:00:00Z',
      ultimoPostEm: meiaNoite.toISOString() },
    { n: 'n', seguidores: 10, seguindo: 10, seguidoEm: '2026-05-02T00:00:00Z',
      ultimoPostEm: new Date(meiaNoite.getTime() - 3600e3).toISOString() },
  );
  try {
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  // a: 10/07 · b: 11/07 · c: repost em 26/06 · m: 05/07 00:00 · n: 04/07 23:00
  assert.equal(e('status').textContent, '5 de 5 perfis.', 'sem data, todos passam');

  const quantos = () => +e('status').textContent.match(/^(\d+)/)[1];
  const listados = () => e('t').tBodies[0].rows.map(tr => tr.innerHTML.match(/@([\w.]+)/)[1]);

  e('desdeUltimo').value = '2026-07-01'; e('filtros').oninput();
  assert.equal(quantos(), 4, 'corta quem so tem atividade de junho');

  e('desdeUltimo').value = '2026-07-05'; e('filtros').oninput();
  assert.ok(listados().includes('m.bsky.social'), 'inclusiva: quem postou 00:00 do dia escolhido fica');
  assert.ok(!listados().includes('n.bsky.social'), 'quem postou 23:00 da vespera fica de fora');
  assert.equal(quantos(), 3, 'sobram os tres a partir do dia 05');

  e('desdeUltimo').value = '2026-07-11'; e('filtros').oninput();
  assert.equal(quantos(), 1, 'sobra so o do dia 11');

  e('desdeUltimo').value = '2026-08-01'; e('filtros').oninput();
  assert.equal(quantos(), 0, 'data no futuro nao deixa ninguem passar');

  e('desdeUltimo').value = ''; e('filtros').oninput();
  assert.equal(quantos(), 5, 'campo vazio volta a nao filtrar');

  // no modo sem último post o campo tem que se desligar, nao esvaziar a lista
  e('modo').value = 'naoSeguem';
  e('desdeUltimo').value = '2026-07-01';
  e('modo').onchange();
  assert.equal(e('desdeUltimo').disabled, true, 'campo desligado onde nao ha ultimo post');
  assert.equal(e('desdeUltimo').value, '', 'e o valor antigo nao pode continuar filtrando');
  console.log('ok 21 - filtro por data inicial do ultimo post');
  } finally { PERFIS.length = 3; }
}

// 22) busca por termo na bio
{
  PERFIS.push({ n: 'z', seguidores: 1, seguindo: 1, seguidoEm: '2026-05-03T00:00:00Z',
                nome: '<img src=x onerror="alert(1)">',
                bio: 'fotógrafo de casamento <script>alert(2)</script>' });
  try {
    const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
    const e = r.el;
    e('sort').value = 'last-desc';
    for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';

    e('modo').value = 'bio';
    e('modo').onchange();
    assert.equal(e('q').disabled, false, 'esse modo usa o campo de texto');

    e('q').value = 'fotografo de casamento';   // sem acento, minusculo
    await e('search').onsubmit({ preventDefault() {} });

    // 4 vieram da API, mas "memes e futebol" nao tem o termo na bio
    assert.equal(e('status').textContent, '3 de 3 perfis.', 'o resultado difuso da API tem que ser conferido');
    const html = e('t').tBodies[0].rows.map(tr => tr.innerHTML).join('');
    assert.ok(!html.includes('c.bsky.social'), 'quem nao tem o termo na bio fica fora');
    assert.ok(html.includes('Fotógrafo de casamento em SP'), 'a bio aparece para conferencia');
    assert.ok(html.includes('did:plc:z'), 'o perfil com nome perigoso tem que estar na lista');

    // acento e caixa nao podem separar "Fotógrafo" de "fotografo"
    assert.ok(html.includes('a.bsky.social') && html.includes('b.bsky.social'),
      'acento e maiuscula nao podem impedir o casamento do termo');

    // nome e bio vem de terceiros: nao podem virar HTML
    assert.ok(!html.includes('<img src=x'), 'displayName nao pode injetar tag');
    assert.ok(!html.includes('<script>'), 'bio nao pode injetar script');
    assert.ok(html.includes('&lt;img src=x'), 'o texto perigoso aparece escapado');
    console.log('ok 22 - busca na bio confere o termo e escapa conteudo de terceiros');
  } finally { PERFIS.length = 3; }
}

// 23) a interface se explica sozinha e não engana
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;

  // ao entrar, o modo padrão já vem explicado — sem precisar clicar em nada
  assert.equal(e('modo').value, 'posts', 'comeca no modo mais comum');
  assert.equal(e('ajudaModo').hidden, false, 'a ajuda aparece de cara');
  assert.match(e('ajudaModo').textContent, /Procura o termo nos posts/, 'e diz o que a busca faz');
  assert.equal(e('filtrosAtivos').textContent, '(nenhum)', 'o resumo dos filtros comeca zerado');

  // o contador de filtros conta o que está preenchido e valendo
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
  e('segMin').value = 100; e('difPct').value = 10; e('filtros').oninput();
  assert.equal(e('filtrosAtivos').textContent, '(2 ativos)', 'dois filtros preenchidos, dois contados');

  // trocar para um modo que não usa a data limpa o campo — e o resumo acompanha,
  // senão diria "3 ativos" com um filtro que não está mais valendo
  e('desdeUltimo').value = '2026-07-01'; e('filtros').oninput();
  assert.equal(e('filtrosAtivos').textContent, '(3 ativos)', 'tres enquanto o campo vale');
  e('modo').value = 'naoSeguem'; e('modo').onchange();
  assert.equal(e('desdeUltimo').value, '', 'a data e limpa no modo que nao a usa');
  assert.equal(e('filtrosAtivos').textContent, '(2 ativos)', 'e sai da conta junto');

  // as ordens sem sentido para o modo somem, em vez de trocar a escolha por baixo
  const escondidas = () => e('sort').options.filter(o => o.hidden).map(o => o.value);
  e('sort').options = [
    { value: 'last-desc', hidden: false }, { value: 'match-desc', hidden: false },
    { value: 'seguido-desc', hidden: false },
  ];
  e('modo').onchange();
  assert.deepEqual(escondidas(), ['last-desc', 'match-desc'], 'em naoSeguem so sobra "seguido em"');
  e('modo').value = 'posts'; e('modo').onchange();
  assert.deepEqual(escondidas(), ['seguido-desc'], 'em posts some o "seguido em"');

  // durante a busca o botão trava: dois cliques dariam duas buscas concorrentes
  e('q').value = 'teste';
  const emAndamento = e('search').onsubmit({ preventDefault() {} });
  assert.equal(e('btnBuscar').disabled, true, 'travado enquanto busca');
  assert.equal(e('btnBuscar').textContent, 'Buscando…', 'e diz que esta trabalhando');
  await emAndamento;
  assert.equal(e('btnBuscar').disabled, false, 'liberado ao terminar');
  assert.equal(e('btnBuscar').textContent, 'Buscar', 'com o texto de volta');
  console.log('ok 23 - ajuda por modo, resumo de filtros, ordens validas e botao travado');
}

// 24) script para copiar: precisa casar com os botões que a própria página gera
{
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' } });
  const e = r.el;
  assert.equal(e('scriptBox').hidden, false, 'aparece junto com a busca');

  await e('copiarScript').onclick();
  const copiado = r.copiado[0];
  assert.equal(r.copiado.length, 1, 'copiou uma vez');
  assert.match(copiado, /clicarEmTodosSeguir\(\);\s*$/, 'copia o script inteiro, ate a chamada final');
  assert.ok(!/&lt;|&gt;|&amp;/.test(copiado), 'sem escape de HTML sobrando no texto copiado');
  assert.equal(e('copiarScript').textContent, '✓ copiado', 'confirma para quem clicou');

  // o seletor do script tem que encontrar os botões reais da tabela
  const seletor = copiado.match(/querySelectorAll\(\s*'([^']+)'/)?.[1]
    ?? copiado.match(/querySelectorAll\(\s*\n?\s*'([^']+)'/)?.[1];
  assert.ok(seletor, 'o script precisa ter um seletor');

  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  const naoSeguido = e('t').tBodies[0].rows
    .map(tr => tr.innerHTML).find(h => h.includes('did:plc:a'));

  const [, classe, prefixoDid] = seletor.match(/button\.(\w+)\[data-did\^="([^"]+)"\]/);
  assert.match(naoSeguido, new RegExp(`class="${classe}"`),
    `o botao de seguir precisa ter a classe "${classe}" que o script procura`);
  assert.match(naoSeguido, new RegExp(`data-did="${prefixoDid}`),
    'e o data-did no formato que o script espera');
  assert.match(copiado, /dataset\.resultado/, 'espera o resultado real de cada clique');
  assert.match(copiado, /feitos.*erros/s, 'contabiliza sucessos e falhas');
  console.log('ok 24 - script copiavel espera e contabiliza o resultado real');
}

// 25) tokens antigos persistentes migram para a sessão da aba e são apagados
{
  const local = { bsky: JSON.stringify(SALVAS), ativa: 'dois.bsky.social' };
  const r = await boot({ local });
  assert.equal(r.storage.ativa, 'dois.bsky.social', 'mantem a conta ativa ao migrar');
  assert.ok(r.storage.bsky, 'tokens passam para sessionStorage');
  assert.equal(r.local.bsky, undefined, 'tokens saem do localStorage persistente');
  assert.equal(r.local.ativa, undefined, 'a conta ativa persistente tambem sai');
  console.log('ok 25 - tokens persistentes migram para a sessao temporaria da aba');
}

// 26) todos os modos paginados avisam quando ainda havia cursor no teto
{
  const casos = [
    ['posts', { cursorPosts: true }, /limite de 300 posts/],
    ['recentes', { cursorRecentes: true }, /limite de 300 posts recentes/],
    ['seguidores', { cursorSeguidores: true }, /limite de 500 seguidores/],
    ['bio', { cursorBio: true }, /limite de 500 perfis candidatos/],
  ];
  for (const [modo, cenario, aviso] of casos) {
    const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' }, cenario });
    const e = r.el;
    e('sort').value = 'last-desc';
    for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
    e('modo').value = modo;
    e('modo').onchange();
    if (modo === 'recentes') e('minutos').value = '30';
    e('q').value = modo === 'seguidores' ? 'alvo.bsky.social'
      : modo === 'bio' ? 'fotografo de casamento' : 'teste';
    await e('search').onsubmit({ preventDefault() {} });
    assert.match(e('status').textContent, aviso, `${modo} nao pode truncar em silencio`);
  }
  console.log('ok 26 - buscas paginadas avisam quando atingem o teto');
}

// 27) erro na atividade não se disfarça de perfil sem post
{
  const r = await boot({
    storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' },
    cenario: { falhaAtividade: 'did:plc:a' },
  });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
  e('q').value = 'teste';
  await e('search').onsubmit({ preventDefault() {} });
  assert.match(e('status').textContent, /atividade de 1 perfil/, 'o resumo conta a falha');
  const html = e('t').tBodies[0].rows.map(tr => tr.innerHTML).join('\n');
  assert.match(html, /falha ao consultar/, 'a linha afetada fica marcada');
  console.log('ok 27 - falha de atividade fica visivel no resumo e na tabela');
}

// 28) follow em massa usa a lista filtrada, espera a escrita e não renova token em 429
{
  const executar = async cenario => {
    const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' }, cenario });
    const e = r.el;
    e('sort').value = 'last-desc';
    for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
    e('q').value = 'teste';
    await e('search').onsubmit({ preventDefault() {} });
    e('segMax').value = '200';
    e('filtros').oninput(); // sobra apenas o perfil a, ainda não seguido
    assert.match(e('followTodos').textContent, /^Seguir os 1 listados/);
    await e('followTodos').onclick();
    return { r, e };
  };

  const sucesso = await executar({});
  assert.equal(sucesso.r.chamadas.filter(c => c === 'com.atproto.repo.createRecord').length, 1);
  assert.match(sucesso.e('status').textContent, /1 seguidos/);
  assert.equal(sucesso.e('followTodos').hidden, true, 'some quando todos os visiveis foram seguidos');

  const falha = await executar({ followFalha: 'did:plc:a' });
  assert.match(falha.e('status').textContent, /0 seguidos, 1 falharam/);
  assert.equal(falha.r.chamadas.filter(c => c === 'com.atproto.server.refreshSession').length, 0,
    'rate limit nao e erro de token e nao deve relogar');
  console.log('ok 28 - follow em massa confirma sucesso e falha sem refresh indevido');
}

// 29) posts em português nos últimos X minutos, sem termo e com os filtros existentes
{
  const cenario = {};
  const r = await boot({ storage: { bsky: JSON.stringify(SALVAS), ativa: 'um.bsky.social' }, cenario });
  const e = r.el;
  e('sort').value = 'last-desc';
  for (const k of ['segMin', 'segMax', 'sguMin', 'sguMax', 'maxPerfis', 'difPct', 'desdeUltimo']) e(k).value = '';
  e('modo').value = 'recentes';
  e('modo').onchange();
  assert.equal(e('q').disabled, true, 'o modo nao exige palavra artificial');
  assert.equal(e('janelaLabel').hidden, false, 'a janela em minutos aparece');
  assert.equal(e('minutos').disabled, false, 'o campo de minutos fica ativo');
  assert.match(e('ajudaModo').textContent, /português/i, 'a ajuda explica o idioma');

  e('q').value = 'termo antigo que deve ser ignorado';
  e('minutos').value = '15';
  const antes = Date.now();
  await e('search').onsubmit({ preventDefault() {} });
  const depois = Date.now();
  assert.equal(cenario.paramsRecentes.query, undefined, 'nao envia termo na busca sem texto');
  assert.deepEqual(cenario.idiomasRecentes, ['pt'], 'filtra pelo idioma portugues');
  assert.equal(cenario.paramsRecentes.sort, 'recent', 'pede os posts mais recentes primeiro');
  const since = Date.parse(cenario.paramsRecentes.since);
  assert.ok(since >= antes - 15 * 60000 && since <= depois - 15 * 60000,
    'a janela parte de agora menos X minutos');
  assert.equal(e('status').textContent, '2 de 2 perfis.', 'descarta resultado sem marcador pt');
  assert.equal(r.local.hist, undefined, 'nao grava no historico o termo desativado');

  e('segMax').value = '200';
  e('filtros').oninput();
  assert.equal(e('status').textContent, '1 de 2 perfis.', 'os filtros existentes continuam valendo');
  console.log('ok 29 - busca posts recentes em portugues e preserva os filtros');
}

// 30) o pacote de publicação contém apenas configuração pública vazia
{
  const dist = join(import.meta.dirname, 'dist');
  await import('./prepare-publish.mjs?v=' + Math.random());
  assert.deepEqual(readdirSync(dist).sort(), ['config.js', 'index.html']);
  const cfgPublica = readFileSync(join(dist, 'config.js'), 'utf8');
  assert.match(cfgPublica, /window\.BSKY = \[\];/);
  assert.ok(!/appPassword:\s*['"][^'"]+/.test(cfgPublica), 'nenhuma app password no pacote');
  rmSync(dist, { recursive: true, force: true });
  console.log('ok 30 - publicacao gera pacote limpo sem credenciais locais');
}

rmSync(join(import.meta.dirname, 'boot.mjs'));
console.log('\ntodos passaram');
