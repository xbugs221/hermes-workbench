/** Pure responsive geometry for the portal-mounted global terminal workspace. */
type RectLike = { bottom: number };
type ViewportLike = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};

export function terminalWorkspaceGeometry(
  header: RectLike,
  viewport: ViewportLike,
  mobile: boolean,
  desktopLeft = 0,
): Record<string, string> {
  const top = Math.max(header.bottom, viewport.offsetTop);
  const left = mobile ? viewport.offsetLeft : Math.max(viewport.offsetLeft, desktopLeft);
  const width = Math.max(0, viewport.width - (left - viewport.offsetLeft));
  const height = Math.max(160, viewport.height - (top - viewport.offsetTop));
  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(width)}px`,
    height: `${Math.round(height)}px`,
  };
}

/**
 * Critical layout is inline so host utility classes or a delayed plugin CSS
 * fetch can never collapse the terminal back into the header-sized dialog.
 */
export function terminalWorkspaceCriticalStyle(
  geometry: Record<string, string>,
): Record<string, string> {
  return {
    ...geometry,
    position: 'fixed',
    zIndex: '1001',
    display: 'grid',
    pointerEvents: 'auto',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    maxWidth: 'none',
    minWidth: '0',
    minHeight: '0',
    gap: '0',
    overflow: 'hidden',
    borderRadius: '0',
    padding: '0',
    transform: 'none',
    translate: 'none',
  };
}

export function terminalWorkspaceReady(
  open: boolean,
  geometry: Record<string, string>,
): boolean {
  return open && Boolean(geometry.width && geometry.height && geometry.left && geometry.top);
}
