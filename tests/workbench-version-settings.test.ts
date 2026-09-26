// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { renderWorkbenchVersions } from '../dashboard/src/workbench-version-settings';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
function panel() {
  document.body.innerHTML = '<section><div class="workbench-version-list"></div></section>';
  return document.querySelector('section')!;
}
const data = { active: '0.6.43-codex.14', versions: [
  { version: '0.7.0', ready: false, source: 'github', notes: '<img src=x onerror=alert(1)>\nRelease notes' },
  { version: '0.6.43-codex.14', ready: true },
] };
it('shows release notes safely and performs no update until clicked', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
  vi.stubGlobal('fetch', fetcher);
  const target = panel();
  await renderWorkbenchVersions(target);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(target.querySelector('img')).toBeNull();
  expect(target.querySelector('details')!.textContent).toContain('Release notes');
  expect(target.querySelector('button')!.textContent).toBe('更新到此版本');
  expect(target.querySelectorAll('button')).toHaveLength(1);
});
it('reports update errors and restores controls for retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data)))
    .mockRejectedValueOnce(new Error('offline')));
  const target = panel();
  const reload = vi.fn();
  await renderWorkbenchVersions(target, reload);
  target.querySelector('button')!.click();
  await vi.waitFor(() => expect(target.querySelector('[role=status]')!.textContent).toContain('offline'));
  expect(target.querySelector('button')!.disabled).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it('switches exactly the chosen version and refreshes after success', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetcher);
  const target = panel();
  const reload = vi.fn();
  await renderWorkbenchVersions(target, reload);
  target.querySelector('button')!.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ version: '0.7.0' });
});

it('waits through backend restart and reloads only after full activation', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...data, update_mode: 'release' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: true, job_id: 'job' })))
      .mockRejectedValueOnce(new Error('backend restarting'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', phase: 'succeeded' })));
    vi.stubGlobal('fetch', fetcher);
    const target = panel();const reload = vi.fn();
    await renderWorkbenchVersions(target, reload);
    target.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(1300);
    expect(reload).not.toHaveBeenCalled();
    expect(target.querySelector('button')!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1300);
    expect(reload).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('shows rollback and re-enables controls without claiming success', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(data)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: true, job_id: 'job' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job', phase: 'failed', error: '已回滚原版本' }))));
    const target = panel();const reload = vi.fn();
    await renderWorkbenchVersions(target, reload);target.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(1300);
    expect(target.querySelector('[role=status]')!.textContent).toContain('已回滚');
    expect(target.querySelector('button')!.disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
