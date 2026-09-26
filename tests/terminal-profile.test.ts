import { describe, expect, it } from 'vitest';
import { terminalProfileParam } from '../dashboard/src/terminal-profile';

describe('Workbench terminal profile routing', () => {
  it('reuses the warm dashboard gateway for the default chat only', () => {
    expect(terminalProfileParam('chat', 'default')).toBe('current');
    expect(terminalProfileParam('chat', ' DEFAULT ')).toBe('current');
    expect(terminalProfileParam('chat', 'learning-mentor')).toBe('learning-mentor');
    expect(terminalProfileParam('shell', 'default')).toBe('default');
  });
});