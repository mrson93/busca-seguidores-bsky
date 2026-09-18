import { readFile, rename, writeFile } from 'node:fs/promises';

export const emptyState = () => ({
  version: 2,
  unfollowed: {},
  follows: {},
  followsCursor: null,
  followsComplete: false,
});

export async function loadState(statePath) {
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      version: 2,
      unfollowed: raw.unfollowed ?? {},
      follows: raw.follows ?? {},
      followsCursor: raw.followsCursor ?? null,
      followsComplete: Boolean(raw.followsComplete),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`Estado de unfollow inválido: ${error.message}`);
  }
}

export async function saveState(statePath, state) {
  const temporary = statePath + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, statePath);
}

export function excludedDidsFrom(state) {
  return new Set(Object.keys(state.unfollowed ?? {}));
}

export function mergeFollowRecord(follows, record) {
  if (!record?.uri || !record.value?.subject || !record.value?.createdAt) return;
  const did = record.value.subject;
  const previous = follows[did];
  if (previous) {
    if (!previous.uris.includes(record.uri)) previous.uris.push(record.uri);
    if (record.value.createdAt < previous.followedAt) previous.followedAt = record.value.createdAt;
    return;
  }
  follows[did] = {
    followedAt: record.value.createdAt,
    uris: [record.uri],
  };
}

export const followsList = follows =>
  Object.entries(follows).map(([did, value]) => ({ did, ...value }));

export function followIndexStats(follows) {
  const records = followsList(follows);
  const followRecords = records.reduce((sum, item) => sum + new Set(item.uris).size, 0);
  return {
    records,
    followsRead: records.length,
    followRecordsRead: followRecords,
    duplicateFollowRecords: Math.max(0, followRecords - records.length),
  };
}

export async function syncFollows(client, state, maxPages) {
  const knownUris = new Set(Object.values(state.follows).flatMap(item => item.uris));
  const wasEmpty = knownUris.size === 0;
  let pagesRead = 0;
  let cursor;
  let overlapped = false;

  const pull = async pageCursor => {
    const data = await client.get('com.atproto.repo.listRecords', {
      repo: client.session.did,
      collection: 'app.bsky.graph.follow',
      limit: 100,
      ...(pageCursor && { cursor: pageCursor }),
    });
    pagesRead++;
    const records = data.records ?? [];
    if (!wasEmpty && records.some(record => knownUris.has(record.uri))) overlapped = true;
    for (const record of records) mergeFollowRecord(state.follows, record);
    return { records, cursor: data.cursor };
  };

  for (let page = 0; page < maxPages; page++) {
    const batch = await pull(cursor);
    cursor = batch.cursor;
    if (!cursor || !batch.records.length) {
      state.followsComplete = true;
      state.followsCursor = null;
      return { ...followIndexStats(state.follows), truncated: false, pagesRead };
    }
    if (overlapped) break;
    if (page === maxPages - 1 && wasEmpty) {
      state.followsComplete = false;
      state.followsCursor = cursor;
      return { ...followIndexStats(state.follows), truncated: true, pagesRead };
    }
  }

  if (!state.followsComplete) {
    let tailCursor = state.followsCursor ?? (wasEmpty ? cursor : null);
    const leftover = Math.max(0, maxPages - pagesRead);
    for (let page = 0; page < leftover && tailCursor; page++) {
      const batch = await pull(tailCursor);
      tailCursor = batch.cursor;
      if (!tailCursor || !batch.records.length) {
        state.followsComplete = true;
        state.followsCursor = null;
        return { ...followIndexStats(state.follows), truncated: false, pagesRead };
      }
      state.followsCursor = tailCursor;
    }
    if (tailCursor) {
      state.followsComplete = false;
      state.followsCursor = tailCursor;
    }
  }

  return {
    ...followIndexStats(state.follows),
    truncated: !state.followsComplete,
    pagesRead,
  };
}
