import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { loadRecentTranscript } from '../dashboard/src/session-api';
import { createTranscriptComponents } from '../dashboard/src/transcript-components';

describe('progressive transcript performance contracts', () => {
  it('loads the latest 160 rows with one bounded request', async () => {
    const fetchJSON = vi.fn(async () => ({
      session_id: 'tip-session',
      messages: [{ id: 1, role: 'user', content: 'latest message' }],
    }));

    const transcript = await loadRecentTranscript(fetchJSON as any, 'default', 'root-session');

    expect(fetchJSON).toHaveBeenCalledTimes(1);
    expect(fetchJSON).toHaveBeenCalledWith(
      '/api/sessions/root-session/messages?profile=default&limit=160&order=latest',
    );
    expect(transcript.sessionId).toBe('tip-session');
    expect(transcript.rows).toHaveLength(1);
    expect(transcript.turns.at(-1)?.user).toBe('latest message');
  });

  it('renders only the latest 12 turns on the first frame', () => {
    let state = 12;
    const React = {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props: props || {},
        children,
      }),
    };
    const hooks = {
      useState: () => [state, (next: number | ((current: number) => number)) => {
        state = typeof next === 'function' ? next(state) : next;
      }],
    };
    const { TranscriptTimeline } = createTranscriptComponents({ React, hooks });
    const turns = Array.from({ length: 40 }, (_, index) => ({
      key: `turn-${index}`,
      user: `message-${index}`,
      events: [],
      raw: [],
    })) as any;

    const tree = TranscriptTimeline({ turns, rawOpen: false });

    expect(tree.children).toHaveLength(13);
    expect(tree.children[0].props['data-testid']).toBe('load-earlier-turns');
  });

  it('loads at most 20 additional earlier turns per interaction', () => {
    let state = 12;
    const React = {
      createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]) => ({
        type,
        props: props || {},
        children,
      }),
    };
    const hooks = {
      useState: () => [state, (next: number | ((current: number) => number)) => {
        state = typeof next === 'function' ? next(state) : next;
      }],
    };
    const { TranscriptTimeline } = createTranscriptComponents({ React, hooks });
    const turns = Array.from({ length: 100 }, (_, index) => ({
      key: `turn-${index}`,
      user: `message-${index}`,
      events: [],
      raw: [],
    })) as any;

    const first = TranscriptTimeline({ turns, rawOpen: false });
    first.children[0].props.onClick();
    const second = TranscriptTimeline({ turns, rawOpen: false });

    expect(state).toBe(32);
    expect(second.children).toHaveLength(33);
  });

  it('uses an opaque semantic backdrop behind open mobile drawers', () => {
    const css = readFileSync(new URL('../dashboard/src/style.css', import.meta.url), 'utf8');
    expect(css).toContain(
      'background: var(--color-background, var(--background-base, #071414)); cursor: pointer;',
    );
  });
});
