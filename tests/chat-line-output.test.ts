import { expect, it } from 'vitest';
import { visibleChatText } from '../dashboard/src/chat-line-output';

it('shows commentary deltas before a newline or item/turn completion', () => {
  const message = { role: 'assistant', phase: 'commentary', status: 'running', content: '' };
  for (const delta of ['已核对配置，', '正在验证实际调用。']) {
    message.content += delta;
    expect(visibleChatText(message)).toBe(message.content);
  }
});

it('keeps completed commentary visible when a running snapshot inherits the turn status', () => {
  const content = '配置已核对，正在验证实际调用。';
  const message = { role: 'assistant', phase: 'commentary', status: 'completed', content };
  expect(visibleChatText(message)).toBe(content);
  expect(visibleChatText({ ...message, status: 'running' })).toBe(content);
  expect(visibleChatText({ ...message, phase: 'final', status: 'running' })).toBe('');
});

it('reveals only complete lines regardless of delta boundaries', () => {
  const message = { role: 'assistant', status: 'running', content: '' };
  const chunks = ['第一', '行', '\n第', '二行\r', '\n末行'];
  const expected = ['', '', '第一行\n', '第一行\n', '第一行\n第二行\r\n'];
  chunks.forEach((chunk, index) => {
    message.content += chunk;
    expect(visibleChatText(message)).toBe(expected[index]);
  });
  for (const status of ['completed', 'failed', 'interrupted']) {
    expect(visibleChatText({ ...message, status })).toBe('第一行\n第二行\r\n末行');
  }
});

it('buffers reasoning and partial Markdown without buffering users or tools', () => {
  const content = '```python\nprint("partial';
  expect(visibleChatText({ role: 'reasoning', status: 'running', content })).toBe('```python\n');
  for (const role of ['user', 'tool']) {
    expect(visibleChatText({ role, status: 'running', content })).toBe(content);
  }
  expect(visibleChatText({ role: 'assistant', status: 'completed', content })).toBe(content);
});
