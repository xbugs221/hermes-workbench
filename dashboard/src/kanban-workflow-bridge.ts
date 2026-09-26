import { loadKanbanProfiles, populateKanbanAgentSelect } from './kanban-agent-picker';
/** Progressive disclosure and direct handoff actions for the native Kanban drawer. */
import { listKanbanSessions } from './kanban-session-api';
import { drawerConversationPath } from './kanban-session-bridge';

const KANBAN_API = '/api/plugins/kanban';
export const STATUS_ACTIONS: Record<string, { label: string; title: string }> = {
  '→ triage': { label: '移至：待分类', title: '退回待分类，重新澄清任务' },
  '→ ready': { label: '确认执行 → 就绪', title: '任务会等待指定执行 Agent；已分配后由调度器处理' },
  Block: { label: '暂停 / 等待反馈', title: '暂停任务，等待人工补充或决策' },
  Unblock: { label: '解除阻塞 → 就绪', title: '解除等待状态；需指定执行 Agent 才会自动处理' },
  Complete: { label: '标记完成', title: '确认交付完成，并解锁依赖它的后续任务' },
  Archive: { label: '归档', title: '不再处理，但保留历史记录' },
  '✨ Specify': { label: '生成任务草案', title: '让模型将待分类想法整理为任务说明' },
  '⚗ Decompose': { label: '拆分任务', title: '让模型生成可独立执行的子任务图' },
};

function boardFromLocation(): string {
  return new URLSearchParams(window.location.search).get('board') || window.localStorage.getItem('hermes.kanban.selectedBoard') || '';
}

function api(path: string): string {
  const board = boardFromLocation();
  return board ? `${KANBAN_API}${path}${path.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}` : `${KANBAN_API}${path}`;
}

/** Kanban JSON APIs must use the host JSON client so both auth modes work. */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const sdk = (window as any).__HERMES_PLUGIN_SDK__;
  if (typeof sdk?.fetchJSON === 'function') return sdk.fetchJSON(url, init);
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function installedProfiles(): Promise<string[]> {
  return loadKanbanProfiles(fetchJson, api('/profiles'));
}

function labelledControl(labelText: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'hti-kanban-control-field';
  const label = document.createElement('span');
  label.textContent = labelText;
  wrapper.append(label, control);
  return wrapper;
}

/** First-row handoff: choose Agent, then talk or assign directly. */
function installDrawerExecutionControl(drawer: HTMLElement, actions: HTMLElement): void {
  const taskId = drawer.querySelector('.hermes-kanban-drawer-head span')?.textContent?.trim() || '';
  if (!taskId || drawer.querySelector('.hti-kanban-execution-control')) return;

  const control = document.createElement('section');
  control.className = 'hti-kanban-execution-control hti-kanban-primary';
  control.setAttribute('aria-label', '任务执行');

  const agentSelect = document.createElement('select');
  agentSelect.setAttribute('aria-label', '选择执行 Agent');
  const defaultOption = document.createElement('option');
  defaultOption.value = 'default';
  defaultOption.textContent = 'default（默认 Agent）';
  agentSelect.appendChild(defaultOption);

  const conversationButton = document.createElement('button');
  conversationButton.type = 'button';
  conversationButton.className = 'hti-kanban-action hti-kanban-conversation-action';
  conversationButton.textContent = '对话';
  conversationButton.title = '打开与所选 Agent 的交互会话；不会派发任务或改变卡片状态';
  conversationButton.addEventListener('click', async () => {
    const assignee = agentSelect.value || 'default';
    conversationButton.disabled = true;
    conversationButton.textContent = '打开中…';
    try {
      const links = await listKanbanSessions(taskId, boardFromLocation());
      window.location.assign(drawerConversationPath(taskId, boardFromLocation(), assignee, links));
    } catch (error) {
      conversationButton.disabled = false;
      conversationButton.textContent = '对话';
      conversationButton.title = String(error instanceof Error ? error.message : error);
    }
  });

  const assignButton = document.createElement('button');
  assignButton.type = 'button';
  assignButton.className = 'hti-kanban-action hti-kanban-assign-action';
  assignButton.textContent = '指派';
  assignButton.title = '把卡片交给所选 Agent，转为就绪并触发后台调度';
  assignButton.addEventListener('click', async () => {
    const assignee = agentSelect.value || 'default';
    assignButton.disabled = true;
    assignButton.textContent = '指派中…';
    try {
      await fetchJson(api(`/tasks/${encodeURIComponent(taskId)}`), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee, status: 'ready' }),
      });
      await fetchJson(api('/dispatch'), { method: 'POST' });
      window.location.reload();
    } catch (error) {
      assignButton.disabled = false;
      assignButton.textContent = '指派';
      assignButton.title = String(error instanceof Error ? error.message : error);
    }
  });

  control.append(
    labelledControl('执行 Agent', agentSelect),
    conversationButton,
    assignButton,
  );
  // StatusActions wraps `.hermes-kanban-actions` in an anonymous div. Inserting
  // beside `actions` makes the control inherit that wrapper's secondary state
  // and disappear with it. Keep the handoff as a direct drawer-body child.
  const drawerBody = drawer.querySelector('.hermes-kanban-drawer-body');
  drawerBody?.insertBefore(control, drawerBody.firstChild);

  void populateKanbanAgentSelect(agentSelect, [conversationButton, assignButton], control, installedProfiles);
}

