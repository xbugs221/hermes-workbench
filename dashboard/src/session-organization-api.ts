/**
 * 文件目的：通过 Hermes Dashboard 的认证客户端读取和保存 Workbench 会话组织元数据。
 * 业务边界：只调用插件自身 API，不修改 Hermes 原生会话表。
 */
import {
  indexSessionOrganization,
  normalizeSessionOrganization,
  type SessionOrganization,
  type SessionOrganizationMap,
} from './session-organization';

type FetchJSON = <T>(url: string, init?: RequestInit) => Promise<T>;
const ORGANIZATION_API = '/api/plugins/workbench/session-organization';

/** Encode one query parameter without letting profile text alter the endpoint. */
function query(value: string): string {
  return encodeURIComponent(value);
}

/** Load all organization metadata for the active profile. */
export async function loadSessionOrganization(
  fetchJSON: FetchJSON,
  profile: string,
): Promise<SessionOrganizationMap> {
  const response = await fetchJSON<{ items?: unknown[] }>(
    `${ORGANIZATION_API}?profile=${query(profile)}`,
  );
  return indexSessionOrganization(response?.items);
}

/** Persist the complete organization state for one session. */
export async function saveSessionOrganization(
  fetchJSON: FetchJSON,
  value: SessionOrganization,
): Promise<SessionOrganization | null> {
  const response = await fetchJSON<any>(ORGANIZATION_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: value.profile,
      session_id: value.sessionId,
      display_name: value.displayName,
      collection: value.collection,
      tags: value.tags,
      pinned: value.pinned,
      summary: value.summary,
    }),
  });
  if (response?.deleted === true) return null;
  return normalizeSessionOrganization(response);
}
