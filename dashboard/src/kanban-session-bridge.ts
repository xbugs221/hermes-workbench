/** 看板抽屉进入 Workbench 对话所需的纯 URL 映射。 */
import type { KanbanSessionLink } from './kanban-session-api';

export function workbenchPath(
  taskId: string,
  board: string,
  link?: KanbanSessionLink,
  selectedProfile = 'default',
): string {
  const url = new URL('/chat', 'https://dashboard.invalid');
  url.searchParams.set('profile', link?.profile || selectedProfile);
  url.searchParams.set('kanban_task', taskId);
  if (board) url.searchParams.set('kanban_board', board);
  if (link?.session_id) url.searchParams.set('session', link.session_id);
  return `${url.pathname}${url.search}`;
}

/** 已有固定会话优先继续；否则用抽屉中选定的 Agent 发起新对话。 */
export function drawerConversationPath(
  taskId: string,
  board: string,
  selectedProfile: string,
  links: KanbanSessionLink[],
): string {
  return workbenchPath(taskId, board, links[0], selectedProfile || 'default');
}