const PRIMARY_SECTION_LABELS: Array<{ matches: string[]; label: string; classNames: string[] }> = [
  { matches: ['说明', 'Description', '理解后的需求'], label: '理解后的需求', classNames: ['hti-kanban-understood'] },
  { matches: ['最终结果', 'Final Result', '结果', 'Result', '最终回复'], label: '最终回复', classNames: ['hti-kanban-deliverable', 'hti-kanban-reply'] },
  { matches: ['子任务结果', 'Child Results', '子任务产出'], label: '子任务产出', classNames: ['hti-kanban-deliverable', 'hti-kanban-reply'] },
  { matches: ['附件', 'Attachments', '产物附件'], label: '附件', classNames: ['hti-kanban-deliverable', 'hti-kanban-attachments'] },
];

function normalizedHeading(section: Element): HTMLElement | null {
  const directHead = Array.from(section.children).find(child => child.classList.contains('hermes-kanban-section-head'));
  if (directHead) return directHead as HTMLElement;
  const headRow = Array.from(section.children).find(child => child.classList.contains('hermes-kanban-section-head-row'));
  return (headRow?.querySelector('.hermes-kanban-section-head') || null) as HTMLElement | null;
}

function matchesHeading(text: string, candidate: string): boolean {
  return text === candidate || text.startsWith(`${candidate} (`);
}

