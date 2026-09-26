/** Preserve runtime diagnostics and reconcile transport requests with native messages. */
export function runtimeErrorText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') {
    try { return runtimeErrorText(JSON.parse(value)); } catch { return value; }
  }
  const message = typeof value.message === 'string' ? value.message : '';
  const code = value.codexErrorInfo ?? value.code;
  const details = value.additionalDetails;
  return [message, code == null ? '' : typeof code === 'object' ? JSON.stringify(code) : String(code),
    typeof details === 'string' ? details : ''].filter(Boolean).join('\n');
}

export function sameMessage(a: any, b: any): boolean {
  const ids = (m: any) => [m.id, m.itemId, m.clientId, m.clientRequestId].filter(Boolean);
  return ids(a).some((id: string) => ids(b).includes(id));
}

export function insertRequest(messages: any[], request: any): any[] {
  if (messages.some(m => sameMessage(m, request))) return messages;
  const index = messages.findIndex(m => m.turnStartedAt && request.turnStartedAt &&
    Number(m.turnStartedAt) > Number(request.turnStartedAt));
  return index < 0 ? [...messages, request] : [...messages.slice(0, index), request, ...messages.slice(index)];
}

export function withTurnError(messages: any[], turn: any): any[] {
  if (turn.status !== 'failed') return messages;
  if (!turn.id) return messages;
  const id = `runtime-error:${turn.id}`;
  const content = runtimeErrorText(turn.error) || '回复失败：运行时未提供错误详情';
  const row = { id, itemId: id, turnId: turn.id, role: 'assistant', phase: 'final',
    status: 'completed', runtimeError: content, content, turnStatus: 'failed',
    turnStartedAt: turn.startedAt == null ? undefined : Math.abs(turn.startedAt) < 1e12 ? turn.startedAt * 1000 : turn.startedAt, paragraphs: [content] };
  const result = messages.filter(m => m.id !== id);
  let index = -1;
  result.forEach((m, i) => { if (m.turnId === turn.id) index = i; });
  if (index < 0) return insertRequest(result, row);
  result.splice(index + 1, 0, row);
  return result;
}
