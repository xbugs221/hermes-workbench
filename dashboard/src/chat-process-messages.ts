export interface ProcessMessage {
  role?: string;
  phase?: string;
  content?: string;
}
/** Hidden system and empty assistant markers do not separate visible tool runs. */
export function visibleProcessMessages<T extends ProcessMessage>(messages: T[]): T[] {
  return messages.filter(message =>
    message.role !== 'system' &&
    !((message.role === 'reasoning' || message.role === 'assistant' || message.phase === 'commentary') &&
      message.role !== 'tool' && !message.content?.trim()));
}

/** Group each turn within a user-message segment; steering is a chronological boundary. */
export function processBlocks<T extends ProcessMessage & { id: string; turnId?: string }>(input: T[]) {
  const messages = visibleProcessMessages(input);
  const isProcess = (m: T) => m.role === 'tool' || m.role === 'reasoning' || m.phase === 'commentary';
  const groups = new Map<string, { kind: 'process'; key: string; messages: T[]; hasFollowingBody: boolean }>();
  const blocks: ({ kind: 'message'; message: T } | { kind: 'process'; key: string; messages: T[]; hasFollowingBody: boolean })[] = [];
  for (const message of messages) {
    if (!isProcess(message)) {
      if (message.role === 'user') {
        // Later events must never be pulled ahead of a steering instruction.
        // Optimistic user messages may not have a turnId yet.
        for (const group of groups.values()) group.hasFollowingBody = true;
        groups.clear();
      }
      blocks.push({ kind: 'message', message });
      if (message.turnId && message.role === 'assistant') {
        const group = groups.get(message.turnId);
        if (group) group.hasFollowingBody = true;
      }
      continue;
    }
    const key = message.turnId || message.id;
    let group = groups.get(key);
    if (!group) {
      group = { kind: 'process', key: `${key}:${message.id}`, messages: [], hasFollowingBody: false };
      groups.set(key, group);
      blocks.push(group);
    }
    group.messages.push(message);
  }
  return blocks;
}
