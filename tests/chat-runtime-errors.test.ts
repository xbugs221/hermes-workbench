import { describe, expect, it } from 'vitest';
import { insertRequest, runtimeErrorText, sameMessage, withTurnError } from '../dashboard/src/chat-runtime-errors';

describe('Codex runtime errors and request reconciliation', () => {
  it('preserves the upstream overload diagnostic', () => {
    expect(runtimeErrorText({ message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' }))
      .toBe('Selected model is at capacity.\nserverOverloaded');
  });

  it('matches a failed request to the native user item by client id', () => {
    expect(sameMessage({ id: 'client-1' }, { clientRequestId: 'client-1' })).toBe(true);
    expect(insertRequest([{ id: 'client-1' }], { id: 'client-1', role: 'user' })).toHaveLength(1);
  });

  it('adds the runtime error once to the failed turn', () => {
    const turn = { id: 'turn-1', status: 'failed', error: { message: 'capacity' }, items: [] };
    const first = withTurnError([], turn);
    expect(first).toHaveLength(1);
    expect(first[0].runtimeError).toBe('capacity');
    expect(withTurnError(first, turn)).toHaveLength(1);
  });
});

it('keeps empty compact failures before later successful replies across replay', () => {
  const later = { id: 'reply', turnId: 'later', role: 'assistant', turnStartedAt: 1789874204000 };
  const turn = { id: 'compact', status: 'failed', startedAt: 1789869249, error: { message: 'compact failed' } };
  const first = withTurnError([later], turn);
  expect(first.map(m => m.id)).toEqual(['runtime-error:compact', 'reply']);
  expect(withTurnError(first, turn).map(m => m.id)).toEqual(['runtime-error:compact', 'reply']);
});
