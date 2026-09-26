/**
 * 文件目的：把 OZW 移动终端快捷键语义映射为 PTY/xterm 字节序列。
 * 移动端辅助按键转换为终端可识别的输入序列。
 */
export type TerminalHelperKey = 'escape' | 'tab' | 'arrowUp' | 'arrowDown' | 'arrowLeft' | 'arrowRight';

const NORMAL_INPUT: Record<TerminalHelperKey, string> = {
  escape: '\x1b',
  tab: '\t',
  arrowUp: '\x1b[A',
  arrowDown: '\x1b[B',
  arrowLeft: '\x1b[D',
  arrowRight: '\x1b[C',
};

const CTRL_INPUT: Partial<Record<TerminalHelperKey, string>> = {
  arrowUp: '\x1b[1;5A',
  arrowDown: '\x1b[1;5B',
  arrowLeft: '\x1b[1;5D',
  arrowRight: '\x1b[1;5C',
};

const CTRL_CHARACTER_INPUT: Record<string, string> = {
  ' ': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
};

/** 返回辅助键对应的 PTY 输入；Ctrl 锁定时方向键使用 xterm 修饰序列。 */
export function terminalHelperKeyInput(key: TerminalHelperKey, ctrlActive: boolean): string {
  return (ctrlActive ? CTRL_INPUT[key] : undefined) || NORMAL_INPUT[key];
}

/** 把虚拟 Ctrl 与随后输入的字符/方向键组合为控制字节。 */
export function virtualCtrlInput(key: string): string | null {
  if (key.length === 1) {
    const lowerKey = key.toLowerCase();
    if (lowerKey >= 'a' && lowerKey <= 'z') {
      return String.fromCharCode(lowerKey.charCodeAt(0) - 96);
    }
    return CTRL_CHARACTER_INPUT[key] || null;
  }

  const browserKeys: Partial<Record<string, TerminalHelperKey>> = {
    ArrowUp: 'arrowUp',
    ArrowDown: 'arrowDown',
    ArrowLeft: 'arrowLeft',
    ArrowRight: 'arrowRight',
    Escape: 'escape',
    Tab: 'tab',
  };
  const helperKey = browserKeys[key];
  return helperKey ? terminalHelperKeyInput(helperKey, true) : null;
}
