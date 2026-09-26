/** Persistent stale-while-revalidate cache for large Workbench transcripts. */
import type { WorkbenchTranscript } from './session-api';

const CACHE_NAME = 'hermes-workbench-transcripts-v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_ITEMS = 8;
const memory = new Map<string, { cachedAt: number; transcript: WorkbenchTranscript }>();

function key(profile: string, sessionId: string): string {
  return `${profile}\u0000${sessionId}`;
}

function request(profile: string, sessionId: string): Request {
  const url = new URL('/__hermes-workbench-cache__/transcript', window.location.origin);
  url.searchParams.set('profile', profile);
  url.searchParams.set('session', sessionId);
  return new Request(url.toString(), { method: 'GET' });
}

function remember(cacheKey: string, value: { cachedAt: number; transcript: WorkbenchTranscript }): void {
  memory.delete(cacheKey);
  memory.set(cacheKey, value);
  while (memory.size > MAX_MEMORY_ITEMS) memory.delete(memory.keys().next().value as string);
}

/** Return a fresh cached transcript without delaying on unavailable browser storage. */
export async function loadCachedTranscript(
  profile: string,
  sessionId: string,
): Promise<WorkbenchTranscript | null> {
  const cacheKey = key(profile, sessionId);
  const inMemory = memory.get(cacheKey);
  if (inMemory && Date.now() - inMemory.cachedAt <= CACHE_MAX_AGE_MS) {
    remember(cacheKey, inMemory);
    return inMemory.transcript;
  }
  if (typeof caches === 'undefined') return null;
  try {
    const response = await (await caches.open(CACHE_NAME)).match(request(profile, sessionId));
    if (!response) return null;
    const value = await response.json() as { cachedAt?: number; transcript?: WorkbenchTranscript };
    if (!value.transcript || Date.now() - Number(value.cachedAt || 0) > CACHE_MAX_AGE_MS) return null;
    const normalized = { cachedAt: Number(value.cachedAt), transcript: value.transcript };
    remember(cacheKey, normalized);
    return normalized.transcript;
  } catch {
    return null;
  }
}

/** Save complete lineage after it loads; cache failures never block the UI. */
export async function saveCachedTranscript(
  profile: string,
  requestedSessionId: string,
  transcript: WorkbenchTranscript,
): Promise<void> {
  const value = { cachedAt: Date.now(), transcript };
  remember(key(profile, requestedSessionId), value);
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request(profile, requestedSessionId), new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch {
    // Memory cache remains available for the current Dashboard lifetime.
  }
}
