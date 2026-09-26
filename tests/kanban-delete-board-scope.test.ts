// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scopedKanbanDeleteUrl } from '../dashboard/src/kanban-delete-board-scope';

describe('Kanban delete board scope', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('adds the native selected board to a task delete', () => {
    window.history.replaceState({}, '', '/kanban');
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('matx');

    expect(scopedKanbanDeleteUrl('/api/plugins/kanban/tasks/t_22095732', { method: 'DELETE' }))
      .toBe(`${window.location.origin}/api/plugins/kanban/tasks/t_22095732?board=matx`);
  });

  it('does not rewrite unrelated requests or an explicit board', () => {
    window.history.replaceState({}, '', '/kanban?board=money');

    expect(scopedKanbanDeleteUrl('/api/plugins/kanban/tasks/t_32560a6b?board=matx', { method: 'DELETE' })).toBeNull();
    expect(scopedKanbanDeleteUrl('/api/plugins/kanban/tasks/t_32560a6b', { method: 'PATCH' })).toBeNull();
    expect(scopedKanbanDeleteUrl('/api/plugins/kanban/boards/money', { method: 'DELETE' })).toBeNull();
  });
});
