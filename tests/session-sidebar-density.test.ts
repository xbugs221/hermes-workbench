// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

function numericCss(value: string): number {
  return Number.parseFloat(value);
}

describe('Workbench session sidebar density', () => {
  afterEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('keeps controls on one row and session actions horizontal on mobile', () => {
    (window as any).happyDOM.setInnerWidth(390);
    const style = document.createElement('style');
    style.textContent = readFileSync(`${process.cwd()}/dashboard/src/style.css`, 'utf8');
    document.head.appendChild(style);
    document.body.innerHTML = `
      <main class="hti-root hti-workbench">
        <aside class="hti-session-sidebar is-mobile-open">
          <div class="hti-session-sidebar-body">
            <div class="hti-session-controls">
              <button class="hti-session-source-switch"><span>定时任务</span></button>
              <input aria-label="搜索会话">
            </div>
            <nav class="hti-session-list">
              <section class="hti-session-group">
                <button class="hti-session-group-toggle"><span>›</span><span>▰</span><span>今天</span><span>2</span></button>
                <div class="hti-session-row active">
                  <button class="hti-session-open"><span class="hti-session-title">会话标题</span></button>
                  <div class="hti-session-row-actions"><button>☆</button><button>✎</button><button>⌫</button></div>
                </div>
              </section>
            </nav>
          </div>
        </aside>
      </main>`;

    const controls = getComputedStyle(document.querySelector<HTMLElement>('.hti-session-controls')!);
    const actions = getComputedStyle(document.querySelector<HTMLElement>('.hti-session-row-actions')!);
    const actionButton = getComputedStyle(document.querySelector<HTMLElement>('.hti-session-row-actions button')!);
    const group = getComputedStyle(document.querySelector<HTMLElement>('.hti-session-group-toggle')!);
    const title = getComputedStyle(document.querySelector<HTMLElement>('.hti-session-title')!);

    expect(controls.display).toBe('grid');
    expect(controls.gridTemplateColumns).not.toBe('none');
    expect(actions.flexDirection).toBe('row');
    expect(numericCss(actionButton.height)).toBeGreaterThanOrEqual(40);
    expect(numericCss(group.fontSize) / numericCss(title.fontSize)).toBeGreaterThanOrEqual(0.9);
  });
});
