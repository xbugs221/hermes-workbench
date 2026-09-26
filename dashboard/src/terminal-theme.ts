import type { ITheme } from '@xterm/xterm';

/** 根据主题实际背景选择高对比 ANSI 色板，避免亮色主题中的黄色文字失去可读性。 */
export function terminalTheme(element: HTMLElement): Record<string, string> {
  const computed = window.getComputedStyle(element);
  // Canvas terminals do not consistently accept CSS Color 4's color(srgb ...).
  // Shared palette tokens are hex, even when the surrounding CSS uses color-mix.
  const background = computed.getPropertyValue('--mc-code').trim() || computed.backgroundColor || '#181c16';
  const foreground = computed.getPropertyValue('--mc-ink').trim() || computed.color || '#e6e6d5';
  const accent = computed.getPropertyValue('--mc-accent').trim();
  const selection = computed.getPropertyValue('--mc-active').trim();
  const channels = /^#[\da-f]{6}$/i.test(background)
    ? background.slice(1).match(/../g)!.map(channel => parseInt(channel, 16))
    : background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
  if (luminance > 0.55) {
    return {
      background,
      foreground,
      cursor: accent || '#496b2d',
      selectionBackground: selection || '#d7dfc7',
      black: '#30352c', red: '#a5342d', green: '#496b2d', yellow: '#80571b',
      blue: '#375b86', magenta: '#7a3e75', cyan: '#286b68', white: '#e8e4d8',
      brightBlack: '#66685b', brightRed: '#b73b30', brightGreen: '#3c692c', brightYellow: '#895c18',
      brightBlue: '#356696', brightMagenta: '#934a8c', brightCyan: '#247876', brightWhite: '#f3f0e7',
    };
  }
  return {
    background,
    foreground,
    cursor: accent || '#afd277',
    selectionBackground: selection || '#3d4d30',
    black: '#181c16', red: '#ffaca0', green: '#afd277', yellow: '#e5bd71',
    blue: '#90b7df', magenta: '#d4a7d6', cyan: '#90c8bc', white: '#e6e6d5',
    brightBlack: '#b2b5a4', brightRed: '#ffc2b7', brightGreen: '#c8e29b', brightYellow: '#f1d49d',
    brightBlue: '#b0ccec', brightMagenta: '#e2c0e4', brightCyan: '#b4ded1', brightWhite: '#fffbed',
  };
}

/** Update canvas colors without replacing the terminal or its live PTY. */
export function observeTerminalTheme(element: HTMLElement, terminal: { options: { theme?: ITheme } }): () => void {
  const observer = new MutationObserver(() => { terminal.options.theme = terminalTheme(element); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-workbench-theme'] });
  return () => observer.disconnect();
}
