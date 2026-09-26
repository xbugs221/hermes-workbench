/** 顶部工具的纯交互状态，供 React 组件和 Vitest 共用。 */
export type TerminalDialogAction = 'trigger' | 'close' | 'escape' | 'backdrop';

export function nextTerminalDialogState(
  open: boolean,
  action: TerminalDialogAction,
): boolean {
  return action === 'trigger' ? !open : false;
}
