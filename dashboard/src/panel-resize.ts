/** Pure width bounds shared by desktop sidebar drag and keyboard resizing. */
export function clampPanelWidth(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
