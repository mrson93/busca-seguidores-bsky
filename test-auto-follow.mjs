import assert from 'node:assert/strict';
import { detectAdultContent, dentroDaProporcao, runAutomation } from './auto-follow.mjs';

assert.equal(dentroDaProporcao(80, 100, 20), true);
assert.equal(dentroDaProporcao(120, 100, 20), true);
assert.equal(dentroDaProporcao(79, 100, 20), false);
assert.equal(dentroDaProporcao(121, 100, 20), false);
assert.equal(dentroDaProporcao(undefined, 100, 20), false);
assert.equal(dentroDaProporcao(90, 100), true);
assert.equal(dentroDaProporcao(89, 100), false);
console.log('ok 1 - proporcao configurada inclui os limites e rejeita contagens ausentes');

const profiles = {
  'did:plc:a': { did: 'did:plc:a', handle: 'a.bsky.social', followersCount: 90, followsCount: 100, viewer: {} },
  'did:plc:b': { did: 'did:plc:b', handle: 'b.bsky.social', followersCount: 120, followsCount: 100,
    viewer: { following: 'at://me/app.bsky.graph.follow/b' } },
  'did:plc:c': { did: 'did:plc:c', handle: 'c.bsky.social', followersCount: 10, followsCount: 100, viewer: {} },
  'did:plc:d': { did: 'did:plc:d', handle: 'd.bsky.social', followersCount: 100, followsCount: 100,
    viewer: { blockedBy: true } },
};

const mock = () => {
  const calls = [];
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname.split('/').pop();
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, url, body });
    const ok = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === 'com.atproto.server.createSession')
      return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
    if (path === 'app.bsky.feed.searchPostsV2') return ok({ posts: [
      { indexedAt: '2026-08-30T12:59:00Z', author: { did: 'did:plc:a' }, record: { langs: ['pt'] } },
      { indexedAt: '2026-08-30T12:58:00Z', author: { did: 'did:plc:a' }, record: { langs: ['pt-BR'] } },
      { indexedAt: '2026-08-30T12:57:00Z', author: { did: 'did:plc:b' }, record: { langs: ['pt-BR'] } },
      { indexedAt: '2026-08-30T12:56:00Z', author: { did: 'did:plc:c' }, record: { langs: ['pt'] } },
      { indexedAt: '2026-08-30T12:55:00Z', author: { did: 'did:plc:d' }, record: { langs: ['pt'] } },
      { indexedAt: '2026-08-30T12:54:00Z', author: { did: 'did:plc:x' }, record: { langs: ['en'] } },
    ] });
    if (path === 'app.bsky.actor.getProfiles')
      return ok({ profiles: url.searchParams.getAll('actors').map(did => profiles[did]).filter(Boolean) });
    if (path === 'app.bsky.feed.getAuthorFeed') return ok({ feed: [] });
    if (path === 'com.atproto.repo.createRecord') return ok({ uri: 'at://me/app.bsky.graph.follow/new' });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchFn };
};

const account = { handle: 'eu.bsky.social', appPassword: 'app-password-de-teste' };
const now = new Date('2026-08-30T13:00:00Z');

{
  const api = mock();
  const result = await runAutomation({ account, now, fetchFn: api.fetchFn, recordHistory: false });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.ratioPct, 10);
  assert.equal(result.maxFollows, 30);
  assert.equal(result.maxPages, 20);
  assert.equal(result.pagesRead, 1);
  assert.deepEqual(result.candidates.map(item => item.handle), ['a.bsky.social']);
  assert.equal(result.followed.length, 0);
  assert.equal(api.calls.some(call => call.path === 'com.atproto.repo.createRecord'), false);
  const search = api.calls.find(call => call.path === 'app.bsky.feed.searchPostsV2').url;
  assert.equal(search.searchParams.get('languages'), 'pt');
  assert.equal(search.searchParams.get('since'), '2026-08-30T12:00:00.000Z');
  console.log('ok 2 - simulacao filtra idioma, janela, proporcao, seguidos e bloqueados');
}

{
  const api = mock();
  const result = await runAutomation({
    account, now, fetchFn: api.fetchFn, execute: true, maxFollows: 1,
    sleepFn: async () => {}, recordHistory: false,
  });
  assert.deepEqual(result.followed.map(item => item.handle), ['a.bsky.social']);
  const writes = api.calls.filter(call => call.path === 'com.atproto.repo.createRecord');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.record.subject, 'did:plc:a');
  console.log('ok 3 - execucao respeita o limite e cria o follow correto');
}

{
  const api = mock();
  const result = await runAutomation({
    account, now, fetchFn: api.fetchFn, recordHistory: false,
    excludedDids: new Set(['did:plc:a']),
  });
  assert.equal(result.candidates.length, 0);
  console.log('ok 4 - nao volta a seguir um perfil removido pela automacao');
}

