import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts } from './auto-follow.mjs';

const HOST = 'https://bsky.social/xrpc/';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATE = resolve(ROOT, '.auto-follow-state.json');
const HISTORY = resolve(ROOT, 'auto-unfollow-history.jsonl');
const DEFAULTS = { graceDays: 7, maxUnfollows: 50, maxPages: 300 };
const WAIT = { min: 10000, max: 30000 };
const VERIFY = { attempts: 3, wait: 1000 };

const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const requestJson = async (fetchFn, path, { params, body, token } = {}) => {
  const url = new URL(path, HOST);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));
    else url.searchParams.set(key, value);
  }
  const response = await fetchFn(url, {
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
  });
  if (response.ok) return response.json();
  const detail = await response.json().catch(() => ({}));
  throw new Error(`${path}: ${response.status}${detail.message ? ` — ${detail.message}` : ''}`);
};

const login = (fetchFn, account) => requestJson(fetchFn, 'com.atproto.server.createSession', {
  body: { identifier: account.handle.replace(/^@/, ''), password: account.appPassword },
});

async function followRecords(fetchFn, session, maxPages) {
  const records = new Map();
  let recordsRead = 0;
  let cursor;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const data = await requestJson(fetchFn, 'com.atproto.repo.listRecords', {
      token: session.accessJwt,
      params: {
        repo: session.did, collection: 'app.bsky.graph.follow', limit: 100,
        ...(cursor && { cursor }),
      },
    });
    recordsRead += data.records.length;
    for (const record of data.records) {
      if (!record.value?.subject || !record.value?.createdAt) continue;
      const previous = records.get(record.value.subject);
      if (previous) {
        previous.uris.push(record.uri);
        if (record.value.createdAt < previous.followedAt)
          previous.followedAt = record.value.createdAt;
      } else {
        records.set(record.value.subject, {
          did: record.value.subject,
          uris: [record.uri],
          followedAt: record.value.createdAt,
        });
      }
    }
    cursor = data.cursor;
    if (!cursor || !data.records.length) break;
    truncated = page === maxPages - 1;
  }
  return {
    records: [...records.values()],
    recordsRead,
    duplicateRecords: Math.max(0, recordsRead - records.size),
    truncated,
  };
}

async function hydrateProfiles(fetchFn, token, records) {
  const byDid = new Map(records.map(record => [record.did, record]));
  const profiles = [];
  for (let index = 0; index < records.length; index += 25) {
    const data = await requestJson(fetchFn, 'app.bsky.actor.getProfiles', {
      token, params: { actors: records.slice(index, index + 25).map(record => record.did) },
    });
    profiles.push(...data.profiles.map(profile => ({
      ...profile,
      ...byDid.get(profile.did),
    })));
  }
  return profiles;
}

const unfollow = (fetchFn, session, uri) => requestJson(fetchFn, 'com.atproto.repo.deleteRecord', {
  token: session.accessJwt,
  body: {
    repo: session.did,
    collection: 'app.bsky.graph.follow',
    rkey: uri.split('/').pop(),
  },
});

async function confirmUnfollow(fetchFn, token, profile, sleepFn) {
  for (let attempt = 0; attempt < VERIFY.attempts; attempt++) {
    const data = await requestJson(fetchFn, 'app.bsky.actor.getProfiles', {
      token, params: { actors: [profile.did] },
    });
    const refreshed = data.profiles.find(item => item.did === profile.did);
    if (!refreshed) throw new Error('perfil não retornado ao verificar o unfollow');
    if (!refreshed.viewer?.following) return;
    if (attempt < VERIFY.attempts - 1) await sleepFn(VERIFY.wait);
  }
  throw new Error('o perfil continua seguido após remover todos os registros conhecidos');
}

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

async function loadState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    return { version: 1, unfollowed: state.unfollowed ?? {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, unfollowed: {} };
    throw new Error(`Estado de unfollow inválido: ${error.message}`);
  }
}

async function saveState(statePath, state) {
  const temporary = statePath + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, statePath);
}

