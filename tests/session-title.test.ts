import { expect, it } from 'vitest';
import { resolveSessionTitle } from '../dashboard/src/session-title';

it('keeps authoritative titles when opening or refreshing a conversation', () => {
  const session = { id: 'session', title: '用户指定标题' };
  expect(resolveSessionTitle(session, session, '首条消息')).toBe('用户指定标题');
  expect(resolveSessionTitle(session, { ...session, title: '服务器新标题' }, '首条消息')).toBe('服务器新标题');
  expect(resolveSessionTitle(session, { ...session, title: 'session' }, '首条消息')).toBe('用户指定标题');
});

it('only uses the first message when no meaningful name exists', () => {
  expect(resolveSessionTitle({ id: 's', title: 's' }, null, '第一行\n第二行')).toBe('第一行');
  expect(resolveSessionTitle({ id: 's', title: '' })).toBe('s');
});
