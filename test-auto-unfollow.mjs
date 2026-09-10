import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnfollow } from './auto-unfollow.mjs';

const now = new Date('2026-08-30T12:00:00Z');
const account = { handle: 'eu.bsky.social', appPassword: 'senha-de-teste' };
const followedAt = {
  oldest: '2026-07-01T10:00:00Z',
  mutual: '2026-07-10T10:00:00Z',
  old: '2026-08-15T10:00:00Z',
  recent: '2026-08-29T10:00:00Z',
};

const mock = ({ keepDeleted = false } = {}) => {
  const calls = [];
  const records = [
    { uri: 'at://did:plc:me/app.bsky.graph.follow/oldest-a',
      value: { subject: 'did:plc:oldest', createdAt: followedAt.oldest } },
    { uri: 'at://did:plc:me/app.bsky.graph.follow/oldest-b',
      value: { subject: 'did:plc:oldest', createdAt: '2026-07-02T10:00:00Z' } },
    ...Object.entries(followedAt).filter(([name]) => name !== 'oldest').map(([name, createdAt]) => ({
      uri: `at://did:plc:me/app.bsky.graph.follow/${name}`,
      value: { subject: `did:plc:${name}`, createdAt },
    })),
  ];
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const path = url.pathname.split('/').pop();
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, url, body });
    const ok = data => new Response(JSON.stringify(data), { status: 200 });
    if (path === 'com.atproto.server.createSession')
      return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
    if (path === 'com.atproto.repo.listRecords') return ok({ records });
    if (path === 'app.bsky.actor.getProfiles') return ok({
      profiles: url.searchParams.getAll('actors').map(did => {
        const follow = records.find(record => record.value.subject === did);
        return {
          did, handle: did.split(':').pop() + '.bsky.social',
          viewer: {
            ...(follow && { following: follow.uri }),
            ...(did === 'did:plc:mutual' && { followedBy: 'at://them/follow/me' }),
          },
        };
      }),
    });
    if (path === 'app.bsky.feed.getAuthorFeed') return ok({ feed: [] });
    if (path === 'com.atproto.repo.deleteRecord') {
      const index = records.findIndex(record => record.uri.endsWith('/' + body.rkey));
      if (!keepDeleted && index >= 0) records.splice(index, 1);
      return ok({});
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchFn, records };
};

