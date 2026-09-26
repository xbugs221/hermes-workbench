// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  terminalWorkspaceCriticalStyle,
  terminalWorkspaceGeometry,
  terminalWorkspaceReady,
} from '../dashboard/src/header-terminal-layout';
import {
  relocateSidebarToolsNavigation,
  terminalRouteActive,
  workbenchRouteActive,
} from '../dashboard/src/top-plugin-navigation';
import {
  arrangeSidebarPreferences,
  syncSidebarCollapsedState,
} from '../dashboard/src/plugin-navigation-order';

describe('Workbench sidebar tools', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.workbenchRoute;
    document.documentElement.lang = 'en';
    document.documentElement.style.removeProperty('--hti-host-sidebar-width');
    window.history.replaceState(null, '', '/');
  });

  it('computes the terminal content workspace', () => {
    const geometry = terminalWorkspaceGeometry(
      { bottom: 64 },
      { width: 1440, height: 900, offsetLeft: 0, offsetTop: 0 },
      false,
      240,
    );
    expect(geometry).toEqual({ left: '240px', top: '64px', width: '1200px', height: '836px' });
    expect(terminalWorkspaceReady(true, {})).toBe(false);
    expect(terminalWorkspaceReady(true, geometry)).toBe(true);
    expect(terminalWorkspaceCriticalStyle(geometry)).toMatchObject({
      ...geometry,
      position: 'fixed', zIndex: '1001', display: 'grid', pointerEvents: 'auto',
      maxWidth: 'none', transform: 'none', translate: 'none',
    });
  });

  it('installs adjacent Terminal and Files tabs and removes header tools', () => {
    document.documentElement.lang = 'en';
    window.history.replaceState(null, '', '/chat');
    document.body.innerHTML = `
      <header role="banner"><div><div>Workbench</div><div class="hti-host-header-tools"></div></div></header>
      <aside id="app-sidebar"><nav>
        <div role="group" aria-labelledby="hermes-sidebar-plugin-nav-heading">
          <span id="hermes-sidebar-plugin-nav-heading">Plugins</span>
          <ul><li><a href="/kanban"><svg></svg><span>Kanban</span><span aria-hidden="true"></span></a></li></ul>
        </div>
        <ul><li><a href="/chat"><svg></svg><span>Chat</span><span aria-hidden="true"></span></a></li>
          <li id="native-files"><a href="/files"><svg></svg><span>Files</span><span aria-hidden="true"></span></a></li></ul>
      </nav></aside>`;

    expect(relocateSidebarToolsNavigation()).toBe(true);
    const pluginList = document.querySelector<HTMLUListElement>('[role="group"] ul')!;
    const tools = Array.from(pluginList.children)
      .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement && Boolean(child.dataset.htiSidebarTool));
    const terminal = document.getElementById('hti-sidebar-terminal-tab') as HTMLAnchorElement;
    const files = document.getElementById('hti-sidebar-files-tab') as HTMLAnchorElement;

    expect(tools.map(item => item.dataset.htiSidebarTool)).toEqual([
      'hti-sidebar-terminal-tab', 'hti-sidebar-files-tab',
    ]);
    expect(terminal.textContent).toContain('Terminal');
    expect(files.textContent).toContain('Files');
    expect(document.getElementById('native-files')!.classList.contains('hti-native-files-nav-hidden')).toBe(true);
    expect(document.querySelector('.hti-host-header-tools')).toBeNull();
    expect(document.documentElement.dataset.workbenchRoute).toBe('true');

    // Restoring an already-correct tree must not duplicate the tabs.
    expect(relocateSidebarToolsNavigation()).toBe(true);
    expect(Array.from(pluginList.children).filter(child => (child as HTMLElement).dataset.htiSidebarTool)).toHaveLength(2);
    expect(files.closest('li')!.classList.contains('hti-native-files-nav-hidden')).toBe(false);
    expect(files.closest('li')!.hasAttribute('aria-hidden')).toBe(false);

    document.documentElement.lang = 'zh-CN';
    relocateSidebarToolsNavigation();
    expect(terminal.textContent).toContain('终端');
    expect(terminal.textContent).not.toContain('Terminal');
    expect(files.textContent).toContain('文件');
    expect(files.textContent).not.toContain('Files');

    terminal.click();
    expect(`${window.location.pathname}${window.location.search}`).toBe('/chat?workbench=terminal');
    relocateSidebarToolsNavigation();
    expect(terminal.getAttribute('aria-current')).toBe('page');

    files.click();
    expect(window.location.pathname).toBe('/files');
    relocateSidebarToolsNavigation();
    expect(files.getAttribute('aria-current')).toBe('page');
    expect(document.documentElement.dataset.workbenchRoute).toBe('false');
  });

  it('detects terminal and Workbench routes independently', () => {
    expect(terminalRouteActive('/chat?workbench=terminal')).toBe(true);
    expect(terminalRouteActive('/chat')).toBe(false);
    expect(terminalRouteActive('/files?workbench=terminal')).toBe(false);
    expect(workbenchRouteActive('/chat?workbench=terminal')).toBe(true);
    expect(workbenchRouteActive('/files')).toBe(false);
  });

  it('collapses the real host sidebar shape to an icon-only rail without duplicate tools', () => {
    (window as any).happyDOM.setInnerWidth(1280);
    const style = document.createElement('style');
    style.textContent = readFileSync(`${process.cwd()}/dashboard/src/plugin-navigation-order.css`, 'utf8');
    document.head.appendChild(style);
    document.body.innerHTML = `
      <aside id="app-sidebar" class="fixed w-64 lg:sticky lg:overflow-hidden">
        <div><button aria-label="Collapse navigation"></button></div>
        <div class="profile-switcher"><svg></svg><div id="hermes-profile-switcher"><button aria-haspopup="listbox">default</button></div></div>
        <nav>
          <ul><li><a href="/chat"><svg></svg><span>Chat</span><span aria-hidden="true"></span></a></li>
            <li id="native-files"><a href="/files"><svg></svg><span>Files</span><span aria-hidden="true"></span></a></li></ul>
          <div role="group" aria-labelledby="hermes-sidebar-plugin-nav-heading">
            <span id="hermes-sidebar-plugin-nav-heading">Plugins</span>
            <ul><li><a href="/kanban"><svg></svg><span>Kanban</span><span aria-hidden="true"></span></a></li></ul>
          </div>
        </nav>
        <div class="system-section"><span>SYSTEM</span><ul><li><button><svg></svg><span>Restart</span></button></li></ul></div>
        <div class="footer-row"><div class="footer-controls">
          <div><button aria-haspopup="listbox" aria-label="Switch theme"><svg></svg><span>Theme</span></button></div>
          <div><button aria-haspopup="listbox" aria-label="Switch language"><span>English</span></button></div>
        </div></div>
        <div class="auth-footer">user</div>
      </aside>`;

    const sidebar = document.getElementById('app-sidebar')!;
    expect(relocateSidebarToolsNavigation()).toBe(true);
    expect(arrangeSidebarPreferences()).toBe(true);
    expect(document.querySelector('.profile-switcher.hti-sidebar-preferences')).toBeNull();
    expect(document.querySelector('.footer-controls.hti-sidebar-preferences')).not.toBeNull();

    sidebar.classList.add('lg:w-14');
    expect(syncSidebarCollapsedState()).toBe(true);
    expect(sidebar.dataset.htiDesktopCollapsed).toBe('true');
    expect(getComputedStyle(sidebar).width).toBe('56px');
    const tools = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-hti-sidebar-tool]'));
    expect(tools.map(item => item.dataset.htiSidebarTool)).toEqual([
      'hti-sidebar-terminal-tab',
      'hti-sidebar-files-tab',
    ]);
    for (const item of tools) {
      expect(item.querySelector('a')?.getAttribute('aria-label')).toBeTruthy();
      expect(item.querySelector('span:not([aria-hidden])')).toBeNull();
      expect(getComputedStyle(item.querySelector<HTMLElement>('[data-hti-sidebar-collapsed-label]')!).display).toBe('none');
    }

    document.documentElement.lang = 'zh-CN';
    expect(relocateSidebarToolsNavigation()).toBe(true);
    expect(document.getElementById('hti-sidebar-terminal-tab')?.getAttribute('aria-label')).toBe('终端');
    expect(document.getElementById('hti-sidebar-files-tab')?.getAttribute('aria-label')).toBe('文件');

    sidebar.classList.remove('lg:w-14');
    document.documentElement.style.setProperty('--hti-host-sidebar-width', '240px');
    expect(syncSidebarCollapsedState()).toBe(true);
    expect(getComputedStyle(sidebar).width).toBe('240px');
    expect(sidebar.querySelectorAll('[data-hti-sidebar-tool] span:not([aria-hidden])')).toHaveLength(2);
    expect(document.getElementById('hti-sidebar-terminal-tab')?.textContent).toContain('终端');
    expect(document.getElementById('hti-sidebar-files-tab')?.textContent).toContain('文件');

    (window as any).happyDOM.setInnerWidth(800);
    sidebar.classList.add('lg:w-14');
    expect(getComputedStyle(sidebar).width).not.toBe('56px');
    style.remove();
  });
});