export async function runUnfollow({
  account,
  execute = false,
  graceDays = DEFAULTS.graceDays,
  maxUnfollows = DEFAULTS.maxUnfollows,
  maxPages = DEFAULTS.maxPages,
  now = new Date(),
  fetchFn = fetch,
  sleepFn = delay,
  random = Math.random,
  statePath = STATE,
  historyPath = HISTORY,
  recordHistory = true,
} = {}) {
  if (!account?.handle || !account?.appPassword)
    throw new Error('Conta sem handle ou app password.');
  graceDays = positive(graceDays, DEFAULTS.graceDays);
  maxUnfollows = Math.min(50, Math.floor(positive(maxUnfollows, DEFAULTS.maxUnfollows)));
  maxPages = Math.floor(positive(maxPages, DEFAULTS.maxPages));

  const session = await login(fetchFn, account);
  const follows = await followRecords(fetchFn, session, maxPages);
  const profiles = await hydrateProfiles(fetchFn, session.accessJwt, follows.records);
  const cutoff = new Date(now.getTime() - graceDays * 86400000).toISOString();
  const candidates = profiles
    .filter(profile => profile.did !== session.did)
    .filter(profile => profile.viewer?.following)
    .filter(profile => !profile.viewer?.followedBy)
    .filter(profile => profile.followedAt <= cutoff)
    .sort((a, b) => a.followedAt.localeCompare(b.followedAt))
    .slice(0, maxUnfollows);

  const state = await loadState(statePath);
  const unfollowed = [];
  const failures = [];
  let recordsDeleted = 0;
  let recordDeleteFailures = 0;
  if (execute) {
    for (const [index, profile] of candidates.entries()) {
      let profileRecordsDeleted = 0;
      const deleteErrors = [];
      for (const uri of new Set(profile.uris)) {
        try {
          await unfollow(fetchFn, session, uri);
          profileRecordsDeleted++;
          recordsDeleted++;
        } catch (error) {
          recordDeleteFailures++;
          deleteErrors.push(error.message);
        }
      }
      try {
        await confirmUnfollow(fetchFn, session.accessJwt, profile, sleepFn);
        const item = {
          did: profile.did,
          handle: profile.handle,
          followedAt: profile.followedAt,
          recordsDeleted: profileRecordsDeleted,
          recordDeleteFailures: deleteErrors.length,
        };
        unfollowed.push(item);
        state.unfollowed[profile.did] = { handle: profile.handle, at: now.toISOString() };
        await saveState(statePath, state);
      } catch (error) {
        failures.push({
          did: profile.did,
          handle: profile.handle,
          recordsDeleted: profileRecordsDeleted,
          recordDeleteFailures: deleteErrors.length,
          error: [...deleteErrors, error.message].join('; '),
        });
      }
      if (index < candidates.length - 1) {
        const wait = Math.floor(random() * (WAIT.max - WAIT.min + 1)) + WAIT.min;
        await sleepFn(wait);
      }
    }
  }
  await saveState(statePath, state);

  const summary = {
    at: now.toISOString(),
    account: session.handle,
    mode: execute ? 'execute' : 'dry-run',
    graceDays,
    maxUnfollows,
    followsRead: follows.records.length,
    followRecordsRead: follows.recordsRead,
    duplicateFollowRecords: follows.duplicateRecords,
    candidates: candidates.map(({ did, handle, followedAt, uris }) =>
      ({ did, handle, followedAt, followRecords: new Set(uris).size })),
    recordsDeleted,
    recordDeleteFailures,
    unfollowed,
    failures,
    truncated: follows.truncated,
  };
  if (recordHistory) await appendFile(historyPath, JSON.stringify(summary) + '\n', { mode: 0o600 });
  return summary;
}

async function main() {
  const cloudAccount = process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD
    ? { handle: process.env.BSKY_HANDLE, appPassword: process.env.BSKY_APP_PASSWORD }
    : null;
  const accounts = cloudAccount ? [cloudAccount] : await loadAccounts();
  const selectedHandle = process.env.AUTO_FOLLOW_HANDLE?.replace(/^@/, '').toLowerCase();
  const account = selectedHandle
    ? accounts.find(item => item.handle.replace(/^@/, '').toLowerCase() === selectedHandle)
    : accounts[0];
  if (!account) throw new Error('Nenhuma conta configurada.');

  const summary = await runUnfollow({
    account,
    execute: process.argv.includes('--execute'),
    graceDays: process.env.AUTO_UNFOLLOW_GRACE_DAYS,
    maxUnfollows: process.env.AUTO_UNFOLLOW_MAX,
  });
  const { account: _account, candidates, unfollowed, failures, ...metrics } = summary;
  console.log(JSON.stringify({
    ...metrics,
    candidatesCount: candidates.length,
    unfollowedCount: unfollowed.length,
    failuresCount: failures.length,
  }, null, 2));
  if (!process.argv.includes('--execute'))
    console.log('\nSimulação: nenhum perfil recebeu unfollow.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Unfollow falhou: ${error.message}`); process.exitCode = 1; });
