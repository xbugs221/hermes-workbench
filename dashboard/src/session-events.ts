/**
 * 文件目的：解析 Hermes PTY sidecar 事件中的当前会话身份。
 * 业务边界：只处理 JSON 事件信封，不建立网络连接，也不依赖浏览器终端。
 */

/** Extract the exact Hermes session id from a session.info event. */
export function sessionIdFromEvent(value: unknown): string | null {
  try {
    const frame = JSON.parse(String(value ?? ''));
    const params = frame?.method === 'event' ? frame.params : null;
    if (params?.type !== 'session.info') return null;
    const sessionId = String(params.session_id ?? '').trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

export type SessionActivityDecision = 'ignore' | 'probe' | 'adopt';

/** 当前记录会话收到自身状态事件后，应重新读取已持久化的 transcript。 */
export function shouldRefreshTranscript(currentSessionId: string, activeSessionId: string): boolean {
  return Boolean(currentSessionId && activeSessionId && currentSessionId === activeSessionId);
}

/** 仅让新聊天接纳已经出现在持久会话列表中的活动 ID。 */
export function sessionActivityDecision(
  currentSessionId: string,
  activeSessionId: string,
  activeSessionIsPersisted: boolean,
): SessionActivityDecision {
  if (!activeSessionId || currentSessionId) return 'ignore';
  return activeSessionIsPersisted ? 'adopt' : 'probe';
}
