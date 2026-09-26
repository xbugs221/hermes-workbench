/** Ensure native Kanban deletes stay in the board currently displayed. */

const KANBAN_TASK_PATH = /^\/api\/plugins\/kanban\/tasks\/[^/]+$/;

function selectedBoard(location: Location, storage: Storage): string {
  const explicit = new URLSearchParams(location.search).get('board')?.trim();
  if (explicit) return explicit;
  try {
    return storage.getItem('hermes.kanban.selectedBoard')?.trim() || '';
  } catch {
    return '';
  }
}

/** Add the board only to native task DELETE requests that omitted it. */
export function scopedKanbanDeleteUrl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  location: Location = window.location,
  storage: Storage = window.localStorage,
): string | null {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  if (method !== 'DELETE') return null;

  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin || !KANBAN_TASK_PATH.test(url.pathname) || url.searchParams.has('board')) return null;

  const board = selectedBoard(location, storage);
  if (!board) return null;
  url.searchParams.set('board', board);
  return url.toString();
}

/** Native Kanban currently omits `board` for deletion; intercept only that narrow request shape. */
export function installKanbanDeleteBoardScope(): void {
  const marker = '__HERMES_WORKBENCH_KANBAN_DELETE_BOARD_SCOPE__';
  const target = window as unknown as Record<string, unknown>;
  if (target[marker]) return;
  target[marker] = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const scopedUrl = scopedKanbanDeleteUrl(input, init);
    return nativeFetch(scopedUrl || input, init);
  }) as typeof window.fetch;
}
