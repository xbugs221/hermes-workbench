/**
 * The dashboard's unscoped/current chat can reuse its warm in-process gateway.
 * Sending `profile=default` is not equivalent: the host treats every explicit
 * named profile as isolated and starts a cold Python gateway for that PTY.
 */
export function terminalProfileParam(mode: 'chat' | 'shell', profile: string): string {
  const normalized = profile.trim();
  if (mode === 'chat' && normalized.toLowerCase() === 'default') return 'current';
  return normalized || 'current';
}