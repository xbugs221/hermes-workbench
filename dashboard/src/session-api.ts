/**
 * 文件目的：通过 Hermes Dashboard 受认证 GET API 读取会话及 compression lineage。
 * 业务边界：不得发送写请求；旧版 messages 路由解析到后代时使用只读 export GET 回退。
 */
import {
  isHermesCompressionContinuation,
  normalizeHermesTranscript,
  type HermesRecord,
  type HermesTurn,
} from './hermes-transcript';


type FetchJSON = <T>(url: string, init?: RequestInit) => Promise<T>;
type SessionsResponse = { sessions?: HermesRecord[]; total?: number };
type MessagesResponse = { session_id?: string; messages?: HermesRecord[]; pagination?: { returned?: number } };
type LatestDescendantResponse = { session_id?: string; path?: unknown[] };
type SearchResponse = { results?: HermesRecord[] };

export type WorkbenchTranscript = {
  profile: string;
  sessionId: string;
  lineage: HermesRecord[];
  rows: HermesRecord[];
  turns: HermesTurn[];
};

export type SessionListResult = {
  sessions: HermesRecord[];
  total: number;
  complete: boolean;
};

const SESSION_NOT_FOUND_PATTERN = /\b404\b.*session not found|session not found.*\b404\b/i;

const SESSION_PAGE_SIZE = 100;
const SESSION_READ_ONLY_LIMIT = 500;

/** Convert a missing deep-linked session into a clear, non-actionable user message. */
export function sessionLoadErrorMessage(reason: unknown): string {
  const message = String(reason);
  if (SESSION_NOT_FOUND_PATTERN.test(message)) {
    return '会话不存在或已删除，聊天未恢复。请选择其他会话或新建会话。 / Session unavailable; chat was not resumed.';
  }
  return message;
}

/** 对查询参数编码，避免 profile/session 深链改变请求结构。 */
function query(value: string): string {
  return encodeURIComponent(value);
}

/** Read one bounded source-filtered page without triggering auto-archive writes. */
async function sessionPage(
  fetchJSON: FetchJSON,
  profile: string,
  offset: number,
): Promise<SessionsResponse> {
  return await fetchJSON<SessionsResponse>(
    `/api/profiles/sessions?limit=${SESSION_PAGE_SIZE}&offset=${offset}&archived=include&order=recent&profile=${query(profile)}&exclude_sources=cron`,
  );
}

/** Return the stable identity used to remove pinned back-fill duplicates across pages. */
function listedSessionId(row: HermesRecord): string {
  return String(row.id ?? row.session_id ?? '');
}

