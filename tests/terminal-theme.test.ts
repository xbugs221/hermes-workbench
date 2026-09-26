// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeTerminalTheme, terminalTheme } from '../dashboard/src/terminal-theme';

afterEach(() => { vi.restoreAllMocks(); delete document.documentElement.dataset.workbenchTheme; });

describe('terminal theme', () => {
  it('uses the same CSS background, text, cursor and selection as the page', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgb(243, 240, 231)', color: 'rgb(48, 53, 44)',
      getPropertyValue: (name: string) => ({'--mc-accent': '#496b2d', '--mc-active': '#d7dfc7'}[name] || ''),
    } as CSSStyleDeclaration);
    expect(terminalTheme(document.body)).toMatchObject({
      background: 'rgb(243, 240, 231)', foreground: 'rgb(48, 53, 44)',
      cursor: '#496b2d', selectionBackground: '#d7dfc7', yellow: '#80571b',
    });
  });

  it('uses hex palette colors when the browser serializes mixed backgrounds as CSS Color 4', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'color(srgb 0.947 0.935 0.899)', color: 'rgb(48, 53, 44)',
      getPropertyValue: (name: string) => ({'--mc-code': '#e5e3d8', '--mc-ink': '#30352c'}[name] || ''),
    } as CSSStyleDeclaration);
    expect(terminalTheme(document.body)).toMatchObject({
      background: '#e5e3d8', foreground: '#30352c', yellow: '#80571b',
    });
  });

  it('repaints the existing terminal when mode changes and stops after cleanup', async () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      backgroundColor: document.documentElement.dataset.workbenchTheme === 'dark' ? 'rgb(32, 35, 30)' : 'rgb(243, 240, 231)',
      color: 'rgb(230, 230, 213)', getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration));
    const terminal = { options: { theme: terminalTheme(document.body) } };
    const stop = observeTerminalTheme(document.body, terminal);
    document.documentElement.dataset.workbenchTheme = 'dark';
    await vi.waitFor(() => expect(terminal.options.theme.background).toBe('rgb(32, 35, 30)'));
    expect(terminal.options.theme.yellow).toBe('#e5bd71');
    const saved = terminal.options.theme;
    stop();
    document.documentElement.dataset.workbenchTheme = 'light';
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(terminal.options.theme).toBe(saved);
  });
});
