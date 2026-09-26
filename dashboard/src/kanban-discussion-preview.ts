/** Read-only source preview: entering a discussion never submits a model turn. */
export function createKanbanDiscussionPreview(sdk: Record<string, any>) {
  const React = sdk.React;
  const { useEffect, useState } = sdk.hooks;
  const h = React.createElement;
  return function KanbanDiscussionPreview({ context, sessionId, empty, busy, onStart }: any) {
    const [state, setState] = useState({ loading: true, snapshot: null, error: '' } as any);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
      let active = true;
      setState({ loading: true, snapshot: null, error: '' });
      context.load(sdk.fetchJSON, sessionId).then((snapshot: any) => {
        if (!active || !context.matches(sessionId)) return;
        setState({ loading: false, snapshot, error: snapshot ? '' : '卡片关联已失效' });
        const url = new URL(window.location.href);
        if (snapshot && url.searchParams.get('kanban_task') === snapshot.taskId
            && (url.searchParams.get('session') || '') === sessionId) {
          url.searchParams.set('kanban_board', snapshot.board);
          window.history.replaceState(null, '', url);
        }
      }).catch((error: unknown) => {
        if (active) setState({ loading: false, snapshot: null, error: String(error) });
      });
      return () => { active = false; };
    }, [context, sessionId, retry]);
    if (state.loading) return h('section', { className: 'codex-card-context', role: 'status' }, '正在读取卡片上下文…');
    if (state.error) return h('section', { className: 'codex-card-context', role: 'alert' },
      h('strong', null, '卡片读取失败'), h('p', null, state.error),
      h('button', { type: 'button', onClick: () => setRetry((n: number) => n + 1) }, '重试读取卡片'));
    const snapshot = state.snapshot;
    if (!snapshot) return null;
    const { data, board, taskId } = snapshot;
    const cardURL = `/kanban?board=${encodeURIComponent(board)}`;
    return h('section', { className: 'codex-card-context', 'aria-label': '卡片讨论上下文' },
      h('div', { className: 'codex-card-context-meta' }, '卡片头脑风暴 · ', h('a', { href: cardURL }, board), ` · ${taskId}`),
      h('h2', null, data.task.title || taskId),
      h('details', { open: empty },
        h('summary', null, '查看卡片原文'),
        h('div', { className: 'codex-card-context-body' }, data.task.body || data.task.description || '这张卡片尚未填写正文，先围绕标题讨论。'),
        h('p', { className: 'codex-card-context-meta' }, `备注 ${data.comments?.length || 0} · 运行记录 ${data.runs?.length || 0} · 附件 ${data.attachments?.length || 0}`)),
      h('p', { className: 'codex-card-context-hint' }, '已读取卡片；发送时自动附带最新内容。回答简短、图表优先。'),
      empty ? h('div', { className: 'codex-card-context-start' },
        h('button', { type: 'button', className: 'codex-send', disabled: busy, onClick: onStart }, '开始头脑风暴'),
        h('span', null, '也可以直接在下方输入你的想法。')) : null);
  };
}
