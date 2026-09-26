/**
 * 文件目的：提供 Workbench 会话显示名称、集合、标签、固定、摘要的纯归一化与筛选规则。
 * 业务边界：不执行网络或存储操作，供界面和 Node 测试共享。
 */

export const ALL_COLLECTIONS = '__all_collections__';
export const UNGROUPED_COLLECTION = '__ungrouped_collection__';

export interface SessionOrganization {
  profile: string;
  sessionId: string;
  displayName: string;
  collection: string;
  tags: string[];
  pinned: boolean;
  summary: string;
  updatedAt: number;
}

export type SessionOrganizationMap = Record<string, SessionOrganization>;

export type SessionView = 'conversations' | 'cron';

export interface SessionCollectionGroup {
  collection: string;
  rows: Array<Record<string, any>>;
}

export const SESSION_TIME_GROUPS = ['today', 'week', 'month', 'older'] as const;
export type SessionTimeGroup = typeof SESSION_TIME_GROUPS[number];

/** Open the two most useful recency folders on every fresh sidebar state. */
export function defaultExpandedSessionGroups(): Set<SessionTimeGroup> {
  return new Set<SessionTimeGroup>(['today', 'week']);
}

export interface CollectionOverview {
  collection: string;
  sessionCount: number;
  pinnedCount: number;
  tags: string[];
  summaries: Array<{ sessionId: string; title: string; summary: string }>;
}

/** Return the stable session identity shared by Hermes API response variants. */
export function sessionRowId(row: Record<string, any>): string {
  return String(row.id ?? row.session_id ?? '');
}

/** Return the title supplied by Hermes before any Workbench display override. */
export function sessionNativeTitle(row: Record<string, any>): string {
  return String(row.title || row.summary || row.name || row.id || row.session_id || '未命名会话 / Untitled');
}

/** Prefer the user-owned Workbench display name while retaining the Hermes title as fallback. */
export function sessionDisplayTitle(
  row: Record<string, any>,
  organization?: SessionOrganization | null,
): string {
  return organization?.displayName || sessionNativeTitle(row);
}

/** Return an empty organization object without sharing mutable tag arrays. */
export function emptySessionOrganization(profile: string, sessionId: string): SessionOrganization {
  return {
    profile,
    sessionId,
    displayName: '',
    collection: '',
    tags: [],
    pinned: false,
    summary: '',
    updatedAt: 0,
  };
}

