import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { detectAdultContent, detectBrazilianProfile } from './profile-policy.mjs';

export { detectAdultContent, detectBrazilianProfile } from './profile-policy.mjs';

const HOST = 'https://bsky.social/xrpc/';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HISTORY = resolve(ROOT, 'auto-follow-history.jsonl');
const STATE = resolve(ROOT, '.auto-follow-state.json');
const DEFAULTS = { windowMinutes: 60, ratioPct: 10, maxFollows: 30, maxPages: 20 };
const WAIT = { min: 10000, max: 30000 };

const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const dentroDaProporcao = (followers, follows, ratioPct = DEFAULTS.ratioPct) =>
  Number.isFinite(followers) && Number.isFinite(follows) &&
  Math.abs(followers - follows) <= follows * ratioPct / 100;

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

async function recentAuthors(fetchFn, token, { since, maxPages }) {
  const authors = new Map();
  let cursor;
  let postsRead = 0;
  let pagesRead = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await requestJson(fetchFn, 'app.bsky.feed.searchPostsV2', {
      token,
      params: { limit: 100, sort: 'recent', languages: ['pt'], since, ...(cursor && { cursor }) },
    });
    const posts = data.posts ?? [];
    pagesRead++;
    postsRead += posts.length;
    let reachedWindowStart = false;
    for (const post of posts) {
      if (!post.indexedAt || post.indexedAt < since) {
        reachedWindowStart = true;
        continue;
      }
      if (post.indexedAt === since) reachedWindowStart = true;
      if (!post.record?.langs?.some(lang => /^pt(?:-|$)/i.test(lang))) continue;
      const previous = authors.get(post.author.did);
      if (!previous || post.indexedAt > previous.matchedAt)
        authors.set(post.author.did, { ...post.author, matchedAt: post.indexedAt });
    }
    cursor = data.cursor;
    if (!cursor || !posts.length || reachedWindowStart) {
      cursor = undefined;
      break;
    }
  }
  return { authors: [...authors.values()], postsRead, pagesRead, truncated: Boolean(cursor) };
}

async function hydrateProfiles(fetchFn, token, authors) {
  const matchedAt = new Map(authors.map(author => [author.did, author.matchedAt]));
  const profiles = [];
  for (let index = 0; index < authors.length; index += 25) {
    const data = await requestJson(fetchFn, 'app.bsky.actor.getProfiles', {
      token, params: { actors: authors.slice(index, index + 25).map(author => author.did) },
    });
    profiles.push(...data.profiles.map(profile => ({ ...profile, matchedAt: matchedAt.get(profile.did) })));
  }
  return profiles;
}

async function inspectProfilePolicy(fetchFn, token, profile) {
  const data = await requestJson(fetchFn, 'app.bsky.feed.getAuthorFeed', {
    token,
    params: { actor: profile.did, limit: 50, filter: 'posts_no_replies' },
  });
  const feed = data.feed ?? [];
  return {
    adult: detectAdultContent(profile, feed),
    nationality: detectBrazilianProfile(profile, feed),
  };
}

const follow = (fetchFn, session, did) => requestJson(fetchFn, 'com.atproto.repo.createRecord', {
  token: session.accessJwt,
  body: {
    repo: session.did,
    collection: 'app.bsky.graph.follow',
    record: { $type: 'app.bsky.graph.follow', subject: did, createdAt: new Date().toISOString() },
  },
});

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