/** Mark native React-owned nodes instead of moving them, so re-renders stay safe. */
export function classifyDrawerSections(drawer: HTMLElement): void {
  const body = drawer.querySelector('.hermes-kanban-drawer-body') as HTMLElement | null;
  if (!body) return;
  body.classList.add('hti-kanban-prioritized-body');

  const title = (Array.from(body.children).find(child => child.classList.contains('hermes-kanban-drawer-title')) || null) as HTMLElement | null;
  if (title) {
    title.classList.remove('hti-kanban-secondary');
    title.classList.add('hti-kanban-user-request', 'hti-kanban-primary');
  }

  for (const child of Array.from(body.children) as HTMLElement[]) {
    if (child.classList.contains('hti-kanban-execution-control') || child.classList.contains('hti-kanban-secondary-menu') || child.classList.contains('hti-kanban-core-placeholder')) {
      child.classList.remove('hti-kanban-secondary');
      child.classList.add('hti-kanban-primary');
      continue;
    }
    const heading = normalizedHeading(child);
    const headingText = heading?.textContent?.trim() || '';
    const primary = PRIMARY_SECTION_LABELS.find(item => item.matches.some(candidate => matchesHeading(headingText, candidate)));
    if (primary) {
      child.classList.remove('hti-kanban-secondary');
      child.classList.add('hti-kanban-primary', ...primary.classNames);
      if (heading) {
        const suffix = headingText.match(/\s*\(\d+\)\s*$/)?.[0] || '';
        heading.textContent = `${primary.label}${suffix}`;
      }
    } else if (!child.classList.contains('hti-kanban-user-request')) {
      child.classList.add('hti-kanban-secondary');
    }
  }

  if (!body.querySelector('.hti-kanban-understood')) {
    const understood = document.createElement('section');
    understood.className = 'hermes-kanban-section hti-kanban-primary hti-kanban-understood hti-kanban-core-placeholder';
    understood.innerHTML = '<div class="hermes-kanban-section-head">理解后的需求</div><div class="text-xs text-muted-foreground">尚未整理；可在“更多信息与操作”中编辑说明或生成任务草案。</div>';
    body.appendChild(understood);
  }

  const hasFinalReply = Array.from(body.children).some(child => {
    const heading = normalizedHeading(child)?.textContent?.trim() || '';
    return matchesHeading(heading, '最终回复');
  });
  const replyPlaceholder = body.querySelector('.hti-kanban-reply-placeholder');
  if (hasFinalReply) {
    replyPlaceholder?.remove();
  } else if (!replyPlaceholder) {
    const reply = document.createElement('section');
    reply.className = 'hermes-kanban-section hti-kanban-primary hti-kanban-deliverable hti-kanban-reply hti-kanban-core-placeholder hti-kanban-reply-placeholder';
    reply.innerHTML = '<div class="hermes-kanban-section-head">回复</div><div class="text-xs text-muted-foreground">任务完成后，回复会显示在这里。</div>';
    body.appendChild(reply);
  }

  if (!Array.from(body.children).some(child => child.classList.contains('hti-kanban-secondary-menu'))) {
    const details = document.createElement('details');
    details.className = 'hti-kanban-secondary-menu hti-kanban-primary';
    const summary = document.createElement('summary');
    summary.textContent = '更多信息与操作';
    const hint = document.createElement('span');
    hint.textContent = '状态、属性、通知、依赖、评论历史与运行记录';
    details.append(summary, hint);
    details.addEventListener('toggle', () => {
      body.classList.toggle('hti-kanban-secondary-open', details.open);
      drawer.classList.toggle('hti-kanban-secondary-open', details.open);
    });
    body.appendChild(details);
  }

  const footer = drawer.querySelector('.hermes-kanban-drawer-comment-foot') as HTMLElement | null;
  // “添加备注”输入条是抽屉底部常驻的一级操作：原生位置在可滚动正文之下、随
  // drawer flex 贴底。只把评论历史等二级信息收进折叠菜单，绝不折叠撰写入口。
  footer?.classList.remove('hti-kanban-secondary');
}

function localizeStatusActions(): void {
  for (const actions of Array.from(document.querySelectorAll('.hermes-kanban-actions'))) {
    const drawer = actions.closest('.hermes-kanban-drawer') as HTMLElement | null;
    if (drawer) {
      installDrawerExecutionControl(drawer, actions as HTMLElement);
      classifyDrawerSections(drawer);
    }
    // The old workflow recommendation is intentionally removed: users move cards directly on the board.
    actions.parentElement?.querySelector('.hti-kanban-workflow-hint')?.remove();
    for (const button of Array.from(actions.querySelectorAll('button'))) {
      const raw = button.textContent?.trim() || '';
      const translated = STATUS_ACTIONS[raw];
      if (!translated) continue;
      button.textContent = translated.label;
      button.title = translated.title;
      button.setAttribute('aria-label', translated.label);
    }
  }
}

async function refreshReadyGuide(): Promise<void> {
  document.querySelector('.hti-kanban-ready-guide')?.remove();
}

/** Keep the compatibility layer alive across native Kanban React re-renders. */
export function installKanbanWorkflowBridge(): void {
  if ((window as any).__HERMES_WORKBENCH_KANBAN_WORKFLOW__) return;
  (window as any).__HERMES_WORKBENCH_KANBAN_WORKFLOW__ = true;
  let queued = false;
  let lastGuideAt = 0;
  const refresh = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      localizeStatusActions();
      for (const drawer of Array.from(document.querySelectorAll('.hermes-kanban-drawer'))) {
        classifyDrawerSections(drawer as HTMLElement);
      }
      if (Date.now() - lastGuideAt < 2_000) return;
      lastGuideAt = Date.now();
      void refreshReadyGuide().catch(() => undefined);
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', refresh);
  refresh();
}