/** Normalize one untrusted API row into the narrow frontend organization contract. */
export function normalizeSessionOrganization(value: any): SessionOrganization | null {
  if (!value || typeof value !== 'object') return null;
  const sessionId = String(value.session_id ?? value.sessionId ?? '').trim();
  if (!sessionId) return null;
  const seen = new Set<string>();
  const tags = (Array.isArray(value.tags) ? value.tags : []).flatMap((raw: unknown): string[] => {
    const tag = String(raw ?? '').trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
  return {
    profile: String(value.profile ?? 'default').trim() || 'default',
    sessionId,
    displayName: String(value.display_name ?? value.displayName ?? '').trim(),
    collection: String(value.collection ?? '').trim(),
    tags,
    pinned: value.pinned === true,
    summary: String(value.summary ?? '').trim(),
    updatedAt: Number.isFinite(Number(value.updated_at ?? value.updatedAt))
      ? Number(value.updated_at ?? value.updatedAt)
      : 0,
  };
}

/** Index organization rows by session id for O(1) rendering and update lookups. */
export function indexSessionOrganization(values: unknown): SessionOrganizationMap {
  const rows = Array.isArray(values) ? values : [];
  const result: SessionOrganizationMap = {};
  for (const value of rows) {
    const normalized = normalizeSessionOrganization(value);
    if (normalized) result[normalized.sessionId] = normalized;
  }
  return result;
}

/** Return distinct collection names in stable locale-aware order. */
export function collectionNames(values: SessionOrganizationMap): string[] {
  const names = new Set<string>();
  for (const value of Object.values(values)) {
    if (value.collection) names.add(value.collection);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** Normalize the host profile catalog without dropping entries or allowing a stale default. */
export function normalizeProfileNames(value: unknown): string[] {
  const payload = value && typeof value === 'object' ? value as { profiles?: unknown } : {};
  const rows = Array.isArray(payload.profiles) ? payload.profiles : [];
  const names = new Set<string>(['default']);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = String((row as { name?: unknown }).name ?? '').trim();
    if (name) names.add(name);
  }
  return ['default', ...[...names].filter(name => name !== 'default')];
}

/** Keep scheduled runs out of ordinary chat history and expose them through their own view. */
export function sessionMatchesView(row: Record<string, any>, view: SessionView): boolean {
  const scheduled = String(row.source ?? '').trim().toLocaleLowerCase() === 'cron';
  return view === 'cron' ? scheduled : !scheduled;
}

/** Infer the source tab for a deep-linked transcript from its persisted lineage. */
export function sessionViewForRows(rows: Array<Record<string, any>>): SessionView {
  return rows.some(row => sessionMatchesView(row, 'cron')) ? 'cron' : 'conversations';
}

/** Merge recent and FTS result rows without changing the first occurrence order. */
export function mergeSessionRows(...groups: Array<Array<Record<string, any>>>): Array<Record<string, any>> {
  const seen = new Set<string>();
  const merged: Array<Record<string, any>> = [];
  for (const group of groups) {
    for (const row of group) {
      const id = sessionRowId(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
  }
  return merged;
}

/** Search native/server metadata across every collection, then keep pinned sessions first. */
export function organizeSessionRows(
  rows: Array<Record<string, any>>,
  organization: SessionOrganizationMap,
  query: string,
  serverMatchIds: ReadonlySet<string> = new Set<string>(),
): Array<Record<string, any>> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return rows
    .map((row, index) => ({ row, index, id: sessionRowId(row), meta: organization[sessionRowId(row)] }))
    .filter(({ id, meta }) => {
      if (!id) return false;
      if (!normalizedQuery || serverMatchIds.has(id)) return true;
      const metadataText = [meta?.displayName, meta?.collection, ...(meta?.tags ?? []), meta?.summary]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase();
      return metadataText.includes(normalizedQuery);
    })
    .sort((left, right) => {
      const pinDifference = Number(Boolean(right.meta?.pinned)) - Number(Boolean(left.meta?.pinned));
      if (pinDifference !== 0) return pinDifference;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

/** Place a session into deterministic local-time recency buckets. */
export function sessionTimeGroup(row: Record<string, any>, now = Date.now()): SessionTimeGroup {
  const raw = row.updated_at ?? row.last_active ?? row.created_at ?? row.timestamp;
  const numeric = typeof raw === 'number' && raw < 1_000_000_000_000 ? raw * 1000 : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'older';
  const current = new Date(now);
  const todayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  if (numeric >= todayStart) return 'today';
  const day = 24 * 60 * 60 * 1000;
  if (numeric >= now - 7 * day) return 'week';
  if (numeric >= now - 30 * day) return 'month';
  return 'older';
}

/** Build fixed recency folders; organization metadata remains available as tags, not navigation. */
export function groupSessionRows(
  rows: Array<Record<string, any>>,
  now = Date.now(),
): SessionCollectionGroup[] {
  const grouped = new Map<string, Array<Record<string, any>>>();
  for (const row of rows) {
    const collection = sessionTimeGroup(row, now);
    const group = grouped.get(collection) || [];
    group.push(row);
    grouped.set(collection, group);
  }
  return SESSION_TIME_GROUPS.flatMap(collection => {
    const groupRows = grouped.get(collection);
    return groupRows?.length ? [{ collection, rows: groupRows }] : [];
  });
}

/** Aggregate the visible business value of one collection without another model call. */
export function buildCollectionOverview(
  rows: Array<Record<string, any>>,
  organization: SessionOrganizationMap,
  collection: string,
): CollectionOverview | null {
  if (!collection || collection === ALL_COLLECTIONS || collection === UNGROUPED_COLLECTION) return null;
  const tags = new Set<string>();
  const summaries: CollectionOverview['summaries'] = [];
  let sessionCount = 0;
  let pinnedCount = 0;
  for (const row of rows) {
    const sessionId = sessionRowId(row);
    const meta = organization[sessionId];
    if (!meta || meta.collection !== collection) continue;
    sessionCount += 1;
    if (meta.pinned) pinnedCount += 1;
    meta.tags.forEach(tag => tags.add(tag));
    if (meta.summary) {
      summaries.push({
        sessionId,
        title: sessionDisplayTitle(row, meta),
        summary: meta.summary,
      });
    }
  }
  return {
    collection,
    sessionCount,
    pinnedCount,
    tags: [...tags].sort((left, right) => left.localeCompare(right)),
    summaries,
  };
}
