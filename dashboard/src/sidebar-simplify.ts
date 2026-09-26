/** Progressive disclosure for low-frequency Dashboard navigation and a unified Workbench theme toggle. */
import { uiText } from './ui-locale';

export type WorkbenchThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'hermes-dashboard-theme';
const MORE_ITEM_ATTR = 'data-hti-sidebar-more';
const THEME_BUTTON_ATTR = 'data-hti-theme-toggle';
const SYSTEM_SECTION_HIDDEN = 'hti-system-section-collapsed';
const IDENTITY_SECTION_HIDDEN = 'hti-sidebar-identity-hidden';
const PROFILE_SCOPE_BANNER_HIDDEN = 'hti-profile-scope-banner-hidden';

export const SECONDARY_NAV_PATHS = [
  '/models',
  '/logs',
  '/plugins',
  '/mcp',
  '/channels',
  '/webhooks',
  '/pairing',
  '/env',
  '/system',
  '/docs',
] as const;

function currentMode(storage: Pick<Storage, 'getItem'> = window.localStorage): WorkbenchThemeMode {
  return /(?:^|-)dark$/.test(storage.getItem(THEME_STORAGE_KEY) || '') ? 'dark' : 'light';
}

function profileConfigUrl(): string {
  const profile = new URLSearchParams(window.location.search).get('profile');
  return profile ? `/api/config?profile=${encodeURIComponent(profile)}` : '/api/config';
}

async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

/** Persist one mode across Dashboard and the selected profile's live TUI skin. */
export async function setUnifiedWorkbenchTheme(
  mode: WorkbenchThemeMode,
  request: typeof fetch = window.fetch.bind(window),
): Promise<void> {
  const theme = `workbench-${mode}`;
  const configUrl = profileConfigUrl();
  const config = await checkedJson(await request(configUrl));
  const display = config.display && typeof config.display === 'object'
    ? { ...(config.display as Record<string, unknown>) }
    : {};
  display.skin = theme;
  display.tui_theme = mode;

  await checkedJson(await request(configUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { ...config, display } }),
  }));
  await checkedJson(await request('/api/dashboard/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: theme }),
  }));
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function nativeLink(root: ParentNode, path: string): HTMLAnchorElement | null {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>(`#app-sidebar nav a[href="${path}"]`))
    .find(link => !link.closest(`[${MORE_ITEM_ATTR}]`)) ?? null;
}

function routeActive(path: string): boolean {
  const current = window.location.pathname.replace(/\/$/, '') || '/';
  return current === path;
}

