import { expect, it } from 'vitest';
import { visibleProcessMessages, processBlocks } from '../dashboard/src/chat-process-messages';
it('keeps consecutive tools adjacent across invisible reasoning while visible content breaks the run', () => {
  const messages = [
    { role: 'tool', content: 'one' }, { role: 'reasoning', content: '' },
    { role: 'tool', content: 'two' }, { role: 'assistant', phase: 'commentary', content: '  ' },
    { role: 'tool', content: 'three' }, { role: 'assistant', phase: 'commentary', content: '下一步' },
    { role: 'tool', content: 'four' }, { role: 'reasoning', content: '检查结果' },
  ];
  expect(visibleProcessMessages(messages).map(item => item.content)).toEqual(['one', 'two', 'three', '下一步', 'four', '检查结果']);
  expect(messages).toHaveLength(8);
});

it('ignores compaction and hidden system markers but preserves empty user and tool blocks', () => {
  const messages = [
    { role: 'tool', content: '' }, { role: 'assistant', content: '' },
    { role: 'system', content: 'internal marker' }, { role: 'user', content: '' },
    { role: 'assistant', content: '可见正文' },
  ];
  expect(visibleProcessMessages(messages)).toEqual([messages[0], messages[3], messages[4]]);
});

it('groups a turn once across async questions without hiding answers or merging turns', () => {
  const messages = [
    { id: '1', turnId: 'a', role: 'tool', content: 'before' },
    { id: '2', turnId: 'a', role: 'assistant', content: 'question' },
    { id: '3', turnId: 'a', role: 'tool', content: 'after' },
    { id: '4', turnId: 'a', role: 'assistant', content: 'final' },
    { id: '5', turnId: 'b', role: 'tool', content: 'next' },
  ];
  const blocks = processBlocks(messages);
  expect(blocks.map(b => b.kind)).toEqual(['process','message','message','process']);
  const first = blocks[0];
  if (first.kind !== 'process') throw new Error('missing process');
  expect(first.messages.map(m => m.id)).toEqual(['1','3']);
  expect(first.hasFollowingBody).toBe(true);
  expect(messages).toHaveLength(5);
});


it('keeps tools and replies on their own side of each steering instruction', () => {
  const messages = [
    { id: 'a', turnId: 'turn', role: 'tool', content: 'before' },
    { id: 'u1', turnId: 'turn', role: 'user', content: 'first instruction' },
    { id: 'b', turnId: 'turn', role: 'tool', content: 'after first' },
    { id: 'c', turnId: 'turn', role: 'assistant', phase: 'commentary', content: 'reply first' },
    { id: 'u2', role: 'user', content: 'optimistic instruction without turn ID' },
    { id: 'd', turnId: 'turn', role: 'tool', content: 'after second' },
    { id: 'final', turnId: 'turn', role: 'assistant', content: 'done' },
  ];
  const blocks = processBlocks(messages);
  expect(blocks.flatMap(b => b.kind === 'message' ? [b.message.id] : b.messages.map(m => m.id)))
    .toEqual(messages.map(m => m.id));
  const groups = blocks.filter(b => b.kind === 'process');
  expect(groups).toHaveLength(3);
  expect(new Set(groups.map(b => b.key)).size).toBe(3);
  expect(groups.every(b => b.hasFollowingBody)).toBe(true);
});
