import { describe, expect, it } from 'vitest';

import {
  resetTerminalTextarea,
  shouldBlockComposingEnter,
  shouldRepairStaleMobileInput,
  shouldResetMobileTerminalInput,
} from '../dashboard/src/terminal-ime';

describe('mobile chat IME Enter', () => {
  it('blocks Enter while composition is active but leaves desktop unchanged', () => {
    expect(shouldBlockComposingEnter(
      { isComposing: true, key: 'Enter', type: 'keydown' }, true, true,
    )).toBe(true);
    expect(shouldBlockComposingEnter(
      { isComposing: true, key: 'Enter', type: 'keydown' }, true, false,
    )).toBe(false);
  });

  it('clears only mobile chat CR submissions, not multiline LF', () => {
    expect(shouldResetMobileTerminalInput('chat', true, '\r')).toBe(true);
    expect(shouldResetMobileTerminalInput('chat', true, '\n')).toBe(false);
    expect(shouldResetMobileTerminalInput('shell', true, '\r')).toBe(false);
    expect(shouldResetMobileTerminalInput('chat', false, '\r')).toBe(false);
  });

  it('repairs only an unchanged submitted IME buffer', () => {
    expect(shouldRepairStaleMobileInput('上一条消息', '上一条消息')).toBe(true);
    expect(shouldRepairStaleMobileInput('上一条消息', '')).toBe(false);
    expect(shouldRepairStaleMobileInput('上一条消息', '新输入')).toBe(false);
    expect(shouldRepairStaleMobileInput('', '')).toBe(false);
  });

  it('clears the settled xterm textarea value and selection', () => {
    const selections: Array<[number, number]> = [];
    const textarea = {
      value: '上一条消息',
      setSelectionRange: (start: number, end: number) => { selections.push([start, end]); },
    };
    resetTerminalTextarea(textarea);

    expect(textarea.value).toBe('');
    expect(selections).toEqual([[0, 0]]);
  });
});