/** 获取 profile 与来源视图下全部可见逻辑会话，并并行读取首个响应声明的后续分页。 */
export async function listSessions(
  fetchJSON: FetchJSON,
  profile: string,
): Promise<SessionListResult> {
  // /api/sessions 会机会性执行 auto-archive；跨 profile 聚合端点明确只读。
  const first = await sessionPage(fetchJSON, profile, 0);
  const firstRows = Array.isArray(first.sessions) ? first.sessions : [];
  const total = Number.isFinite(Number(first.total)) ? Math.max(0, Number(first.total)) : firstRows.length;
  const readableTotal = Math.min(total, SESSION_READ_ONLY_LIMIT);
  const offsets: number[] = [];
  for (let offset = SESSION_PAGE_SIZE; offset < readableTotal; offset += SESSION_PAGE_SIZE) {
    offsets.push(offset);
  }
  const remaining = await Promise.all(offsets.map(offset => sessionPage(fetchJSON, profile, offset)));
  const seen = new Set<string>();
  const sessions = [first, ...remaining].flatMap(page => Array.isArray(page.sessions) ? page.sessions : [])
    .filter(row => {
      const id = listedSessionId(row);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  return {
    sessions,
    total,
    complete: total <= SESSION_READ_ONLY_LIMIT && sessions.length >= total,
  };
}

/** 使用 Hermes 只读全文索引搜索全部会话，并返回去重后的 compression tip。 */
export async function searchSessions(
  fetchJSON: FetchJSON,
  profile: string,
  search: string,
): Promise<HermesRecord[]> {
  const response = await fetchJSON<SearchResponse>(
    `/api/sessions/search?q=${query(search)}&limit=100&profile=${query(profile)}&exclude_sources=cron`,
  );
  return Array.isArray(response.results) ? response.results : [];
}

/** 读取一条完整会话记录。 */
async function sessionDetail(fetchJSON: FetchJSON, profile: string, sessionId: string): Promise<HermesRecord> {
  return await fetchJSON<HermesRecord>(`/api/sessions/${query(sessionId)}?profile=${query(profile)}`);
}

/** 快速确认历史会话仍存在，供聊天预热在连接 PTY 前阻止失效深链。 */
export async function validateSession(
  fetchJSON: FetchJSON,
  profile: string,
  sessionId: string,
): Promise<void> {
  await sessionDetail(fetchJSON, profile, sessionId);
}

/** 向上收集 compression parent，普通 branch/delegate 在此停止。 */
async function loadLineage(fetchJSON: FetchJSON, profile: string, tipId: string): Promise<HermesRecord[]> {
  const lineage: HermesRecord[] = [];
  const seen = new Set<string>();
  let child = await sessionDetail(fetchJSON, profile, tipId);
  while (!seen.has(String(child.id))) {
    seen.add(String(child.id));
    lineage.unshift(child);
    if (!child.parent_session_id) break;
    const parent = await sessionDetail(fetchJSON, profile, String(child.parent_session_id));
    if (!isHermesCompressionContinuation(child, parent)) break;
    child = parent;
  }
  return lineage;
}

/** latest-descendant 误入 sibling branch 时，用只读 ID 搜索恢复 compression tip。 */
async function searchedCompressionTip(
  fetchJSON: FetchJSON,
  profile: string,
  rootId: string,
): Promise<string | null> {
  try {
    const response = await fetchJSON<SearchResponse>(
      `/api/sessions/search?q=${query(rootId)}&limit=1&profile=${query(profile)}`,
    );
    const candidate = Array.isArray(response.results) ? response.results[0] : undefined;
    const candidateId = String(candidate?.session_id || candidate?.id || '');
    if (!candidateId || candidateId === rootId) return null;
    const lineage = await loadLineage(fetchJSON, profile, candidateId);
    const lineageRoot = String(lineage[0]?.id || '');
    return lineageRoot === rootId ? String(lineage.at(-1)?.id || candidateId) : null;
  } catch {
    return null;
  }
}

/** 校验 latest-descendant 路径，只接受连续 compression 边，拒绝 branch/delegate 跳转。 */
async function inspectionTip(fetchJSON: FetchJSON, profile: string, requestedSessionId: string): Promise<string> {
  const latest = await fetchJSON<LatestDescendantResponse>(
    `/api/sessions/${query(requestedSessionId)}/latest-descendant?profile=${query(profile)}`,
  );
  const pathIds = Array.isArray(latest.path)
    ? latest.path.map(value => String(value)).filter(Boolean)
    : [];
  if (pathIds[0] !== requestedSessionId) pathIds.unshift(requestedSessionId);

  let parent = await sessionDetail(fetchJSON, profile, requestedSessionId);
  const requested = parent;
  const requestedId = String(requested.id || requestedSessionId);
  let tipId = requestedId;
  for (const candidateId of pathIds.slice(1)) {
    const child = await sessionDetail(fetchJSON, profile, candidateId);
    if (!isHermesCompressionContinuation(child, parent)) break;
    tipId = String(child.id || candidateId);
    parent = child;
  }
  if (tipId === requestedId && requested.end_reason === 'compression') {
    return await searchedCompressionTip(fetchJSON, profile, requestedId) || tipId;
  }
  return tipId;
}

/** 读取指定节点的真实消息；如果宿主把 parent 自动解析到 child，则回退到只读导出端点。 */
async function exactMessages(fetchJSON: FetchJSON, profile: string, sessionId: string): Promise<HermesRecord[]> {
  const rows: HermesRecord[] = [];
  let offset = 0;
  while (true) {
    const response = await fetchJSON<MessagesResponse>(
      `/api/sessions/${query(sessionId)}/messages?profile=${query(profile)}&limit=500&offset=${offset}`,
    );
    if (response.session_id && String(response.session_id) !== sessionId) {
      const exported = await fetchJSON<HermesRecord>(`/api/sessions/${query(sessionId)}/export?profile=${query(profile)}`);
      return Array.isArray(exported.messages) ? exported.messages : [];
    }
    const page = Array.isArray(response.messages) ? response.messages : [];
    rows.push(...page);
    if (page.length < 500) return rows;
    offset += page.length;
  }
}

/** 单请求读取最新消息，作为冷缓存时三秒内可见的首屏记录。 */
export async function loadRecentTranscript(
  fetchJSON: FetchJSON,
  profile: string,
  requestedSessionId: string,
  limit = 160,
): Promise<WorkbenchTranscript> {
  const response = await fetchJSON<MessagesResponse>(
    `/api/sessions/${query(requestedSessionId)}/messages?profile=${query(profile)}&limit=${limit}&order=latest`,
  );
  const sessionId = String(response.session_id || requestedSessionId);
  const rows = (Array.isArray(response.messages) ? response.messages : []).map(row => ({
    ...row,
    session_id: row.session_id || sessionId,
  }));
  const lineage = [{ id: sessionId }];
  return { profile, sessionId, lineage, rows, turns: normalizeHermesTranscript(rows, [sessionId]) };
}

/** 解析深链到最新后代，加载完整 lineage，并生成共享 turn 投影。 */
export async function loadTranscript(
  fetchJSON: FetchJSON,
  profile: string,
  requestedSessionId: string,
): Promise<WorkbenchTranscript> {
  const sessionId = await inspectionTip(fetchJSON, profile, requestedSessionId);
  const lineage = await loadLineage(fetchJSON, profile, sessionId);
  const pages = await Promise.all(lineage.map(row => exactMessages(fetchJSON, profile, String(row.id))));
  const rows = pages.flatMap((page, index) => page.map(row => ({
    ...row,
    session_id: row.session_id || String(lineage[index].id),
  })));
  const lineageIds = lineage.map(row => String(row.id));
  return { profile, sessionId, lineage, rows, turns: normalizeHermesTranscript(rows, lineageIds) };
}
