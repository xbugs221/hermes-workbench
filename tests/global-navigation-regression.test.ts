import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The chat/session entry must remain reachable before the chat pane mounts. */
describe('global conversation navigation', () => {
  it('keeps a permanent session entry in the host navigation', () => {
    const runtime = readFileSync(
      new URL('../dashboard/src/recovered-runtime.js', import.meta.url),
      'utf8',
    );
    expect(runtime).toContain('href: Cn("/chat", u.profile)');
    expect(runtime).toContain('className: `dashboard-global-nav');
    expect(runtime).toContain('k("/achievements", "成就", "achievements"');
  });
});