const paginationMock = ({ endless = false } = {}) => {
  const calls = [];
  let page = 0;
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname.split('/').pop();
    calls.push({ path, url });
    const ok = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === 'com.atproto.server.createSession')
      return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
    if (path === 'app.bsky.feed.searchPostsV2') {
      page++;
      if (endless) return ok({
        posts: [{
          indexedAt: `2026-08-30T12:${String(60 - page).padStart(2, '0')}:00Z`,
          author: { did: `did:plc:page-${page}` }, record: { langs: ['pt'] },
        }],
        cursor: `page-${page + 1}`,
      });
      if (page === 1) return ok({
        posts: [{ indexedAt: '2026-08-30T12:50:00Z',
          author: { did: 'did:plc:inside-a' }, record: { langs: ['pt'] } }],
        cursor: 'page-2',
      });
      return ok({
        posts: [
          { indexedAt: '2026-08-30T12:00:00Z',
            author: { did: 'did:plc:inside-b' }, record: { langs: ['pt-BR'] } },
          { indexedAt: '2026-08-30T11:59:59Z',
            author: { did: 'did:plc:outside' }, record: { langs: ['pt'] } },
        ],
        cursor: 'page-3',
      });
    }
    if (path === 'app.bsky.actor.getProfiles') return ok({
      profiles: url.searchParams.getAll('actors').map(did => ({
        did, handle: did.split(':').pop() + '.bsky.social',
        followersCount: 100, followsCount: 100, viewer: {},
      })),
    });
    if (path === 'app.bsky.feed.getAuthorFeed') return ok({ feed: [] });
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchFn };
};

{
  const api = paginationMock();
  const result = await runAutomation({
    account, now, fetchFn: api.fetchFn, maxPages: 10, recordHistory: false,
  });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.postsRead, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.map(item => item.handle),
    ['inside-a.bsky.social', 'inside-b.bsky.social']);
  assert.equal(api.calls.filter(call => call.path === 'app.bsky.feed.searchPostsV2').length, 2);
  console.log('ok 5 - pagina ate o inicio da janela e descarta posts anteriores');
}

{
  const api = paginationMock({ endless: true });
  const result = await runAutomation({
    account, now, fetchFn: api.fetchFn, maxPages: 2, recordHistory: false,
  });
  assert.equal(result.pagesRead, 2);
  assert.equal(result.truncated, true);
  assert.equal(api.calls.filter(call => call.path === 'app.bsky.feed.searchPostsV2').length, 2);
  console.log('ok 6 - informa truncamento quando atinge o limite de seguranca');
}

{
  const detected = detectAdultContent(
    { labels: [{ val: 'porn', neg: true }], description: 'perfil comum' },
    [{ post: { labels: [{ val: 'nudity' }], record: { text: 'foto' } } }],
  );
  assert.equal(detected.adult, true);
  assert.deepEqual(detected.labels, ['nudity']);
  assert.equal(detectAdultContent({ description: 'NSFW 🔞' }).adult, true);
  assert.equal(detectAdultContent({ description: 'vida adulta sem drama' }).adult, false);
  console.log('ok 7 - detecta rotulos e sinais explicitos sem considerar rotulo negado');
}

{
  const calls = [];
  const adultProfiles = {
    'did:plc:label': {
      did: 'did:plc:label', handle: 'label.bsky.social', followersCount: 100, followsCount: 100,
      viewer: {}, labels: [{ val: 'porn' }],
    },
    'did:plc:text': {
      did: 'did:plc:text', handle: 'text.bsky.social', followersCount: 100, followsCount: 100,
      viewer: {}, description: 'Confira meu conteúdo adulto',
    },
    'did:plc:feed': {
      did: 'did:plc:feed', handle: 'feed.bsky.social', followersCount: 100, followsCount: 100, viewer: {},
    },
    'did:plc:clean': {
      did: 'did:plc:clean', handle: 'clean.bsky.social', followersCount: 100, followsCount: 100, viewer: {},
    },
  };
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname.split('/').pop();
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, url, body });
    const ok = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === 'com.atproto.server.createSession')
      return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
    if (path === 'app.bsky.feed.searchPostsV2') return ok({ posts:
      Object.keys(adultProfiles).map((did, index) => ({
        indexedAt: `2026-08-30T12:${String(59 - index).padStart(2, '0')}:00Z`,
        author: { did }, record: { langs: ['pt'] },
      })),
    });
    if (path === 'app.bsky.actor.getProfiles')
      return ok({ profiles: url.searchParams.getAll('actors').map(did => adultProfiles[did]) });
    if (path === 'app.bsky.feed.getAuthorFeed') {
      if (url.searchParams.get('actor') === 'did:plc:feed')
        return ok({ feed: [{ post: { labels: [{ val: 'sexual' }], record: { text: 'post' } } }] });
      return ok({ feed: [] });
    }
    if (path === 'com.atproto.repo.createRecord') return ok({ uri: 'at://me/app.bsky.graph.follow/new' });
    return new Response('{}', { status: 404 });
  };
  const result = await runAutomation({
    account, now, fetchFn, execute: true, maxFollows: 1,
    sleepFn: async () => {}, recordHistory: false,
  });
  assert.deepEqual(result.followed.map(item => item.handle), ['clean.bsky.social']);
  assert.equal(result.adultProfilesSkipped.length, 3);
  assert.equal(result.profilesCheckedForAdultContent, 4);
  assert.equal(calls.filter(call => call.path === 'com.atproto.repo.createRecord').length, 1);
  console.log('ok 8 - ignora perfis adultos e continua procurando ate preencher o limite');
}

{
  const api = mock();
  const originalFetch = api.fetchFn;
  api.fetchFn = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/app.bsky.feed.getAuthorFeed'))
      return new Response(JSON.stringify({ message: 'temporariamente indisponivel' }), { status: 503 });
    return originalFetch(input, options);
  };
  const result = await runAutomation({
    account, now, fetchFn: api.fetchFn, execute: true,
    sleepFn: async () => {}, recordHistory: false,
  });
  assert.equal(result.followed.length, 0);
  assert.equal(result.adultCheckFailures.length, 1);
  assert.equal(api.calls.some(call => call.path === 'com.atproto.repo.createRecord'), false);
  console.log('ok 9 - falha de verificacao impede follow por seguranca');
}

console.log('\ntodos passaram');
