/** Commentary must remain visible during a turn, including running snapshots.
 * App Server snapshots give agent messages the turn's running status, even
 * after an individual commentary item completed without a trailing newline.
 * Keep line buffering for the answer body; never buffer progress commentary.
 */
export function visibleChatText(message: { content: string; role?: string; status?: string; phase?: string }): string {
  if (message.phase === 'commentary' || message.status !== 'running' || !['assistant', 'reasoning'].includes(message.role || '')) {
    return message.content;
  }
  return message.content.slice(0, message.content.lastIndexOf('\n') + 1);
}
