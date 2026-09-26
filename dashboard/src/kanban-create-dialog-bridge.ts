/**
 * Shape the native Kanban create form without replacing its React submit/state logic.
 * Keep the fields needed to describe and schedule a task visible at the first level.
 */
const KANBAN_API = '/api/plugins/kanban';

type Project = { id: string; slug?: string; name?: string; primary_path?: string };

function boardFromLocation(): string { return new URLSearchParams(window.location.search).get('board') || ''; }
function api(path: string): string {
  const board = boardFromLocation();
  return board ? `${KANBAN_API}${path}${path.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}` : `${KANBAN_API}${path}`;
}
async function authedFetch(url: string): Promise<Response> {
  const sdk = (window as any).__HERMES_PLUGIN_SDK__;
  return sdk?.authedFetch ? sdk.authedFetch(url) : fetch(url, { credentials: 'same-origin' });
}

/** React-controlled native input update, preserving its validation and create request shape. */
function setReactValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function nativeWorkspaceControls(form: HTMLElement): { kind: HTMLSelectElement; path: HTMLInputElement | null } | null {
  const workspaceLabel = Array.from(form.querySelectorAll('label')).find(label => /workspace|工作区/i.test(label.textContent || ''));
  const row = workspaceLabel?.parentElement;
  const kind = row?.querySelector('select') as HTMLSelectElement | null;
  if (!kind) return null;
  return { kind, path: row?.querySelector('input') as HTMLInputElement | null };
}

async function projects(): Promise<Project[]> {
  const response = await authedFetch(api('/projects'));
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body.projects) ? body.projects.filter((project: Project) => project.primary_path) : [];
}

async function boardDefaultWorkspace(): Promise<string> {
  const response = await authedFetch(api('/boards'));
  if (!response.ok) return '';
  const body = await response.json();
  const slug = boardFromLocation() || body.current;
  const board = (body.boards || []).find((item: any) => item.slug === slug);
  return String(board?.default_workdir || '').trim();
}

function localizeDialogTitle(form: HTMLElement): void {
  const title = form.querySelector('.hermes-kanban-dialog-title');
  if (title?.textContent?.trim().startsWith('New task')) {
    title.textContent = title.textContent.replace(/^\s*New task/, '新建任务');
  }
}

function applyResolvedColors(form: HTMLElement): void {
  const root = getComputedStyle(document.documentElement);
  const ink = root.getPropertyValue('--color-popover-foreground').trim()
    || root.getPropertyValue('--color-card-foreground').trim()
    || root.getPropertyValue('--midground').trim();
  const muted = root.getPropertyValue('--color-muted-foreground').trim() || ink;
  for (const element of Array.from(form.querySelectorAll<HTMLElement>(
    '.hti-kanban-create-workspace label, .hti-kanban-create-workspace select, .hti-kanban-create-body-label',
  ))) element.style.setProperty('color', ink, 'important');
  for (const element of Array.from(form.querySelectorAll<HTMLElement>('.hti-kanban-create-workspace p')))
    element.style.setProperty('color', muted, 'important');
}

function labelText(element: Element): string {
  return element.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function installForm(form: HTMLElement): void {
  localizeDialogTitle(form);
  applyResolvedColors(form);
  if (form.dataset.htiCreateDialog === 'ready') return;
  const fields = form.querySelector('.flex.flex-col.gap-3') as HTMLElement | null;
  if (!fields || !fields.children.length) return;
  form.dataset.htiCreateDialog = 'ready';
  const titleField = fields.children[0] as HTMLElement;
  const existingBody = fields.querySelector('textarea') as HTMLTextAreaElement | null;
  if (!existingBody) {
    const body = document.createElement('textarea');
    body.name = 'body';
    body.className = 'hti-kanban-create-body';
    body.placeholder = '任务说明（可选）';
    body.rows = 4;
    const label = document.createElement('label');
    label.textContent = '说明';
    label.className = 'hti-kanban-create-body-label';
    const wrapper = document.createElement('div');
    wrapper.className = 'hti-kanban-create-body-field';
    wrapper.append(label, body);
    titleField.after(wrapper);
  } else {
    existingBody.name = existingBody.name || 'body';
    existingBody.classList.add('hti-kanban-create-body');
  }

  // Keep priority, parent, goal mode, and the native workspace controls. The
  // old foldout's agent/skills/model fields are not task creation concerns.
  const keep = /priority|父任务|parent|目标模式|goal mode|workspace|工作区/i;
  for (const child of Array.from(fields.children).slice(1)) {
    if (child.classList.contains('hti-kanban-create-body-field') || child.querySelector('textarea')) continue;
    if (!keep.test(labelText(child))) child.remove();
  }

  const workspace = document.createElement('div');
  workspace.className = 'hti-kanban-create-workspace';
  const label = document.createElement('label');
  label.textContent = '工作区';
  const picker = document.createElement('select');
  picker.setAttribute('aria-label', '选择工作区');
  const inherited = document.createElement('option');
  inherited.value = 'board-default'; inherited.textContent = '使用看板默认工作区';
  const scratch = document.createElement('option');
  scratch.value = 'scratch'; scratch.textContent = '临时工作区（任务结束后清理）';
  picker.append(inherited, scratch);
  const note = document.createElement('p');
  note.textContent = '默认使用看板配置；如需其他项目，请从列表选择，无需手动输入路径。';
  workspace.append(label, picker, note);
  titleField.after(workspace);

  const native = nativeWorkspaceControls(form);
  const initialKind = native?.kind.value || 'scratch';
  const initialPath = native?.path?.value || '';
  picker.addEventListener('change', () => {
    if (!native) return;
    const choice = picker.value;
    if (choice === 'board-default') {
      setReactValue(native.kind, initialKind);
      if (native.path) setReactValue(native.path, initialPath);
      return;
    }
    if (choice === 'scratch') { setReactValue(native.kind, 'scratch'); return; }
    const project = projectMap.get(choice);
    if (!project?.primary_path) return;
    setReactValue(native.kind, 'worktree');
    // React may add the path input only after workspace kind changes.
    window.setTimeout(() => {
      const refreshed = nativeWorkspaceControls(form);
      if (refreshed?.path) setReactValue(refreshed.path, project.primary_path || '');
    }, 0);
  });
  const projectMap = new Map<string, Project>();
  void boardDefaultWorkspace().then(path => {
    if (path) inherited.textContent = `使用看板默认工作区（${path}）`;
  }).catch(() => undefined);
  void projects().then(rows => {
    for (const project of rows) {
      projectMap.set(project.id, project);
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name || project.slug || project.primary_path || project.id;
      picker.append(option);
    }
  }).catch(() => undefined);
  applyResolvedColors(form);
}

/** Reapply after the native React form mounts or re-renders. */
export function installKanbanCreateDialogBridge(): void {
  if ((window as any).__HERMES_WORKBENCH_CREATE_DIALOG_BRIDGE__) return;
  (window as any).__HERMES_WORKBENCH_CREATE_DIALOG_BRIDGE__ = true;
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      for (const form of Array.from(document.querySelectorAll('.hermes-kanban-create-dialog'))) installForm(form as HTMLElement);
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  // ThemeProvider writes CSS vars on <html style="…">; recolor any open form on switch.
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  refresh();
}