const directory = await mkdtemp(join(tmpdir(), 'auto-unfollow-test-'));
try {
  {
    const api = mock();
    const result = await runUnfollow({
      account, now, fetchFn: api.fetchFn, recordHistory: false,
      statePath: join(directory, 'dry-state.json'),
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.graceDays, 0);
    assert.equal(result.maxUnfollows, 50);
    assert.equal(result.followsRead, 4);
    assert.equal(result.followRecordsRead, 5);
    assert.equal(result.duplicateFollowRecords, 1);
    assert.deepEqual(result.candidates.map(item => item.handle),
      ['oldest.bsky.social', 'old.bsky.social', 'recent.bsky.social']);
    assert.equal(result.followingBackCount, 1);
    assert.equal(result.notFollowingBackCount, 3);
    assert.equal(result.notFollowingBackInGraceCount, 0);
    assert.equal(result.candidates[0].followRecords, 2);
    assert.equal(api.calls.some(call => call.path === 'com.atproto.repo.deleteRecord'), false);
    console.log('ok 1 - seleciona nao seguidores do follow mais velho ao mais novo');
  }

  {
    const api = mock();
    const result = await runUnfollow({
      account, now, fetchFn: api.fetchFn, graceDays: 7, recordHistory: false,
      statePath: join(directory, 'grace-state.json'),
    });
    assert.deepEqual(result.candidates.map(item => item.handle),
      ['oldest.bsky.social', 'old.bsky.social']);
    assert.equal(result.notFollowingBackCount, 3);
    assert.equal(result.notFollowingBackInGraceCount, 1);
    console.log('ok 2 - permite carencia opcional sem esconder a quantidade bloqueada');
  }

  {
    const api = mock();
    const statePath = join(directory, 'execute-state.json');
    const result = await runUnfollow({
      account, now, fetchFn: api.fetchFn, execute: true, maxUnfollows: 1,
      sleepFn: async () => {}, recordHistory: false, statePath,
    });
    assert.deepEqual(result.unfollowed.map(item => item.handle), ['oldest.bsky.social']);
    const writes = api.calls.filter(call => call.path === 'com.atproto.repo.deleteRecord');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map(call => call.body.rkey), ['oldest-a', 'oldest-b']);
    assert.equal(result.recordsDeleted, 2);
    assert.equal(result.recordDeleteFailures, 0);
    assert.equal(result.unfollowed[0].recordsDeleted, 2);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.unfollowed['did:plc:oldest'].handle, 'oldest.bsky.social');
    console.log('ok 3 - remove todos os registros duplicados, confirma e persiste o perfil');
  }

  {
    const api = mock({ keepDeleted: true });
    const statePath = join(directory, 'unconfirmed-state.json');
    const result = await runUnfollow({
      account, now, fetchFn: api.fetchFn, execute: true, maxUnfollows: 1,
      sleepFn: async () => {}, recordHistory: false, statePath,
    });
    assert.equal(result.recordsDeleted, 2);
    assert.equal(result.unfollowed.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /continua seguido/);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.unfollowed['did:plc:oldest'], undefined);
    console.log('ok 4 - nao contabiliza nem persiste enquanto o perfil continuar seguido');
  }

  {
    const calls = [];
    const records = [
      { uri: 'at://did:plc:me/app.bsky.graph.follow/missing',
        value: { subject: 'did:plc:missing', createdAt: '2026-07-01T10:00:00Z' } },
      { uri: 'at://did:plc:me/app.bsky.graph.follow/stale',
        value: { subject: 'did:plc:stale', createdAt: '2026-07-02T10:00:00Z' } },
      { uri: 'at://did:plc:me/app.bsky.graph.follow/active',
        value: { subject: 'did:plc:active', createdAt: '2026-07-03T10:00:00Z' } },
    ];
    const fetchFn = async (input, options = {}) => {
      const url = new URL(input);
      const path = url.pathname.split('/').pop();
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body });
      const ok = data => new Response(JSON.stringify(data), { status: 200 });
      if (path === 'com.atproto.server.createSession')
        return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
      if (path === 'com.atproto.repo.listRecords') return ok({ records });
      if (path === 'app.bsky.actor.getProfiles') return ok({
        profiles: url.searchParams.getAll('actors').filter(did => did !== 'did:plc:missing').map(did => ({
          did, handle: did.split(':').pop() + '.bsky.social',
          viewer: did === 'did:plc:active'
            ? { following: 'at://did:plc:me/app.bsky.graph.follow/active', followedBy: 'at://them/follow/me' }
            : {},
        })),
      });
      if (path === 'app.bsky.feed.getAuthorFeed') return ok({ feed: [] });
      if (path === 'com.atproto.repo.deleteRecord') return ok({});
      return new Response('{}', { status: 404 });
    };
    const result = await runUnfollow({
      account, now, fetchFn, execute: true, cleanStaleRecords: true,
      sleepFn: async () => {}, recordHistory: false,
      statePath: join(directory, 'stale-state.json'),
    });
    assert.equal(result.staleFollowRecordsCount, 2);
    assert.equal(result.staleFollowRecordsEligibleCount, 2);
    assert.deepEqual(result.unfollowed.map(item => item.did), ['did:plc:missing', 'did:plc:stale']);
    assert.deepEqual(result.unfollowed.map(item => item.reasons),
      [['stale_follow_record'], ['stale_follow_record']]);
    assert.equal(calls.filter(call => call.path === 'com.atproto.repo.deleteRecord').length, 2);
    console.log('ok 5 - limpa registros antigos sem perfil ou sem relacao ativa');
  }

  {
    const calls = [];
    const records = ['adult', 'portugal', 'brasil', 'unknown'].map((name, index) => ({
      uri: `at://did:plc:me/app.bsky.graph.follow/${name}`,
      value: {
        subject: `did:plc:${name}`,
        createdAt: `2026-08-${String(26 + index).padStart(2, '0')}T10:00:00Z`,
      },
    }));
    const profileData = {
      'did:plc:adult': { labels: [{ val: 'porn' }] },
      'did:plc:portugal': { description: 'Lisboa, Portugal 🇵🇹' },
      'did:plc:brasil': { description: 'Brasileira 🇧🇷' },
      'did:plc:unknown': { description: 'Escrevo em português' },
    };
    const fetchFn = async (input, options = {}) => {
      const url = new URL(input);
      const path = url.pathname.split('/').pop();
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, url, body });
      const ok = data => new Response(JSON.stringify(data), { status: 200 });
      if (path === 'com.atproto.server.createSession')
        return ok({ did: 'did:plc:me', handle: 'eu.bsky.social', accessJwt: 'token' });
      if (path === 'com.atproto.repo.listRecords') return ok({ records });
      if (path === 'app.bsky.actor.getProfiles') return ok({
        profiles: url.searchParams.getAll('actors').map(did => {
          const record = records.find(item => item.value.subject === did);
          return {
            did,
            handle: did.split(':').pop() + '.bsky.social',
            ...profileData[did],
            viewer: {
              ...(record && { following: record.uri }),
              followedBy: `at://${did}/app.bsky.graph.follow/me`,
            },
          };
        }),
      });
      if (path === 'app.bsky.feed.getAuthorFeed') return ok({ feed: [] });
      if (path === 'com.atproto.repo.deleteRecord') {
        const index = records.findIndex(record => record.uri.endsWith('/' + body.rkey));
        if (index >= 0) records.splice(index, 1);
        return ok({});
      }
      return new Response('{}', { status: 404 });
    };
    const statePath = join(directory, 'policy-state.json');
    const result = await runUnfollow({
      account, now, fetchFn, execute: true, policyScanLimit: 10,
      sleepFn: async () => {}, recordHistory: false, statePath,
    });
    assert.deepEqual(result.unfollowed.map(item => item.handle),
      ['adult.bsky.social', 'portugal.bsky.social']);
    assert.deepEqual(result.unfollowed.map(item => item.reasons),
      [['adult_content'], ['non_brazilian']]);
    assert.equal(result.adultProfilesDetected, 1);
    assert.equal(result.nonBrazilianProfilesDetected, 1);
    assert.equal(result.policyFailures.length, 0);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(state.unfollowed['did:plc:adult'].reasons, ['adult_content']);
    assert.equal(state.reviewed['did:plc:brasil'].nationality, 'brazilian');
    assert.equal(state.reviewed['did:plc:unknown'].nationality, 'unknown');
    console.log('ok 6 - remove adultos e nao brasileiros, preservando brasileiros e desconhecidos');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('\ntodos passaram');
