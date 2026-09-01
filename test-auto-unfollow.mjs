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
    assert.equal(result.graceDays, 7);
    assert.equal(result.maxUnfollows, 50);
    assert.equal(result.followsRead, 4);
    assert.equal(result.followRecordsRead, 5);
    assert.equal(result.duplicateFollowRecords, 1);
    assert.deepEqual(result.candidates.map(item => item.handle),
      ['oldest.bsky.social', 'old.bsky.social']);
    assert.equal(result.candidates[0].followRecords, 2);
    assert.equal(api.calls.some(call => call.path === 'com.atproto.repo.deleteRecord'), false);
    console.log('ok 1 - seleciona apenas nao seguidores antigos, do follow mais velho ao mais novo');
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
    console.log('ok 2 - remove todos os registros duplicados, confirma e persiste o perfil');
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
    console.log('ok 3 - nao contabiliza nem persiste enquanto o perfil continuar seguido');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('\ntodos passaram');
