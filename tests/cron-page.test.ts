import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enhanceCronPage } from '../dashboard/src/cron-page-bridge';
import { attachCronHistories, cronRunHref } from '../dashboard/src/cron-run-history';

afterEach(() => { delete (globalThis as any).document; });

function cronFixture(lang = 'zh-CN'): Document {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.documentElement.lang = lang;
  document.body.innerHTML = `
    <div class="flex flex-col gap-6">
      <div class="tabs"><button>任务</button><button>蓝图</button></div>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-3 sm:flex-row"><div>已调度任务（1）</div><div><label>PROFILE</label><button id="cron-profile-filter">全部配置</button></div></div>
        <article><div class="card-body">
          <div class="main">
            <div class="title-row"><span>每日技术简报</span><span>已排期</span><span>default</span><span>model</span><span>no_agent</span></div>
            <p>生成一份每日技术简报</p>
            <div class="metadata"><span>每天 08:00</span><span>repeat: forever</span><span>上次: 2026/9/2 08:00</span><span>下次: 2026/9/3 08:00</span></div>
          </div>
          <div class="actions">
            <button aria-label="暂停"><svg></svg></button><button aria-label="立即运行"><svg></svg></button>
            <button aria-label="编辑任务"><svg></svg></button><button aria-label="删除"><svg></svg></button>
          </div>
        </div></article>
      </div>
    </div>`;
  (globalThis as any).document = document;
  return document;
}

describe('Cron card redesign', () => {
  it('shows only key information and clear actions', () => {
    const document = cronFixture();
    enhanceCronPage(document);
    expect(document.querySelector('[data-hti-cron-card="true"]')).not.toBeNull();
    expect(document.querySelector('[data-hti-cron-status="active"]')?.getAttribute('aria-label')).toBe('已排期');
    expect(Array.from(document.querySelectorAll('[data-hti-cron-auxiliary="true"]')).map((node) => node.textContent?.trim()))
      .toEqual(['default', 'model', 'no_agent', '生成一份每日技术简报', 'repeat: forever', '上次: 2026/9/2 08:00']);
    expect(Array.from(document.querySelectorAll('[data-hti-cron-action-text="true"]')).map((node) => node.textContent))
      .toEqual(['暂停', '立即运行', '编辑']);
    expect(document.querySelector('[data-hti-cron-more="true"] > summary')?.textContent).toBe('⋯');
  });

  it('maps state text to a color hook while retaining an accessible label', () => {
    const document = cronFixture('en');
    const badge = document.querySelectorAll('.title-row span')[1] as HTMLElement;
    badge.textContent = 'Paused';
    enhanceCronPage(document);
    expect(badge.dataset.htiCronStatus).toBe('paused');
    expect(badge.getAttribute('aria-label')).toBe('Paused');
    badge.textContent = 'Error';
    enhanceCronPage(document);
    expect(badge.dataset.htiCronStatus).toBe('error');

    badge.textContent = 'Scheduled';
    const error = document.createElement('p');
    error.className = 'text-destructive';
    error.textContent = 'Last execution failed';
    document.querySelector('.main')?.append(error);
    enhanceCronPage(document);
    expect(badge.dataset.htiCronStatus).toBe('error');
  });

  it('routes overflow deletion through the native confirmation action', () => {
    const document = cronFixture();
    const nativeDelete = document.querySelectorAll<HTMLButtonElement>('.actions > button')[3];
    const click = vi.spyOn(nativeDelete, 'click');
    enhanceCronPage(document);
    document.querySelector<HTMLButtonElement>('[data-hti-cron-more="true"] > button')?.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it('is idempotent across observer rescans', () => {
    const document = cronFixture();
    enhanceCronPage(document);
    enhanceCronPage(document);
    expect(document.querySelectorAll('[data-hti-cron-more="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-hti-cron-action-text="true"]')).toHaveLength(3);
  });

  it('lazily groups run sessions under the owning scheduled-task card', async () => {
    const document = cronFixture();
    enhanceCronPage(document);
    const card = document.querySelector<HTMLElement>('[data-hti-cron-card="true"]')!;
    const loadRuns = vi.fn(async () => [{
      id: 'cron_abbe625ea8f4_20260909_080017',
      title: '每日技术简报 · Sep 09 08:00',
      started_at: 1_788_912_000,
    }]);
    attachCronHistories([card], [{ id: 'abbe625ea8f4', name: '每日技术简报', profile: 'default' }], loadRuns);

    const details = card.querySelector<HTMLDetailsElement>('[data-hti-cron-runs="true"]')!;
    expect(details).not.toBeNull();
    expect(loadRuns).not.toHaveBeenCalled();
    details.open = true;
    details.dispatchEvent(new (document.defaultView as any).Event('toggle'));
    await Promise.resolve();
    await Promise.resolve();

    expect(loadRuns).toHaveBeenCalledWith('abbe625ea8f4', 'default');
    const link = details.querySelector<HTMLAnchorElement>('[data-hti-cron-run-link="true"]')!;
    expect(link.getAttribute('href')).toBe('/chat?profile=default&session=cron_abbe625ea8f4_20260909_080017');
    expect(link.textContent).toContain('每日技术简报');
  });

  it('builds encoded read-only Workbench deep links', () => {
    expect(cronRunHref('writer profile', 'cron/a b'))
      .toBe('/chat?profile=writer+profile&session=cron%2Fa+b');
  });
});
