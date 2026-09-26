/** Stable host for plugin-owned header tools across route-specific React layouts. */
export function ensureHeaderToolsMount(
  topbar: HTMLElement,
  root: Pick<Document, 'createElement'> = document,
): HTMLElement {
  let mount = Array.from(topbar.children)
    .find(child => child.classList.contains('hti-host-header-tools')) as HTMLElement | undefined;
  if (!mount) {
    mount = root.createElement('div');
    mount.className = 'hti-host-header-tools';
  }

  // Files has an empty flex search/action slot after the title. React may add
  // that slot after our mount, so margin-left:auto alone places the tools near
  // the centre. Inline order is a cache- and utility-class-resistant contract.
  mount.style.order = '2147483647';
  mount.style.marginLeft = 'auto';
  mount.style.flex = '0 0 auto';
  if (mount.parentElement !== topbar || mount !== topbar.lastElementChild) {
    topbar.appendChild(mount);
  }
  return mount;
}
