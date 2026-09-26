/** Visible Workbench height above the mobile software keyboard. */
export function mobileWorkbenchViewportHeight(
  rootTop: number,
  viewport: { height: number; offsetTop?: number },
): number {
  const offsetTop = Number.isFinite(viewport.offsetTop) ? Number(viewport.offsetTop) : 0;
  const bottom = offsetTop + Math.max(0, viewport.height);
  return Math.max(0, Math.floor(bottom - Math.max(rootTop, offsetTop)));
}
