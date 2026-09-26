/** Unified creation entry: context menu and touch hold choose the new session's workspace. */
export function createNewSessionButton(React) {
  const h = React.createElement;
  return function NewSessionButton({ workspaces, loading, error, onCreate, icon }) {
    const [anchor, setAnchor] = React.useState(null);
    const button = React.useRef(null), menu = React.useRef(null), timer = React.useRef(null);
    const origin = React.useRef(null), held = React.useRef(false);
    const cancel = () => { clearTimeout(timer.current); timer.current = null; };
    const open = () => { cancel(); const rect = button.current.getBoundingClientRect(); setAnchor({ left: Math.min(rect.left, Math.max(8, innerWidth - 296)), top: Math.min(rect.bottom + 4, innerHeight - 200) }); };
    const close = () => { setAnchor(null); button.current?.focus(); };
    React.useEffect(() => () => clearTimeout(timer.current), []);
    React.useEffect(() => {
      if (!anchor) return;
      menu.current?.querySelector('button')?.focus();
      const outside = event => { if (!menu.current?.contains(event.target) && !button.current?.contains(event.target)) setAnchor(null); };
      const key = event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') setAnchor(null);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...menu.current.querySelectorAll('button')], index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      };
      document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
      return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
    }, [anchor]);
    return h(React.Fragment, null,
      h('button', { ref: button, type: 'button', className: 'codex-new-chat', 'aria-label': '新建', title: '新建；右键或长按选择工作区', 'aria-haspopup': 'menu', 'aria-expanded': !!anchor,
        onContextMenu: event => { event.preventDefault(); open(); },
        onPointerDown: event => { held.current = false; if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return; origin.current = { x: event.clientX, y: event.clientY }; timer.current = setTimeout(() => { held.current = true; open(); }, 550); },
        onPointerMove: event => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancel(); },
        onPointerUp: cancel, onPointerCancel: cancel,
        onClick: event => { if (held.current) { event.preventDefault(); held.current = false; return; } if (anchor) { close(); return; } onCreate(); },
      }, icon, h('span', null, '新建')),
      anchor ? h('div', { ref: menu, role: 'menu', 'aria-label': '选择新会话工作区', className: 'new-session-workspace-menu', style: anchor },
        h('div', { className: 'new-session-workspace-heading' }, '选择工作区后新建'),
        loading ? h('p', { role: 'status' }, '正在读取工作区…') : error ? h('p', { role: 'alert' }, error) : !workspaces.length ? h('p', { role: 'status' }, '没有可用工作区') : workspaces.map(workspace => h('button', { key: workspace.id, type: 'button', role: 'menuitem', onClick: () => { close(); onCreate(workspace.id); } }, h('span', null, workspace.name), h('small', null, workspace.path)))) : null);
  };
}
