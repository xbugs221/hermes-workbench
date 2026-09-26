import { describe, expect, it } from 'vitest';

import { mobileWorkbenchViewportHeight } from '../dashboard/src/mobile-viewport';

describe('mobile Workbench visual viewport height', () => {
  it('ends above a software keyboard that shrinks the visual viewport', () => {
    expect(mobileWorkbenchViewportHeight(120, { height: 520, offsetTop: 0 })).toBe(400);
  });

  it('accounts for a visual viewport panned below the layout viewport top', () => {
    expect(mobileWorkbenchViewportHeight(80, { height: 500, offsetTop: 140 })).toBe(500);
  });

  it('never returns a negative CSS height', () => {
    expect(mobileWorkbenchViewportHeight(700, { height: 500, offsetTop: 0 })).toBe(0);
  });
});
