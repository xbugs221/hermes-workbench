/** Keep the host's real plugin navigation group ahead of all built-in tabs. */
const PLUGIN_HEADING_ID = 'hermes-sidebar-plugin-nav-heading';
const FIRST_CLASS = 'hti-sidebar-plugin-nav-first';
const COLLAPSED_CLASS = 'lg:w-14';
const COLLAPSED_LABEL_ATTR = 'data-hti-sidebar-collapsed-label';

/**
 * Moves the native React group (not a copy) to the first position inside its nav.
 * It therefore retains route handling, active state, keyboard controls, and mobile drawer behavior.
 */
export function movePluginNavigationFirst(root: Pick<Document, 'getElementById'> = document): boolean {
  const heading = root.getElementById(PLUGIN_HEADING_ID);
  const group = heading?.closest<HTMLElement>('[role="group"]');
  const nav = group?.parentElement;
  if (!group || !nav || nav.tagName.toLowerCase() !== 'nav') return false;
  group.classList.add(FIRST_CLASS);
  if (nav.firstElementChild !== group) nav.insertBefore(group, nav.firstElementChild);
  return true;
}

/** Mirror the host's desktop collapse class onto injected navigation semantics. */
export function syncSidebarCollapsedState(root: Pick<Document, 'getElementById'> = document): boolean {
  const sidebar = root.getElementById('app-sidebar');
  if (!sidebar) return false;
  const collapsed = sidebar.classList.contains(COLLAPSED_CLASS);
  if (sidebar.dataset.htiDesktopCollapsed !== String(collapsed)) {
    sidebar.dataset.htiDesktopCollapsed = String(collapsed);
  }

  const seen = new Set<string>();
  for (const item of sidebar.querySelectorAll<HTMLElement>('[data-hti-sidebar-tool]')) {
    const key = item.dataset.htiSidebarTool;
    if (key && seen.has(key)) {
      item.remove();
      continue;
    }
    if (key) seen.add(key);
    for (const label of item.querySelectorAll<HTMLElement>('a > span')) {
      if (label.hasAttribute('aria-hidden') && !label.hasAttribute(COLLAPSED_LABEL_ATTR)) continue;
      if (collapsed) {
        label.setAttribute(COLLAPSED_LABEL_ATTR, 'true');
        label.setAttribute('aria-hidden', 'true');
      } else if (label.hasAttribute(COLLAPSED_LABEL_ATTR)) {
        label.removeAttribute(COLLAPSED_LABEL_ATTR);
        label.removeAttribute('aria-hidden');
      }
    }
  }
  return true;
}

function directSidebarSection(node: HTMLElement, sidebar: HTMLElement): HTMLElement | null {
  let section: HTMLElement | null = node;
  while (section?.parentElement && section.parentElement !== sidebar) section = section.parentElement;
  return section?.parentElement === sidebar ? section : null;
}

/** Mark the native sidebar shell without depending on translated labels or hashed host classes. */
export function arrangeSidebarPreferences(root: Pick<Document, 'getElementById'> = document): boolean {
  const sidebar = root.getElementById('app-sidebar');
  if (!sidebar) return false;
  sidebar.classList.add('hti-sidebar-adaptive-width');
  syncSidebarCollapsedState(root);
  const triggers = Array.from(sidebar.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]'));
  if (triggers.length < 2) return false;
  const footerSection = Array.from(new Set(triggers.map(trigger => directSidebarSection(trigger, sidebar))))
    .filter((section): section is HTMLElement => Boolean(section))
    .find(section => triggers.filter(trigger => section.contains(trigger)).length >= 2);
  const footerTriggers = footerSection
    ? triggers.filter(trigger => footerSection.contains(trigger))
    : [];
  if (!footerSection || footerTriggers.length < 2) return false;
  let common = footerTriggers[0].parentElement;
  while (common && common !== footerSection && !common.contains(footerTriggers[1])) {
    common = common.parentElement;
  }
  if (!common || common === sidebar) return false;
  common.classList.add('hti-sidebar-preferences');
  common.parentElement?.classList.add('hti-sidebar-preferences-row');
  return true;
}

/** React rebuilds sidebar links during route/profile/theme updates, so restore order on the next frame. */
export function installPluginNavigationFirst(): void {
  if ((window as any).__HERMES_WORKBENCH_PLUGIN_NAV_FIRST__) return;
  (window as any).__HERMES_WORKBENCH_PLUGIN_NAV_FIRST__ = true;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      movePluginNavigationFirst();
      arrangeSidebarPreferences();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  schedule();
}
