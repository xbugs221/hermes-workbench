import { describe, expect, it } from 'vitest';

import { drawerConversationPath, workbenchPath } from '../dashboard/src/kanban-session-bridge';

describe('Kanban session Workbench URLs', () => {
  it('opens a historical binding on /chat with complete Kanban context', () => {
    const path = workbenchPath('task / 42', 'delivery board', {
      board: 'delivery board',
      task_id: 'task / 42',
      profile: 'research profile',
      session_id: 'session / abc',
      created_at: 123,
    });
    const url = new URL(path, 'https://dashboard.invalid');

    expect(url.pathname).toBe('/chat');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      profile: 'research profile',
      kanban_task: 'task / 42',
      kanban_board: 'delivery board',
      session: 'session / abc',
    });
  });

  it('starts a new discussion on /chat without a session parameter', () => {
    const path = workbenchPath('task-new', 'planning');
    const url = new URL(path, 'https://dashboard.invalid');

    expect(url.pathname).toBe('/chat');
    expect(url.searchParams.get('profile')).toBe('default');
    expect(url.searchParams.get('kanban_task')).toBe('task-new');
    expect(url.searchParams.get('kanban_board')).toBe('planning');
    expect(url.searchParams.has('session')).toBe(false);
  });

  it('starts a drawer discussion with the selected Agent when no binding exists', () => {
    const url = new URL(
      drawerConversationPath('task-new', 'planning', 'research', []),
      'https://dashboard.invalid',
    );

    expect(url.searchParams.get('profile')).toBe('research');
    expect(url.searchParams.get('kanban_task')).toBe('task-new');
    expect(url.searchParams.has('session')).toBe(false);
  });

  it('continues the existing fixed discussion instead of creating a duplicate', () => {
    const url = new URL(drawerConversationPath('task-1', 'planning', 'default', [{
      board: 'planning', task_id: 'task-1', profile: 'research', session_id: 'session-1', created_at: 123,
    }]), 'https://dashboard.invalid');

    expect(url.searchParams.get('profile')).toBe('research');
    expect(url.searchParams.get('session')).toBe('session-1');
  });
});