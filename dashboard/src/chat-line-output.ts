/** Keep the raw text intact; only expose complete newline-delimited lines. */
export function visibleChatText(message: { content: string; role?: string; status?: string }): string {
  if (message.status !== 'running' || !['assistant', 'reasoning'].includes(message.role || '')) {
    return message.content;
  }
  return message.content.slice(0, message.content.lastIndexOf('\n') + 1);
}
