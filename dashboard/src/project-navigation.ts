/** Manual project navigation. Membership persists through the existing organization API. */
export interface ProjectSession {
  id: string;
  groupId?: string | null;
  deleted?: boolean;
  favorite?: boolean;
}
export interface SessionProject { id: string; name: string }
export const PANE_DRAG_TYPE = 'application/x-hermes-pane-sessions';
export const SESSION_DRAG_TYPE = 'application/x-hermes-project-session';

export function partitionProjectSessions<T extends ProjectSession>(sessions: T[], projects: SessionProject[]) {
  const groups = [...new Map(projects.filter(project => project.id).map(project => [project.id, project])).values()]
    .map(project => ({ project, sessions: [] as T[] }));
  const byId = new Map(groups.map(group => [group.project.id, group]));
  const temporary: T[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session.id || session.deleted || seen.has(session.id)) continue;
    seen.add(session.id);
    const group = session.groupId ? byId.get(session.groupId) : undefined;
    (group ? group.sessions : temporary).push(session);
  }
  // Keep the user's existing order within each section, while making saved
  // sessions immediately discoverable at the top of their current folder.
  const pinFavorites = (items: T[]) => items.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
  groups.forEach(group => pinFavorites(group.sessions));
  pinFavorites(temporary);
  return { groups, temporary };
}

/** Reject external drags, stale sessions, cross-profile drops, and redundant writes. */
export function projectDropSession<T extends ProjectSession>(
  payload: string, profile: string, projectId: string | null, sessions: T[], projects: SessionProject[],
): T | null {
  if (projectId !== null && !projects.some(project => project.id === projectId)) return null;
  try {
    const drag = JSON.parse(payload);
    if (drag?.profile !== profile || typeof drag?.sessionId !== 'string') return null;
    const session = sessions.find(item => item.id === drag.sessionId && !item.deleted);
    return session && (session.groupId || null) !== projectId ? session : null;
  } catch { return null; }
}

interface ProjectNavigationProps {
  profile: string;
  sessions: ProjectSession[];
  projects: SessionProject[];
  activeSessionId: string;
  renderSession: (session: ProjectSession, archived?: boolean) => any;
  onCreate: (trigger: HTMLElement) => void;
  onRename: (project: SessionProject, trigger: HTMLElement) => void;
  onDelete: (project: SessionProject) => void;
  onMove: (session: ProjectSession, projectId: string | null) => Promise<unknown>;
  onPaneDragStart?: (payload: string) => void;
  onPaneDragEnd?: () => void;
  history?: any;
}