export async function runAutomation({
  account,
  execute = false,
  windowMinutes = DEFAULTS.windowMinutes,
  ratioPct = DEFAULTS.ratioPct,
  maxFollows = DEFAULTS.maxFollows,
  maxPages = DEFAULTS.maxPages,
  now = new Date(),
  fetchFn = fetch,
  sleepFn = delay,
  random = Math.random,
  recordHistory = true,
  excludedDids = new Set(),
} = {}) {
  if (!account?.handle || !account?.appPassword)
    throw new Error('Conta sem handle ou app password no config.js.');

  windowMinutes = positive(windowMinutes, DEFAULTS.windowMinutes);
  ratioPct = positive(ratioPct, DEFAULTS.ratioPct);
  maxFollows = Math.min(50, Math.floor(positive(maxFollows, DEFAULTS.maxFollows)));
  maxPages = Math.floor(positive(maxPages, DEFAULTS.maxPages));

  const session = await login(fetchFn, account);
  const since = new Date(now.getTime() - windowMinutes * 60000).toISOString();
  const search = await recentAuthors(fetchFn, session.accessJwt, { since, maxPages });
  const profiles = await hydrateProfiles(fetchFn, session.accessJwt, search.authors);
  const eligibleProfiles = profiles
    .filter(profile => profile.did !== session.did)
    .filter(profile => !excludedDids.has(profile.did))
    .filter(profile => !profile.viewer?.following && !profile.viewer?.blocking && !profile.viewer?.blockedBy)
    .filter(profile => dentroDaProporcao(profile.followersCount, profile.followsCount, ratioPct))
    .sort((a, b) => b.matchedAt.localeCompare(a.matchedAt));

  const candidates = [];
  const adultProfilesSkipped = [];
  const nonBrazilianProfilesSkipped = [];
  const adultCheckFailures = [];
  let profilesCheckedForAdultContent = 0;
  for (const profile of eligibleProfiles) {
    if (candidates.length >= maxFollows) break;
    profilesCheckedForAdultContent++;
    try {
      const inspection = await inspectProfilePolicy(fetchFn, session.accessJwt, profile);
      if (inspection.adult.adult) {
        adultProfilesSkipped.push({
          did: profile.did,
          handle: profile.handle,
          labels: inspection.adult.labels,
          explicitText: inspection.adult.explicitText,
        });
        continue;
      }
      if (inspection.nationality.status === 'non_brazilian') {
        nonBrazilianProfilesSkipped.push({
          did: profile.did,
          handle: profile.handle,
          signals: inspection.nationality.reasons,
        });
        continue;
      }
      candidates.push(profile);
    } catch (error) {
      // Falha fechada: sem conseguir verificar, o perfil não é seguido.
      adultCheckFailures.push({ did: profile.did, handle: profile.handle, error: error.message });
    }
  }

  const followed = [];
  const failures = [];
  if (execute) {
    for (const [index, profile] of candidates.entries()) {
      try {
        await follow(fetchFn, session, profile.did);
        followed.push({ did: profile.did, handle: profile.handle });
      } catch (error) {
        failures.push({ did: profile.did, handle: profile.handle, error: error.message });
      }
      if (index < candidates.length - 1) {
        const wait = Math.floor(random() * (WAIT.max - WAIT.min + 1)) + WAIT.min;
        await sleepFn(wait);
      }
    }
  }

  const summary = {
    at: now.toISOString(),
    account: session.handle,
    mode: execute ? 'execute' : 'dry-run',
    windowMinutes,
    ratioPct,
    maxFollows,
    maxPages,
    pagesRead: search.pagesRead,
    postsRead: search.postsRead,
    uniqueAuthors: search.authors.length,
    profilesCheckedForAdultContent,
    adultProfilesSkipped,
    nonBrazilianProfilesSkipped,
    adultCheckFailures,
    candidates: candidates.map(({ did, handle, followersCount, followsCount, matchedAt }) =>
      ({ did, handle, followersCount, followsCount, matchedAt })),
    followed,
    failures,
    truncated: search.truncated,
  };
  if (recordHistory) await appendFile(HISTORY, JSON.stringify(summary) + '\n', { mode: 0o600 });
  return summary;
}

export async function loadAccounts(configPath = resolve(ROOT, 'config.js')) {
  const source = await readFile(configPath, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: configPath, timeout: 1000 });
  return [sandbox.window.BSKY ?? []].flat().filter(account => account?.handle && account?.appPassword);
}

export async function loadExcludedDids(statePath = STATE) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    return new Set(Object.keys(state.unfollowed ?? {}));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new Error(`Estado de unfollow inválido: ${error.message}`);
  }
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
  if (!account) throw new Error(selectedHandle
    ? `A conta @${selectedHandle} não está no config.js.`
    : 'Nenhuma conta configurada no config.js.');

  const summary = await runAutomation({
    account,
    execute: process.argv.includes('--execute'),
    windowMinutes: process.env.AUTO_FOLLOW_WINDOW_MINUTES,
    ratioPct: process.env.AUTO_FOLLOW_RATIO_PCT,
    maxFollows: process.env.AUTO_FOLLOW_MAX_FOLLOWS,
    maxPages: process.env.AUTO_FOLLOW_MAX_PAGES,
    excludedDids: await loadExcludedDids(),
  });
  const {
    account: _account,
    candidates,
    followed,
    failures,
    adultProfilesSkipped,
    nonBrazilianProfilesSkipped,
    adultCheckFailures,
    ...metrics
  } = summary;
  console.log(JSON.stringify({
    ...metrics,
    adultProfilesSkippedCount: adultProfilesSkipped.length,
    nonBrazilianProfilesSkippedCount: nonBrazilianProfilesSkipped.length,
    adultCheckFailuresCount: adultCheckFailures.length,
    candidatesCount: candidates.length,
    followedCount: followed.length,
    failuresCount: failures.length,
  }, null, 2));
  if (!process.argv.includes('--execute'))
    console.log('\nSimulação: nenhum perfil foi seguido. Use --execute somente quando quiser efetivar os follows.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Automação falhou: ${error.message}`); process.exitCode = 1; });
