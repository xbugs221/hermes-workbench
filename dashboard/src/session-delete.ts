/**
 * 文件目的：通过 Hermes 已认证会话 API 执行单条破坏性删除，并统一确认与后续状态分支。
 * 业务边界：仅普通对话可删除；profile 必须来自会话所属列表行，不能隐式依赖宿主当前配置。
 */
import type { SessionView } from './session-organization';
import { uiText } from './ui-locale';

type FetchJSON = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface SessionDeletionOptions {
  fetchJSON: FetchJSON;
  profile: string;
  sessionId: string;
  title: string;
  currentSessionId: string;
  view: SessionView;
  localeRoot?: Pick<Document, 'documentElement'>;
  confirm: (message: string) => boolean;
  onCurrentDeleted: () => void;
  onRefresh: () => void;
  onError: (message: string) => void;
}

export type SessionDeletionResult = 'cancelled' | 'deleted' | 'failed' | 'unavailable';

/** Cron rows are transcript-only and must not expose destructive actions. */
export function sessionDeletionAvailable(view: SessionView): boolean {
  return view === 'conversations';
}

function query(value: string): string {
  return encodeURIComponent(value);
}

/** Delete exactly one session from its owning profile store. */
export async function deleteSession(
  fetchJSON: FetchJSON,
  profile: string,
  sessionId: string,
): Promise<void> {
  await fetchJSON<{ ok: boolean }>(
    `/api/sessions/${query(sessionId)}?profile=${query(profile)}`,
    { method: 'DELETE' },
  );
}

/** Build a single-language destructive confirmation; the session title remains user-authored text. */
export function sessionDeleteConfirmation(
  title: string,
  root: Pick<Document, 'documentElement'> = document,
): string {
  return uiText(
    `永久删除会话“${title}”？此操作无法撤销。`,
    `Permanently delete session “${title}”? This action cannot be undone.`,
    root,
  );
}

/**
 * Run the complete delete behavior. Current deletion resets the active chat;
 * non-current deletion deliberately leaves it untouched and only refreshes the list.
 */
export async function requestSessionDeletion(options: SessionDeletionOptions): Promise<SessionDeletionResult> {
  if (!sessionDeletionAvailable(options.view)) return 'unavailable';
  if (!options.confirm(sessionDeleteConfirmation(options.title, options.localeRoot))) return 'cancelled';

  try {
    await deleteSession(options.fetchJSON, options.profile, options.sessionId);
    if (options.currentSessionId === options.sessionId) options.onCurrentDeleted();
    options.onRefresh();
    return 'deleted';
  } catch (reason) {
    options.onError(uiText(
      `删除会话失败：${String(reason)}`,
      `Failed to delete session: ${String(reason)}`,
      options.localeRoot,
    ));
    return 'failed';
  }
}
