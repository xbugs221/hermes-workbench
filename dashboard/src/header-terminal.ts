/** Sidebar Terminal tab backed by an unrestricted authenticated shell PTY. */
import { createTerminalPanel } from './terminal-panel';
import {
  terminalWorkspaceCriticalStyle,
  terminalWorkspaceGeometry,
  terminalWorkspaceReady,
} from './header-terminal-layout';
import { terminalRouteActive, workbenchRouteActive } from './top-plugin-navigation';
import { uiText } from './ui-locale';

type SDK = Record<string, any>;

function element(React: any, type: any, props?: Record<string, any> | null, ...children: any[]): any {
  return React.createElement(type, props, ...children);
}

function navigateWithinDashboard(route: string): void {
  window.history.pushState(null, '', route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Register the PTY host; its visible trigger lives in the Plugins sidebar group. */
export function installHeaderTerminal(sdk: SDK, registry: Record<string, any>): void {
  if ((window as any).__HERMES_WORKBENCH_HEADER_TERMINAL__) return;
  (window as any).__HERMES_WORKBENCH_HEADER_TERMINAL__ = true;
  const React = sdk.React;
  const { useEffect, useState } = sdk.hooks;
  const { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } = sdk.components;
  const TerminalPanel = createTerminalPanel(sdk);

  function SidebarTerminalHost(): any {
    const [open, setOpen] = useState(terminalRouteActive());
    const [workspaceStyle, setWorkspaceStyle] = useState({} as Record<string, string>);

    useEffect(() => {
      const sync = () => setOpen(terminalRouteActive());
      window.addEventListener('popstate', sync);
      return () => window.removeEventListener('popstate', sync);
    }, []);

    useEffect(() => {
      if (!open) {
        setWorkspaceStyle({});
        return undefined;
      }
      const updateGeometry = () => {
        const banner = document.querySelector<HTMLElement>('header[role="banner"]');
        const rect = banner?.getBoundingClientRect() || { bottom: 0 };
        const sidebarRight = document.querySelector<HTMLElement>('#app-sidebar')
          ?.getBoundingClientRect().right ?? 0;
        const viewport = window.visualViewport;
        setWorkspaceStyle(terminalWorkspaceGeometry(
          { bottom: workbenchRouteActive() ? (viewport?.offsetTop ?? 0) : rect.bottom },
          {
            width: viewport?.width ?? window.innerWidth,
            height: viewport?.height ?? window.innerHeight,
            offsetLeft: viewport?.offsetLeft ?? 0,
            offsetTop: viewport?.offsetTop ?? 0,
          },
          window.matchMedia('(max-width: 800px)').matches,
          sidebarRight,
        ));
      };
      updateGeometry();
      window.addEventListener('resize', updateGeometry);
      window.visualViewport?.addEventListener('resize', updateGeometry);
      window.visualViewport?.addEventListener('scroll', updateGeometry);
      return () => {
        window.removeEventListener('resize', updateGeometry);
        window.visualViewport?.removeEventListener('resize', updateGeometry);
        window.visualViewport?.removeEventListener('scroll', updateGeometry);
      };
    }, [open]);

    const workspaceReady = terminalWorkspaceReady(open, workspaceStyle);
    useEffect(() => {
      if (!workspaceReady) return undefined;
      const dialog = document.getElementById('hti-dashboard-terminal-dialog');
      if (!dialog) return undefined;
      if (dialog.closest('header[role="banner"]')) document.body.appendChild(dialog);
      const hiddenOverlays: HTMLElement[] = [];
      for (const overlay of Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]'))) {
        if (overlay.parentElement !== dialog.parentElement) continue;
        overlay.style.setProperty('display', 'none', 'important');
        overlay.dataset.htiTerminalOverlay = 'true';
        hiddenOverlays.push(overlay);
      }
      return () => {
        for (const overlay of hiddenOverlays) {
          overlay.style.removeProperty('display');
          delete overlay.dataset.htiTerminalOverlay;
        }
      };
    }, [workspaceReady]);

    const closeTerminal = () => {
      setOpen(false);
      navigateWithinDashboard('/chat');
      window.requestAnimationFrame(() => document.getElementById('hti-sidebar-terminal-tab')?.focus());
    };

    return element(React, Dialog, {
      open,
      modal: false,
      onOpenChange: (nextOpen: boolean) => {
        if (!nextOpen) closeTerminal();
      },
    },
    element(React, 'span', { className: 'hti-terminal-slot-host', 'aria-hidden': true }),
    workspaceReady ? element(React, DialogContent, {
      id: 'hti-dashboard-terminal-dialog',
      className: 'hti-terminal-workspace',
      showCloseButton: false,
      style: terminalWorkspaceCriticalStyle(workspaceStyle),
      onCloseAutoFocus: (event: Event) => event.preventDefault(),
      onInteractOutside: (event: Event) => event.preventDefault(),
      'aria-describedby': 'hti-dashboard-terminal-description',
    },
      element(React, 'header', { className: 'hti-terminal-workspace-header' },
        element(React, 'div', { className: 'hti-terminal-workspace-title' },
          element(React, DialogTitle, { id: 'hti-dashboard-terminal-title' }, uiText('终端', 'Terminal')),
          element(React, DialogDescription, { id: 'hti-dashboard-terminal-description' },
            uiText('可自由输入命令 · /opt/data · 默认配置', 'Run commands freely · /opt/data · default profile'))),
        element(React, DialogClose, {
          className: 'hti-terminal-workspace-close',
          onClick: closeTerminal,
          'aria-label': uiText('关闭终端', 'Close terminal'),
          title: uiText('关闭终端', 'Close terminal'),
        }, element(React, 'span', { 'aria-hidden': true }, '×'))),
      element(React, TerminalPanel, {
        mode: 'shell', profile: 'default', instanceId: 'dashboard-raw-terminal',
        workspaceId: 'dashboard-root', workspacePath: '/opt/data', active: open, visible: open,
      })) : null);
  }

  registry.registerSlot('workbench', 'header-right', SidebarTerminalHost);
}
