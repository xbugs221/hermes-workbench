/** Sidebar Terminal and Files tabs for the Workbench Dashboard integration. */
import { uiText } from './ui-locale';

const FILES_PATH = '/files';
const WORKBENCH_PATH = '/chat';
const TERMINAL_QUERY = 'workbench=terminal';
const PLUGIN_HEADING_ID = 'hermes-sidebar-plugin-nav-heading';

function currentRoute(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function navigateWithinDashboard(route: string): void {
  window.history.pushState(null, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function terminalRouteActive(route = currentRoute()): boolean {
  try {
    const url = new URL(route, 'https://dashboard.invalid');
    return url.pathname === WORKBENCH_PATH && url.searchParams.get('workbench') === 'terminal';
  } catch {
    return false;
  }
}

export function workbenchRouteActive(route = currentRoute()): boolean {
  try {
    return new URL(route, 'https://dashboard.invalid').pathname === WORKBENCH_PATH;
  } catch {
    return false;
  }
}

function setActive(link: HTMLAnchorElement, active: boolean): void {
  link.setAttribute('aria-current', active ? 'page' : 'false');
  link.classList.toggle('text-midground', active);
  link.classList.toggle('text-text-secondary', !active);
  link.classList.toggle('hover:text-midground', !active);
  let marker = link.querySelector<HTMLElement>('.hti-sidebar-tool-active-marker');
  if (active && !marker) {
    marker = document.createElement('span');
    marker.className = 'hti-sidebar-tool-active-marker absolute left-0 top-0 bottom-0 w-px bg-midground';
    marker.setAttribute('aria-hidden', 'true');
    link.appendChild(marker);
  } else if (!active) {
    marker?.remove();
  }
}

function cloneSidebarLink(
  source: HTMLAnchorElement,
  id: string,
  href: string,
  label: string,
): HTMLAnchorElement {
  const link = source.cloneNode(true) as HTMLAnchorElement;
  link.id = id;
  link.href = href;
  link.removeAttribute('data-discover');
  link.removeAttribute('aria-current');
  link.querySelectorAll('.hti-sidebar-tool-active-marker').forEach(node => node.remove());
  const labels = Array.from(link.querySelectorAll<HTMLElement>('span'))
    .filter(span => !span.hasAttribute('aria-hidden'));
  if (labels[0]) labels[0].textContent = label;
  link.setAttribute('aria-label', label);
  link.setAttribute('title', label);
  return link;
}

function updateSidebarLabel(item: HTMLLIElement, label: string): void {
  const link = item.querySelector<HTMLAnchorElement>('a');
  if (!link) return;
  const labelNode = Array.from(link.querySelectorAll<HTMLElement>('span'))
    .find(span => !span.hasAttribute('aria-hidden') || span.hasAttribute('data-hti-sidebar-collapsed-label'));
  if (labelNode) labelNode.textContent = label;
  link.setAttribute('aria-label', label);
  link.setAttribute('title', label);
}

function ensureToolItem(
  list: HTMLUListElement,
  source: HTMLAnchorElement,
  id: string,
  href: string,
  label: string,
  onClick: () => void,
): HTMLLIElement {
  let item = Array.from(list.children).find(
    child => child instanceof HTMLLIElement && child.dataset.htiSidebarTool === id,
  ) as HTMLLIElement | undefined;
  if (!item) {
    item = document.createElement('li');
    item.dataset.htiSidebarTool = id;
    const link = cloneSidebarLink(source, id, href, label);
    link.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    item.appendChild(link);
    list.appendChild(item);
  }
  return item;
}

/** Install or restore plugin-owned Terminal and Files tabs in the Plugins group. */
export function relocateSidebarToolsNavigation(root: Document = document): boolean {
  const heading = root.getElementById(PLUGIN_HEADING_ID);
  const group = heading?.closest<HTMLElement>('[role="group"]');
  const list = group
    ? Array.from(group.children).find(child => child.tagName.toLowerCase() === 'ul') as HTMLUListElement | undefined
    : undefined;
  const nativeFiles = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('#app-sidebar nav a[href="/files"]'),
  ).find(link => !link.closest('[data-hti-sidebar-tool]'));
  const nativeChat = root.querySelector<HTMLAnchorElement>('#app-sidebar nav a[href="/chat"]');
  if (!list || !nativeFiles || !nativeChat) return false;

  const terminalItem = ensureToolItem(
    list,
    nativeChat,
    'hti-sidebar-terminal-tab',
    `${WORKBENCH_PATH}?${TERMINAL_QUERY}`,
    uiText('终端', 'Terminal', root),
    () => navigateWithinDashboard(`${WORKBENCH_PATH}?${TERMINAL_QUERY}`),
  );
  const filesItem = ensureToolItem(
    list,
    nativeFiles,
    'hti-sidebar-files-tab',
    FILES_PATH,
    uiText('文件', 'Files', root),
    () => navigateWithinDashboard(FILES_PATH),
  );

  // Keep a deterministic adjacent order after native plugin tabs without
  // mutating an already-correct tree (the observer watches these mutations).
  const children = Array.from(list.children);
  if (children.at(-2) !== terminalItem || children.at(-1) !== filesItem) {
    list.append(terminalItem, filesItem);
  }
  const terminalLink = terminalItem.querySelector<HTMLAnchorElement>('a')!;
  const filesLink = filesItem.querySelector<HTMLAnchorElement>('a')!;
  updateSidebarLabel(terminalItem, uiText('终端', 'Terminal', root));
  updateSidebarLabel(filesItem, uiText('文件', 'Files', root));
  setActive(terminalLink, terminalRouteActive());
  setActive(filesLink, window.location.pathname === FILES_PATH);

  const nativeFilesItem = nativeFiles.closest<HTMLElement>('li') || nativeFiles;
  nativeFilesItem.classList.add('hti-native-files-nav-hidden');
  nativeFilesItem.setAttribute('aria-hidden', 'true');
  filesItem.classList.remove('hti-native-files-nav-hidden');
  filesItem.removeAttribute('aria-hidden');
  root.querySelector('.hti-host-header-tools')?.remove();
  document.documentElement.dataset.workbenchRoute = String(workbenchRouteActive());
  return true;
}

/** Move the native refresh action beside Upload/Create on the Files page. */
export function relocateFilesRefresh(root: ParentNode = document): boolean {
  if (window.location.pathname !== FILES_PATH) return false;
  const refresh = root.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh files"], button[aria-label="刷新文件"]',
  );
  const create = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.trim() === 'Create' || button.textContent?.trim() === '创建');
  const actions = create?.parentElement;
  if (!refresh || !actions) return false;
  refresh.classList.add('hti-files-inline-refresh');
  refresh.setAttribute('title', uiText('刷新文件', 'Refresh files'));
  if (refresh.parentElement !== actions) actions.prepend(refresh);
  return true;
}

export function installSidebarToolsNavigation(): void {
  if ((window as any).__HERMES_WORKBENCH_SIDEBAR_TOOLS__) return;
  (window as any).__HERMES_WORKBENCH_SIDEBAR_TOOLS__ = true;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      relocateSidebarToolsNavigation();
      relocateFilesRefresh();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['lang'],
  });
  window.addEventListener('popstate', schedule);
  schedule();
}