function navigate(route: string): void {
  window.history.pushState(null, '', `${route}${window.location.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function labelNode(link: HTMLAnchorElement): HTMLElement | null {
  return Array.from(link.querySelectorAll<HTMLElement>('span'))
    .find(span => !span.hasAttribute('aria-hidden')) ?? null;
}

function syncSecondaryLink(target: HTMLAnchorElement, source: HTMLAnchorElement, path: string): void {
  const sourceLabel = labelNode(source)?.textContent?.trim() || path.slice(1);
  const targetLabel = labelNode(target);
  if (targetLabel) targetLabel.textContent = sourceLabel;
  target.setAttribute('aria-label', sourceLabel);
  target.setAttribute('title', sourceLabel);
  target.setAttribute('aria-current', routeActive(path) ? 'page' : 'false');
  target.classList.toggle('text-midground', routeActive(path));
}

function createSecondaryLink(source: HTMLAnchorElement, path: string): HTMLLIElement {
  const item = document.createElement('li');
  item.dataset.htiSecondaryPath = path;
  const link = source.cloneNode(true) as HTMLAnchorElement;
  link.href = path;
  link.removeAttribute('data-discover');
  link.querySelectorAll('.hti-sidebar-tool-active-marker').forEach(node => node.remove());
  link.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    // Delegate to the live native link so React Router also closes the mobile drawer.
    const liveNative = nativeLink(document, path);
    if (liveNative) liveNative.click();
    else navigate(path);
    item.closest('details')?.removeAttribute('open');
  });
  item.appendChild(link);
  return item;
}

function createMoreItem(source: HTMLAnchorElement, root: Document): HTMLLIElement {
  const item = document.createElement('li');
  item.setAttribute(MORE_ITEM_ATTR, 'true');
  const details = document.createElement('details');
  details.className = 'hti-sidebar-more-details';
  const summary = document.createElement('summary');
  summary.className = source.className;
  summary.setAttribute('role', 'button');
  const icon = source.querySelector('svg')?.cloneNode(true);
  if (icon) summary.appendChild(icon);
  const text = document.createElement('span');
  text.className = 'hti-sidebar-more-label';
  text.textContent = uiText('更多', 'More', root);
  summary.appendChild(text);
  const chevron = document.createElement('span');
  chevron.className = 'hti-sidebar-more-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  summary.appendChild(chevron);
  const menu = document.createElement('ul');
  menu.className = 'hti-sidebar-more-menu';
  details.append(summary, menu);
  item.appendChild(details);
  return item;
}

/** Replace ten low-frequency native tabs with one localized disclosure menu. */
export function simplifySidebarNavigation(root: Document = document): boolean {
  const sources = SECONDARY_NAV_PATHS.map(path => nativeLink(root, path));
  if (sources.some(link => !link)) return false;
  const firstItem = sources[0]!.closest('li');
  const list = firstItem?.parentElement;
  if (!firstItem || !list || list.tagName.toLowerCase() !== 'ul') return false;

  let moreItem = root.querySelector<HTMLLIElement>(`[${MORE_ITEM_ATTR}]`);
  if (!moreItem) moreItem = createMoreItem(sources[0]!, root);
  const configItem = nativeLink(root, '/config')?.closest('li');
  if (!configItem || configItem.parentElement !== list) return false;
  // Keep More at the bottom of the retained navigation, directly after Config.
  if (moreItem.parentElement !== list || configItem.nextElementSibling !== moreItem) {
    list.insertBefore(moreItem, configItem.nextElementSibling);
  }

  const summary = moreItem.querySelector<HTMLElement>('summary')!;
  const moreLabel = uiText('更多', 'More', root);
  moreItem.querySelector<HTMLElement>('.hti-sidebar-more-label')!.textContent = moreLabel;
  summary.setAttribute('aria-label', moreLabel);
  summary.setAttribute('title', moreLabel);
  const anyActive = SECONDARY_NAV_PATHS.some(routeActive);
  summary.setAttribute('aria-current', anyActive ? 'page' : 'false');
  summary.classList.toggle('text-midground', anyActive);

  const menu = moreItem.querySelector<HTMLUListElement>('.hti-sidebar-more-menu')!;
  SECONDARY_NAV_PATHS.forEach((path, index) => {
    const source = sources[index]!;
    const sourceItem = source.closest<HTMLElement>('li') ?? source;
    sourceItem.classList.add('hti-secondary-nav-hidden');
    sourceItem.setAttribute('aria-hidden', 'true');
    let item = Array.from(menu.children).find(
      child => child instanceof HTMLLIElement && child.dataset.htiSecondaryPath === path,
    ) as HTMLLIElement | undefined;
    if (!item) {
      item = createSecondaryLink(source, path);
      menu.appendChild(item);
    }
    syncSecondaryLink(item.querySelector('a')!, source, path);
  });
  return true;
}

/**
 * Locate the sidebar footer controls group (theme + language pickers).
 * The host keeps both behind `button[aria-haspopup="listbox"]` triggers;
 * their nearest shared ancestor is the single footer row we compact.
 */
function sidebarPreferences(root: Document): HTMLElement | null {
  const sidebar = root.getElementById('app-sidebar');
  const triggers = Array.from(sidebar?.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]') ?? []);
  if (!sidebar || triggers.length < 2) return null;
  const footerPair = triggers.filter(trigger => {
    let section: HTMLElement | null = trigger.parentElement;
    while (section?.parentElement && section.parentElement !== sidebar) section = section.parentElement;
    return section && triggers.filter(candidate => section!.contains(candidate)).length >= 2;
  });
  if (footerPair.length < 2) return null;
  let common = footerPair[0].parentElement;
  while (common && common !== sidebar && !common.contains(footerPair[1])) common = common.parentElement;
  if (!common || common === sidebar) return null;
  common.classList.add('hti-sidebar-preferences');
  common.parentElement?.classList.add('hti-sidebar-preferences-row');
  const languageButton = footerPair.find(trigger => !trigger.querySelector('svg')) ?? footerPair[1];
  languageButton.setAttribute('data-hti-language-trigger', 'true');
  return common;
}

/** Identify the theme picker's direct wrapper (kept stable across rebuilds). */
function themeTriggerWrapper(preferences: HTMLElement): HTMLElement | null {
  const marked = preferences.querySelector<HTMLElement>('[data-hti-theme-trigger]');
  if (marked) return marked;
  const themeButton = preferences.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="listbox"][title*="theme" i], button[aria-haspopup="listbox"][aria-label*="theme" i], button[aria-haspopup="listbox"][title*="主题"], button[aria-haspopup="listbox"][aria-label*="主题"]',
  ) ?? Array.from(preferences.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]'))
    .find(button => Boolean(button.querySelector('svg'))) ?? null;
  const wrapper = themeButton?.parentElement ?? null;
  wrapper?.setAttribute('data-hti-theme-trigger', 'true');
  return wrapper;
}

function themeButtonLabel(mode: WorkbenchThemeMode, root: Document): string {
  return mode === 'dark'
    ? uiText('切换到亮色主题', 'Switch to light theme', root)
    : uiText('切换到暗色主题', 'Switch to dark theme', root);
}

/** Hide the native theme picker and restore one two-state Workbench mode button. */
export function simplifyThemeControl(root: Document = document): boolean {
  const preferences = sidebarPreferences(root);
  const themeWrapper = preferences ? themeTriggerWrapper(preferences) : null;
  const native = themeWrapper?.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
  if (!native || !themeWrapper) return false;
  native.classList.add('hti-native-theme-picker-hidden');
  native.setAttribute('aria-hidden', 'true');
  native.tabIndex = -1;

  let button = preferences!.querySelector<HTMLButtonElement>(`button[${THEME_BUTTON_ATTR}]`);
  if (!button) {
    button = native.cloneNode(false) as HTMLButtonElement;
    button.setAttribute(THEME_BUTTON_ATTR, 'true');
    button.classList.remove('hti-native-theme-picker-hidden');
    button.removeAttribute('aria-haspopup');
    button.removeAttribute('aria-expanded');
    button.removeAttribute('aria-hidden');
    button.tabIndex = 0;
    button.addEventListener('click', async () => {
      const next: WorkbenchThemeMode = currentMode() === 'dark' ? 'light' : 'dark';
      button!.disabled = true;
      button!.setAttribute('aria-busy', 'true');
      try {
        await setUnifiedWorkbenchTheme(next);
        window.location.reload();
      } catch (error) {
        button!.disabled = false;
        button!.removeAttribute('aria-busy');
        button!.dataset.themeError = String(error);
      }
    });
    themeWrapper.insertBefore(button, native);
  }

  const mode = currentMode();
  const label = themeButtonLabel(mode, root);
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'hti-theme-toggle-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = mode === 'dark' ? '☀' : '☾';
  button.append(icon);
  return true;
}

/** Replace the native wordmark with its live version and remove footer identity/vendor chrome. */
export function simplifySidebarIdentity(root: Document = document): boolean {
  const sidebar = root.getElementById('app-sidebar');
  const vendor = sidebar?.querySelector<HTMLAnchorElement>('a[href*="nousresearch.com"]');
  const footer = vendor?.parentElement;
  if (!sidebar || !footer) return false;
  const version = Array.from(footer.querySelectorAll<HTMLElement>('span,p,div'))
    .map(node => node.textContent?.trim() || '')
    .find(text => /^v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/i.test(text));
  if (!version) return false;

  const header = sidebar.firstElementChild as HTMLElement | null;
  let brand = header?.querySelector<HTMLElement>('[data-hti-version-brand]') ?? null;
  if (!brand) {
    brand = Array.from(header?.querySelectorAll<HTMLElement>('p,span,div') ?? [])
      .find(node => (node.textContent || '').replace(/\s+/g, '').toLocaleLowerCase() === 'hermesagent') ?? null;
  }
  if (!brand) return false;
  if (!brand.hasAttribute('data-hti-version-brand')) brand.dataset.htiVersionBrand = 'true';
  if (brand.textContent?.trim() !== version) brand.textContent = version;
  const title = `Hermes Agent ${version}`;
  if (brand.getAttribute('title') !== title) brand.setAttribute('title', title);
  footer.parentElement?.classList.add(IDENTITY_SECTION_HIDDEN);
  return true;
}

/** Hide sidebar system actions; restart remains available from More → System. */
export function simplifyRestartControl(root: Document = document): boolean {
  const sidebar = root.getElementById('app-sidebar');
  const preferences = sidebarPreferences(root);
  if (!sidebar) return false;
  sidebar.querySelector('[data-hti-quick-actions]')?.remove();

  const systemSection = Array.from(sidebar.children)
    .filter((el): el is HTMLElement => el instanceof HTMLElement && Boolean(el.querySelector('ul > li > button')))
    .find(section => !preferences || !section.contains(preferences)) ?? null;
  if (!systemSection) return false;
  systemSection.classList.add(SYSTEM_SECTION_HIDDEN);
  return true;
}

/** Hide the redundant amber warning; the sidebar selector already shows the active profile. */
export function hideProfileScopeBanner(root: Document = document): boolean {
  const banner = Array.from(root.querySelectorAll<HTMLElement>('div'))
    .find(node => (
      node.classList.contains('border-amber-500/40')
      && node.classList.contains('bg-amber-500/10')
      && node.classList.contains('text-amber-300')
      && Boolean(node.querySelector('svg'))
      && !node.hasAttribute('role')
      && !node.querySelector('button')
    ));
  if (!banner) return false;
  banner.classList.add(PROFILE_SCOPE_BANNER_HIDDEN);
  banner.setAttribute('aria-hidden', 'true');
  return true;
}

export function installSidebarSimplification(): void {
  if ((window as any).__HERMES_WORKBENCH_SIDEBAR_SIMPLIFY__) return;
  (window as any).__HERMES_WORKBENCH_SIDEBAR_SIMPLIFY__ = true;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      simplifySidebarNavigation();
      simplifyThemeControl();
      simplifyRestartControl();
      simplifySidebarIdentity();
      hideProfileScopeBanner();
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
