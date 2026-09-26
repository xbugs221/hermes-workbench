import { describe, expect, it } from 'vitest';
import { partitionProjectSessions, projectDropSession } from '../dashboard/src/project-navigation';

describe('manual project membership', () => {
  const projects = [{ id: 'one', name: 'Research' }, { id: 'empty', name: 'Empty' }];
  const sessions = [
    { id: 'assigned', groupId: 'one', favorite: true, workspacePath: '/same' },
    { id: 'temporary', groupId: null, workspacePath: '/same' },
    { id: 'orphan', groupId: 'removed' },
    { id: 'archived', groupId: 'one', deleted: true },
  ];
  it('keeps explicit membership and empty projects, pinning favorites within each section', () => {
    const result = partitionProjectSessions([
      { id: 'later-favorite', groupId: 'one', favorite: true },
      ...sessions,
    ], projects);
    expect(result.groups.map(group => group.sessions.map(session => session.id))).toEqual([['later-favorite', 'assigned'], []]);
    expect(result.temporary.map(session => session.id)).toEqual(['temporary', 'orphan']);
    expect(partitionProjectSessions(sessions, []).temporary.map(session => session.id)).toEqual(['assigned', 'temporary', 'orphan']);
  });
  it('moves only known sessions within their profile, and allows moving back to temporary', () => {
    const drag = (sessionId: string, profile = 'default') => JSON.stringify({ sessionId, profile });
    expect(projectDropSession(drag('temporary'), 'default', 'one', sessions, projects)).toBe(sessions[1]);
    expect(projectDropSession(drag('assigned'), 'default', null, sessions, projects)).toBe(sessions[0]);
    expect(projectDropSession(drag('assigned'), 'default', 'empty', sessions, projects)).toBe(sessions[0]);
    for (const [payload, target] of [
      [drag('temporary', 'other'), 'one'], [drag('missing'), 'one'], [drag('archived'), 'one'],
      [drag('assigned'), 'one'], [drag('temporary'), 'removed'], ['external text', 'one'],
    ]) expect(projectDropSession(payload, 'default', target, sessions, projects)).toBeNull();
  });
});
