/** Mobile IME Enter commits composition first; it must not also submit it. */
export function shouldBlockComposingEnter(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'type'>,
  composing: boolean,
  mobile: boolean,
): boolean {
  return mobile && event.type === 'keydown' && event.key === 'Enter' && (composing || event.isComposing);
}

/** A mobile chat submit is CR; LF remains the TUI's multiline input. */
export function shouldResetMobileTerminalInput(mode: string, mobile: boolean, data: string): boolean {
  return mode === 'chat' && mobile && data.includes('\r');
}

/** Only repair an unchanged browser IME buffer after xterm has settled. */
export function shouldRepairStaleMobileInput(submitted: string, current: string): boolean {
  return Boolean(submitted) && current === submitted;
}

/** Clear the settled browser-owned input buffer without touching active composition state. */
export function resetTerminalTextarea(
  textarea: Pick<HTMLTextAreaElement, 'setSelectionRange' | 'value'> | null | undefined,
): void {
  if (!textarea) return;
  textarea.value = '';
  textarea.setSelectionRange(0, 0);
}