export function createProjectNavigation(sdk: Record<string, any>, ThemeToggle?: any) {
  const h = sdk.React.createElement;
  const { useState, useRef, useEffect } = sdk.hooks;
  const icon = (path: string) => h('svg', { viewBox: '0 0 24 24', width: 18, height: 18,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: path }));
  return function ProjectNavigation(props: ProjectNavigationProps) {
    const { profile, sessions, projects, renderSession, onMove } = props;
    const [dropTarget, setDropTarget] = useState(undefined);
    const [notice, setNotice] = useState('');
    const [historyOpen, setHistoryOpen] = useState(false);
    const historyTrigger = useRef(null);
    const historyId = sdk.React.useId();
    const moving = useRef(false);
    const folders = useRef(new Map<string, HTMLDetailsElement>());
    const activeProjectId = sessions.find(session => session.id === props.activeSessionId)?.groupId;
    useEffect(() => {
      if (activeProjectId) {
        const folder = folders.current.get(activeProjectId);
        if (folder) folder.open = true;
      }
    }, [activeProjectId, props.activeSessionId]);
    const { groups, temporary } = partitionProjectSessions(sessions, projects);
    const dropProps = (projectId: string | null) => ({
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(SESSION_DRAG_TYPE) || moving.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(projectId);
      },
      onDragLeave: (event: DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
      },
      onDrop: async (event: DragEvent) => {
        const payload = event.dataTransfer?.getData(SESSION_DRAG_TYPE);
        setDropTarget(undefined);
        if (!payload || moving.current) return;
        event.preventDefault();
        event.stopPropagation();
        const session = projectDropSession(payload, profile, projectId, sessions, projects);
        if (!session) return;
        const target = event.currentTarget as HTMLDetailsElement;
        moving.current = true;
        setNotice('正在移动会话…');
        try {
          const saved = await onMove(session, projectId);
          setNotice(saved ? '' : '移动失败，请重试');
          if (saved && projectId !== null) target.open = true;
        } catch { setNotice('移动失败，请重试'); }
        finally { moving.current = false; }
      },
    });
    const startPaneDrag = (event: DragEvent, sessionIds: string[]) => {
      const payload = JSON.stringify({ profile, sessionIds });
      event.dataTransfer?.setData(PANE_DRAG_TYPE, payload);
      props.onPaneDragStart?.(payload);
    };
    const endDrag = () => { setDropTarget(undefined); props.onPaneDragEnd?.(); };
    const row = (session: ProjectSession) => h('div', {
      key: session.id, className: 'project-session-drag', draggable: true, 'data-session-id': session.id,
      onDragStart: (event: DragEvent) => {
        if (!event.dataTransfer || moving.current) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify({ profile, sessionId: session.id }));
        startPaneDrag(event, [session.id]);
      },
      onDragEnd: endDrag,
    }, renderSession(session, false));
    return h(sdk.React.Fragment, null,
      h('section', { className: 'project-navigation', 'aria-label': '项目' },
        h('div', { className: 'project-section-heading' }, h('span', null, '项目'),
          h('div', { className: 'project-heading-actions' },
          h('button', { type: 'button', className: 'project-history-toggle', ref: historyTrigger,
            title: '历史与归档', 'aria-label': '历史与归档', 'aria-expanded': historyOpen,
            'aria-controls': historyId, onClick: () => setHistoryOpen((open: boolean) => !open) },
            icon('M5 12h.01M12 12h.01M19 12h.01')),
          h('button', { type: 'button', className: 'project-create', title: '新建项目', 'aria-label': '新建项目',
            onClick: (event: MouseEvent) => props.onCreate(event.currentTarget as HTMLElement) }, icon('M12 5v14M5 12h14')))),
        h('div', { id: historyId, className: 'project-history-panel', hidden: !historyOpen,
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.stopPropagation(); setHistoryOpen(false); historyTrigger.current?.focus(); }
          } }, props.history),
        ...groups.map(({ project, sessions: members }) => h('details', {
          key: project.id, className: `project-folder${dropTarget === project.id ? ' is-drop-target' : ''}`,
          'data-project-id': project.id,
          ref: (node: HTMLDetailsElement | null) => { node ? folders.current.set(project.id, node) : folders.current.delete(project.id); },
          ...dropProps(project.id),
        }, h('summary', { className: 'project-folder-heading', draggable: true,
          title: '拖到右侧并排打开项目会话',
          onDragStart: (event: DragEvent) => {
            if (!event.dataTransfer || (event.target as HTMLElement).closest('button')) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = 'copy';
            startPaneDrag(event, members.map(session => session.id));
          }, onDragEnd: endDrag },
          icon('M3 7V5h6l2 2h10v13H3z'),
          h('span', { className: 'project-name', title: project.name }, project.name),
          h('span', { className: 'project-count' }, members.length),
          h('span', { className: 'project-actions' },
            h('button', { type: 'button', title: '重命名项目', 'aria-label': `重命名项目：${project.name}`,
              onClick: (event: MouseEvent) => { event.preventDefault(); props.onRename(project, event.currentTarget as HTMLElement); } }, icon('m16 3 5 5-12 12H4v-5z')),
            h('button', { type: 'button', title: '删除项目', 'aria-label': `删除项目：${project.name}`,
              onClick: (event: MouseEvent) => { event.preventDefault(); props.onDelete(project); } }, icon('M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14')))),
          members.length ? members.map(row) : h('p', { className: 'project-empty' }, '拖拽会话到此项目'))),
        groups.length ? null : h('p', { className: 'project-empty' }, '新建项目后，将会话拖入整理')),
      h('section', { className: `project-temporary${dropTarget === null ? ' is-drop-target' : ''}`,
        'aria-label': '临时会话', ...dropProps(null) },
        h('div', { className: 'project-section-heading' }, h('span', null, '临时会话'),
          ThemeToggle ? h(ThemeToggle) : null),
        ...temporary.map(row),
        temporary.length ? null : h('p', { className: 'project-empty' }, '未加入项目的会话显示在这里')),
      notice ? h('p', { className: 'project-empty', role: 'status' }, notice) : null);
  };
}
