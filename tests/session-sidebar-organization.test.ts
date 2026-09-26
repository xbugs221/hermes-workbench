import { describe, expect, it, vi } from 'vitest';

import { listSessions, searchSessions } from '../dashboard/src/session-api';
import {
  defaultExpandedSessionGroups,
  groupSessionRows,
  normalizeProfileNames,
  organizeSessionRows,
  sessionMatchesView,
  sessionTimeGroup,
  sessionViewForRows,
  type SessionOrganizationMap,
} from '../dashboard/src/session-organization';

const organization: SessionOrganizationMap = {
  alpha: { profile: 'default', sessionId: 'alpha', displayName: '', collection: 'Project B', tags: [], pinned: false, summary: '', updatedAt: 0 },
  beta: { profile: 'default', sessionId: 'beta', displayName: '', collection: 'Project A', tags: ['needle'], pinned: true, summary: '', updatedAt: 0 },
};

describe('Workbench session sidebar organization', () => {
  it('opens today and the previous seven days for each fresh sidebar state', () => {
    const first = defaultExpandedSessionGroups();
    const second = defaultExpandedSessionGroups();
    expect([...first]).toEqual(['today', 'week']);
    first.delete('today');
    expect([...second]).toEqual(['today', 'week']);
  });

  it('normalizes the complete profile catalog with default first', () => {
    expect(normalizeProfileNames({ profiles: [{ name: 'writer' }, { name: 'default' }, { name: 'health-advisor' }, { name: 'writer' }] }))
      .toEqual(['default', 'writer', 'health-advisor']);
    expect(normalizeProfileNames(null)).toEqual(['default']);
  });

  it('keeps cron sessions in their dedicated view', () => {
    expect(sessionMatchesView({ source: 'cron' }, 'cron')).toBe(true);
    expect(sessionMatchesView({ source: 'cron' }, 'conversations')).toBe(false);
    expect(sessionMatchesView({ source: 'cli' }, 'conversations')).toBe(true);
  });

  it('infers the source view for deep-linked transcript lineage', () => {
    expect(sessionViewForRows([{ id: 'cron_1', source: 'cron' }])).toBe('cron');
    expect(sessionViewForRows([{ id: 'chat_1', source: 'cli' }])).toBe('conversations');
  });

  it('groups sessions into fixed local-time recency folders', () => {
    const now = new Date(2026, 8, 5, 12, 0, 0).getTime();
    const day = 24 * 60 * 60 * 1000;
    const rows = [
      { id: 'today', updated_at: now / 1000 },
      { id: 'week', updated_at: (now - 2 * day) / 1000 },
      { id: 'month', updated_at: (now - 10 * day) / 1000 },
      { id: 'older', updated_at: (now - 40 * day) / 1000 },
      { id: 'unknown' },
    ];
    expect(rows.map(row => sessionTimeGroup(row, now))).toEqual(['today', 'week', 'month', 'older', 'older']);
    const groups = groupSessionRows(rows, now);
    expect(groups.map(group => group.collection)).toEqual(['today', 'week', 'month', 'older']);
    expect(groups.map(group => group.rows.map(row => row.id)))
      .toEqual([['today'], ['week'], ['month'], ['older', 'unknown']]);
  });

  it('searches organization metadata across every folder and keeps pinned rows first', () => {
    const rows = [{ id: 'alpha' }, { id: 'beta' }];
    expect(organizeSessionRows(rows, organization, 'needle').map(row => row.id)).toEqual(['beta']);
    expect(organizeSessionRows(rows, organization, '').map(row => row.id)).toEqual(['beta', 'alpha']);
  });

  it('filters list pagination at the server before applying the 500-row bound', async () => {
    const fetchJSON = vi.fn(async (url: string) => {
      expect(url).toContain('exclude_sources=cron');
      return { sessions: [{ id: 'chat', source: 'cli' }], total: 1 };
    });
    const result = await listSessions(fetchJSON as any, 'default');
    expect(result.sessions.map(row => row.id)).toEqual(['chat']);
    expect(fetchJSON).toHaveBeenCalledTimes(1);
  });

  it('always excludes automation from manual conversation search', async () => {
    const fetchJSON = vi.fn(async (url: string) => {
      expect(url).toContain('/api/sessions/search?');
      expect(url).toContain('profile=writer');
      expect(url).toContain('exclude_sources=cron');
      expect(url).not.toMatch(/[?&]source=cron/);
      return { results: [{ id: 'chat_1', source: 'cli' }] };
    });
    const result = await searchSessions(fetchJSON as any, 'writer', 'daily brief');
    expect(result.map(row => row.id)).toEqual(['chat_1']);
  });
});
