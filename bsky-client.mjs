const HOST = 'https://bsky.social/xrpc/';
const RATE_LIMIT = { attempts: 6, fallbackWait: 5000, maxWait: 120000 };

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const expiredSession = (status, detail) =>
  status === 401 ||
  detail.error === 'ExpiredToken' ||
  /token.*expir/i.test(detail.message ?? '');

const waitFromRateLimit = (response, attempt) => {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()))
    return Math.min(RATE_LIMIT.maxWait, Number(retryAfter) * 1000);
  const reset = response.headers.get('ratelimit-reset');
  if (reset && /^\d+$/.test(reset)) {
    const wait = Number(reset) * 1000 - Date.now();
    if (wait > 0) return Math.min(RATE_LIMIT.maxWait, wait);
  }
  return Math.min(RATE_LIMIT.maxWait, RATE_LIMIT.fallbackWait * 2 ** attempt);
};

const assignSession = (session, data) => {
  session.did = data.did;
  session.handle = data.handle;
  session.accessJwt = data.accessJwt;
  session.refreshJwt = data.refreshJwt ?? session.refreshJwt ?? '';
  return session;
};

export async function requestJson(fetchFn, path, {
  params,
  body,
  method,
  token,
  session,
  account,
  sleepFn = delay,
  rateAttempt = 0,
  recovered = false,
} = {}) {
  const url = new URL(path, HOST);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));
    else url.searchParams.set(key, value);
  }

  const isPost = method === 'POST' || body !== undefined;
  const jwt = token ?? session?.accessJwt;
  const response = await fetchFn(url, {
    ...(isPost && { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
    headers: {
      ...(isPost && body !== undefined && { 'content-type': 'application/json' }),
      ...(jwt && { authorization: `Bearer ${jwt}` }),
    },
  });

  if (response.status === 429 && rateAttempt < RATE_LIMIT.attempts - 1) {
    await sleepFn(waitFromRateLimit(response, rateAttempt));
    return requestJson(fetchFn, path, {
      params, body, method, token, session, account, sleepFn,
      rateAttempt: rateAttempt + 1, recovered,
    });
  }

  if (response.ok) {
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  const detail = await response.json().catch(() => ({}));
  if (session && !recovered && expiredSession(response.status, detail)) {
    await recoverSession(fetchFn, session, account, sleepFn);
    return requestJson(fetchFn, path, {
      params, body, method, token: undefined, session, account, sleepFn,
      rateAttempt: 0, recovered: true,
    });
  }

  throw new Error(`${path}: ${response.status}${detail.message ? ` — ${detail.message}` : ''}`);
}

async function recoverSession(fetchFn, session, account, sleepFn) {
  if (session.refreshJwt) {
    try {
      const data = await requestJson(fetchFn, 'com.atproto.server.refreshSession', {
        method: 'POST',
        token: session.refreshJwt,
        sleepFn,
      });
      assignSession(session, data);
      return session;
    } catch {
      if (!account?.handle || !account?.appPassword) throw new Error('Sessão expirada.');
    }
  } else if (!account?.handle || !account?.appPassword) {
    throw new Error('Sessão expirada.');
  }

  const data = await requestJson(fetchFn, 'com.atproto.server.createSession', {
    body: {
      identifier: account.handle.replace(/^@/, ''),
      password: account.appPassword,
    },
    sleepFn,
  });
  return assignSession(session, data);
}

export function createBsky({ fetchFn = fetch, account, sleepFn = delay } = {}) {
  const session = { did: '', handle: '', accessJwt: '', refreshJwt: '' };

  const request = (path, opts = {}) => requestJson(fetchFn, path, {
    ...opts, session, account, sleepFn,
  });

  return {
    session,
    login: async () => {
      if (!account?.handle || !account?.appPassword)
        throw new Error('Conta sem handle ou app password.');
      const data = await requestJson(fetchFn, 'com.atproto.server.createSession', {
        body: {
          identifier: account.handle.replace(/^@/, ''),
          password: account.appPassword,
        },
        sleepFn,
      });
      return assignSession(session, data);
    },
    get: (path, params) => request(path, { params }),
    post: (path, body) => request(path, { body }),
    request,
  };
}

export async function hydrateProfiles(client, items) {
  const byDid = new Map(items.map(item => [item.did, item]));
  const profiles = [];
  const dids = [...byDid.keys()];
  for (let index = 0; index < dids.length; index += 25) {
    const data = await client.get('app.bsky.actor.getProfiles', {
      actors: dids.slice(index, index + 25),
    });
    profiles.push(...(data.profiles ?? []).map(profile => ({
      ...byDid.get(profile.did),
      ...profile,
    })));
  }
  return profiles;
}
