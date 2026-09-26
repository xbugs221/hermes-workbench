/** 将持久化记录视图定位至末尾，优先显示最近一轮内容。 */
export function scrollTranscriptToEnd(
  pane: Pick<HTMLElement, 'scrollHeight' | 'scrollTop'> | null,
): void {
  if (pane) pane.scrollTop = pane.scrollHeight;
}
