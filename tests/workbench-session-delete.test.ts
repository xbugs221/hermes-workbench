import { describe, expect, it, vi } from 'vitest';

import {
  deleteSession,
  requestSessionDeletion,
  sessionDeleteConfirmation,
  sessionDeletionAvailable,
} from '../dashboard/src/session-delete';

function localeRoot(lang: string): Pick<Document, 'documentElement'> {
  return { documentElement: { lang } } as Pick<Document, 'documentElement'>;
}

function deletionOptions(overrides: Record<string, unknown> = {}) {
  return {
    fetchJSON: vi.fn().mockResolvedValue({ ok: true }),
    profile: 'research agent',
    sessionId: 'session / 1',
    title: 'Release notes',
    currentSessionId: 'another-session',
    view: 'conversations' as const,
    localeRoot: localeRoot('en'),
    confirm: vi.fn(() => true),
    onCurrentDeleted: vi.fn(),
    onRefresh: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('Workbench session deletion', () => {
  it('uses the Hermes single-session DELETE endpoint and explicit owning profile', async () => {
    const fetchJSON = vi.fn().mockResolvedValue({ ok: true });

    await deleteSession(fetchJSON, 'research agent', 'session / 1');

    expect(fetchJSON).toHaveBeenCalledWith(
      '/api/sessions/session%20%2F%201?profile=research%20agent',
      { method: 'DELETE' },
    );
  });

  it('requires confirmation and leaves every state callback untouched when cancelled', async () => {
    const options = deletionOptions({ confirm: vi.fn(() => false) });

    await expect(requestSessionDeletion(options)).resolves.toBe('cancelled');

    expect(options.confirm).toHaveBeenCalledWith(
      'Permanently delete session “Release notes”? This action cannot be undone.',
    );
    expect(options.fetchJSON).not.toHaveBeenCalled();
    expect(options.onCurrentDeleted).not.toHaveBeenCalled();
    expect(options.onRefresh).not.toHaveBeenCalled();
  });

  it('refreshes a non-current row without resetting the active conversation', async () => {
    const options = deletionOptions();

    await expect(requestSessionDeletion(options)).resolves.toBe('deleted');

    expect(options.onCurrentDeleted).not.toHaveBeenCalled();
    expect(options.onRefresh).toHaveBeenCalledOnce();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it('resets the active state before refreshing after deleting the current conversation', async () => {
    const order: string[] = [];
    const options = deletionOptions({
      currentSessionId: 'session / 1',
      onCurrentDeleted: vi.fn(() => order.push('reset')),
      onRefresh: vi.fn(() => order.push('refresh')),
    });

    await expect(requestSessionDeletion(options)).resolves.toBe('deleted');

    expect(order).toEqual(['reset', 'refresh']);
  });

  it('never offers or executes deletion in the cron read-only view', async () => {
    const options = deletionOptions({ view: 'cron' });

    expect(sessionDeletionAvailable('conversations')).toBe(true);
    expect(sessionDeletionAvailable('cron')).toBe(false);
    await expect(requestSessionDeletion(options)).resolves.toBe('unavailable');

    expect(options.confirm).not.toHaveBeenCalled();
    expect(options.fetchJSON).not.toHaveBeenCalled();
    expect(options.onRefresh).not.toHaveBeenCalled();
  });

  it('localizes destructive confirmation and failures as complete Chinese or English messages', async () => {
    expect(sessionDeleteConfirmation('发布记录', localeRoot('zh-CN')))
      .toBe('永久删除会话“发布记录”？此操作无法撤销。');

    const options = deletionOptions({
      fetchJSON: vi.fn().mockRejectedValue(new Error('denied')),
      localeRoot: localeRoot('zh-CN'),
    });
    await expect(requestSessionDeletion(options)).resolves.toBe('failed');

    expect(options.onError).toHaveBeenCalledWith('删除会话失败：Error: denied');
    expect(options.onCurrentDeleted).not.toHaveBeenCalled();
    expect(options.onRefresh).not.toHaveBeenCalled();
  });
});
