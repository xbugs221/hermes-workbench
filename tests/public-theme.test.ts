// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { setUnifiedWorkbenchTheme } from '../dashboard/src/sidebar-simplify';

it.each(['light', 'dark'] as const)('persists public %s theme identifiers to both host surfaces', async mode => {
  const calls: Array<{url: string; body: any}> = [];
  const request = async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: true, json: async () => ({ display: { keep: true } }) } as Response;
  };
  await setUnifiedWorkbenchTheme(mode, request as typeof fetch);
  expect(calls[1].body.config.display).toEqual({ keep: true, skin: `workbench-${mode}`, tui_theme: mode });
  expect(calls[2]).toEqual({ url: '/api/dashboard/theme', body: { name: `workbench-${mode}` } });
  expect(window.localStorage.getItem('hermes-dashboard-theme')).toBe(`workbench-${mode}`);
});
