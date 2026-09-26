// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { bilingualText, localizeWorkbenchUI } from '../dashboard/src/locale-overlay';

describe('Workbench locale overlay', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.lang = 'en';
  });

  it('selects exactly one language from bilingual labels', () => {
    expect(bilingualText('文件 / Files', true)).toBe('文件');
    expect(bilingualText('文件 / Files', false)).toBe('Files');
    expect(bilingualText('/opt/data/workspace', true)).toBe('/opt/data/workspace');
  });

  it('localizes text and accessibility attributes without mixing languages', () => {
    document.body.innerHTML = '<button aria-label="关闭终端 / Close terminal" title="关闭 / Close">终端 / Terminal</button>';
    document.documentElement.lang = 'zh-CN';
    localizeWorkbenchUI();
    const button = document.querySelector('button')!;
    expect(button.textContent).toBe('终端');
    expect(button.getAttribute('aria-label')).toBe('关闭终端');
    expect(button.title).toBe('关闭');
  });
});
