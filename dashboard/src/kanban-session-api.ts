/** 看板任务与 Hermes 会话的持久关联 API。 */
import type { FetchJSON } from './workbench-api';

const WORKBENCH_API = '/api/plugins/workbench';
const LINK_CACHE_TTL_MS = 30_000;
const EMPTY_LINK_CACHE_TTL_MS = 2_000;
const linkMemoryCache = new Map<string, { expiresAt: number; items: KanbanSessionLink[] }>();

async function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const sdk = (window as any).__HERMES_PLUGIN_SDK__;
  if (typeof sdk?.authedFetch === 'function') return sdk.authedFetch(url, init);
  return fetch(url, { credentials: 'same-origin', ...init });
}

function linkCacheKey(taskId: string, board: string): string {
  return `${board}\u0000${taskId}`;
}

function storedLinkCacheKey(taskId: string, board: string): string {
  return `hermes.workbench.kanban-link.v2.${encodeURIComponent(board)}.${encodeURIComponent(taskId)}`;
}

function cachedKanbanSessions(taskId: string, board: string): KanbanSessionLink[] | null {
  const key = linkCacheKey(taskId, board);
  const memory = linkMemoryCache.get(key);
  if (memory && memory.expiresAt > Date.now()) return memory.items;
  try {
    const raw = window.sessionStorage.getItem(storedLinkCacheKey(taskId, board));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.items) || Number(parsed?.expiresAt) <= Date.now()) return null;
    linkMemoryCache.set(key, parsed);
    return parsed.items;
  } catch {
    return null;
  }
}

/** Cache the singleton binding briefly so repeated card interactions are instant. */
export function rememberKanbanSession(link: KanbanSessionLink): void {
  const value = { expiresAt: Date.now() + LINK_CACHE_TTL_MS, items: [link] };
  linkMemoryCache.set(linkCacheKey(link.task_id, link.board), value);
  try {
    window.sessionStorage.setItem(storedLinkCacheKey(link.task_id, link.board), JSON.stringify(value));
  } catch {
    // In-memory caching remains available when sessionStorage is unavailable.
  }
}

function query(value: string): string {
  return encodeURIComponent(value);
}

export type KanbanSessionLink = {
  board: string;
  task_id: string;
  profile: string;
  session_id: string;
  created_at: number;
};

/** 保存一次可重复提交的任务—会话关联。 */
export async function linkKanbanSession(
  fetchJSON: FetchJSON,
  value: Omit<KanbanSessionLink, 'created_at'>,
): Promise<KanbanSessionLink> {
  const response = await fetchJSON<{ link: KanbanSessionLink }>(`${WORKBENCH_API}/kanban-sessions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  rememberKanbanSession(response.link);
  return response.link;
}

/** 列出一张任务已经关联的会话，供看板右键菜单继续使用。 */
export async function listKanbanSessions(
  taskId: string,
  board = '',
): Promise<KanbanSessionLink[]> {
  const cached = cachedKanbanSessions(taskId, board);
  if (cached) return cached;
  const suffix = board ? `&board=${query(board)}` : '';
  const response = await authedFetch(`${WORKBENCH_API}/kanban-sessions?task_id=${query(taskId)}${suffix}`);
  if (!response.ok) throw new Error(`Unable to load task conversation (${response.status})`);
  const payload = await response.json();
  const items: KanbanSessionLink[] = Array.isArray(payload?.items) ? payload.items.slice(0, 1) : [];
  const value = {
    expiresAt: Date.now() + (items.length ? LINK_CACHE_TTL_MS : EMPTY_LINK_CACHE_TTL_MS),
    items,
  };
  linkMemoryCache.set(linkCacheKey(taskId, board), value);
  try {
    window.sessionStorage.setItem(storedLinkCacheKey(taskId, board), JSON.stringify(value));
  } catch {
    // The request still succeeded; storage is only an acceleration layer.
  }
  return items;
}
