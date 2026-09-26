/** Compact, read-only recent worker output for native Kanban cards. */

const WORKBENCH_API = '/api/plugins/workbench';
const ACTIVE_OUTPUT_STATES = new Set(['running', 'blocked', 'review']);
const LOG_TAIL_BYTES = 8192;
const POLL_INTERVAL_MS = 3000;
const EMPTY_RETRY_MS = 15000;
const MAX_INPUT_CHARS = 200_000;
const MAX_SUMMARY_LINES = 2;
const MAX_SUMMARY_LINE_CHARS = 180;
const MAX_TASKS_PER_REQUEST = 32;

const BOILERPLATE_PATTERNS = [
  /^Query:\s+work kanban task\b/i,
  /^Initializing agent\.\.\.$/i,
  /^[─━═\-]{8,}$/,
  /^Resume this session with:$/i,
  /^hermes\s+(?:-p\s+\S+\s+)?--resume\b/i,
  /^hermes\s+-c\s+["']?Work kanban task\b/i,
  /^(?:Session|Title|Duration|Messages):\s*/i,
  /^⚠\s*Deprecated\b/i,
  /^Move to config\.yaml instead:/i,
  /^Then remove the old entries from\b/i,
  /^┊\s*review diff\b/i,
  /^@@\s/,
  /^[+-]$/,
];

const cache = new Map<string, { summary: string; nextFetchAt: number }>();
let descriptorSequence = 0;

/** Remove terminal control strings in one linear pass and resolve backspaces. */
function stripTerminalControls(raw: string): string {
  const input = raw.slice(-MAX_INPUT_CHARS);
  const output: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const kind = input[index + 1] || '';
      if (kind === '[') {
        index += 2;
        while (index < input.length && !/[@-~]/.test(input[index])) index += 1;
      } else if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
        index += 2;
        while (index < input.length) {
          if (input.charCodeAt(index) === 0x07) break;
          if (input.charCodeAt(index) === 0x1b && input[index + 1] === '\\') {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (code === 0x08) {
      if (output.length && output[output.length - 1] !== '\n') output.pop();
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) output.push(input[index]);
  }
  return output.join('');
}

function terminalLines(raw: string): string[] {
  return stripTerminalControls(raw)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap(line => line.split('\r').slice(-1))
    .map(line => line.trim())
    .filter(Boolean);
}

function usefulWorkerLine(line: string): boolean {
  return !BOILERPLATE_PATTERNS.some(pattern => pattern.test(line));
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|_KEY))\s*=\s*[^\s"'`]+/gi, '$1=[REDACTED]')
    .replace(/(\b(?:token|secret|password|api[_-]?key|access[_-]?key)=)[^&\s"'`]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, value => {
      try {
        const url = new URL(value.replace(/[),.;]+$/, ''));
        return `${url.origin}/…`;
      } catch {
        return '[REDACTED_URL]';
      }
    });
}

function truncateSummary(text: string): string {
  const points = Array.from(text);
  return points.length > MAX_SUMMARY_LINE_CHARS
    ? `${points.slice(0, MAX_SUMMARY_LINE_CHARS - 1).join('').trimEnd()}…`
    : text;
}

function joinWrappedPanel(lines: string[]): string {
  let result = '';
  for (const line of lines) {
    if (!result) {
      result = line;
      continue;
    }
    const needsSpace = /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(line);
    result += `${needsSpace ? ' ' : ''}${line}`;
  }
  return result;
}

/** Convert a raw worker log tail into concise, redacted, terminal-safe text. */
export function extractRecentWorkerOutput(raw: string): string {
  const lines = terminalLines(raw);
  let panelStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/\b⚕\s*Hermes\b/i.test(lines[index])) {
      panelStart = index + 1;
      break;
    }
  }
  if (panelStart >= 0) {
    const panel: string[] = [];
    for (let index = panelStart; index < lines.length; index += 1) {
      if (/^(?:Resume this session with:|[─━═\-]{8,})$/i.test(lines[index])) break;
      if (usefulWorkerLine(lines[index])) panel.push(lines[index]);
    }
    const finalText = joinWrappedPanel(panel);
    if (finalText) return truncateSummary(redactSensitiveText(finalText));
  }

  const useful: string[] = [];
  for (const line of lines) {
    if (!usefulWorkerLine(line)) continue;
    const concise = truncateSummary(redactSensitiveText(line));
    if (useful[useful.length - 1] !== concise) useful.push(concise);
  }
  return useful.slice(-MAX_SUMMARY_LINES).join('\n');
}

function cardStatus(card: HTMLElement): string {
  return card.closest<HTMLElement>('[data-kanban-column]')?.dataset.kanbanColumn || '';
}

/** Mirror native Kanban selection, which deliberately differs from CLI current-board state. */
export function selectedKanbanBoard(): string {
  const explicit = new URLSearchParams(window.location.search).get('board')?.trim();
  if (explicit) return explicit;
  try {
    return (window.localStorage.getItem('hermes.kanban.selectedBoard') || '').trim();
  } catch {
    return '';
  }
}

function stateLabel(status: string): string {
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const labels: Record<string, [string, string]> = {
    triage: ['待分类', 'Triage'], todo: ['待办', 'Todo'], scheduled: ['已排期', 'Scheduled'],
    ready: ['就绪', 'Ready'], running: ['进行中', 'Running'], blocked: ['已阻塞', 'Blocked'],
    review: ['待审核', 'Review'], done: ['已完成', 'Done'],
  };
  const pair = labels[status] || [status, status];
  return pair[zh ? 0 : 1];
}

function cacheKey(board: string, taskId: string): string {
  return `${board}\u0000${taskId}`;
}

function syncCardDescriptions(card: HTMLElement, descriptors: HTMLElement[]): void {
  const previous = new Set((card.dataset.htiDescriptionIds || '').split(/\s+/).filter(Boolean));
  const preserved = (card.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && !previous.has(id));
  const ids = descriptors.map(element => element.id).filter(Boolean);
  const combined = [...preserved, ...ids];
  if (combined.length) card.setAttribute('aria-describedby', combined.join(' '));
  else card.removeAttribute('aria-describedby');
  card.dataset.htiDescriptionIds = ids.join(' ');
}

/** Apply idempotent card chrome. Visible status is colour-only; semantics stay accessible. */
export function applyKanbanCardActivity(card: HTMLElement, status: string, summary: string): void {
  card.dataset.htiKanbanState = status;
  const content = card.querySelector<HTMLElement>('.hermes-kanban-card-content');
  if (!content) return;
  let mark = content.querySelector<HTMLElement>('.hti-kanban-state-mark');
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'hti-kanban-state-mark';
    mark.setAttribute('role', 'img');
    mark.id = `hti-kanban-state-${++descriptorSequence}`;
    content.prepend(mark);
  }
  mark.setAttribute('aria-label', stateLabel(status));
  mark.setAttribute('title', stateLabel(status));

  let output = content.querySelector<HTMLElement>('.hti-kanban-recent-output');
  if (!ACTIVE_OUTPUT_STATES.has(status) || !summary) {
    output?.remove();
    syncCardDescriptions(card, [mark]);
    return;
  }
  if (!output) {
    output = document.createElement('pre');
    output.className = 'hti-kanban-recent-output';
    output.id = `hti-kanban-output-${++descriptorSequence}`;
    const meta = content.querySelector('.hermes-kanban-card-meta');
    content.insertBefore(output, meta);
  }
  if (output.textContent !== summary) output.textContent = summary;
  const label = document.documentElement.lang.toLowerCase().startsWith('zh') ? '最近输出' : 'Recent output';
  output.setAttribute('aria-label', `${label}: ${summary.replace(/\n/g, '；')}`);
  output.title = summary.replace(/\n/g, ' · ');
  syncCardDescriptions(card, [mark, output]);
}

/** Load bounded batches sequentially so no request is rejected and only one is in flight. */
export async function fetchKanbanTaskSummaries(taskIds: string[], board: string, request: typeof fetch = fetch): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  for (let offset = 0; offset < taskIds.length; offset += MAX_TASKS_PER_REQUEST) {
    const batch = taskIds.slice(offset, offset + MAX_TASKS_PER_REQUEST);
    try {
      const response = await request(`${WORKBENCH_API}/kanban-activity`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board, task_ids: batch, tail_bytes: LOG_TAIL_BYTES }),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (board && String(payload?.board || '') !== board) continue;
      for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const taskId = String(item?.task_id || '');
        if (batch.includes(taskId)) summaries.set(taskId, extractRecentWorkerOutput(String(item?.content || '')));
      }
    } catch {
      // A missing/older sidecar degrades to colour state instead of breaking the board.
    }
  }
  return summaries;
}

/** Load one card now. Inactive cards never issue worker-log requests. */
export async function loadKanbanCardActivity(card: HTMLElement, request: typeof fetch = fetch): Promise<void> {
  const status = cardStatus(card);
  const taskId = card.dataset.taskId || '';
  if (!taskId || !ACTIVE_OUTPUT_STATES.has(status)) {
    applyKanbanCardActivity(card, status, '');
    return;
  }
  const board = selectedKanbanBoard();
  const summary = (await fetchKanbanTaskSummaries([taskId], board, request)).get(taskId) || '';
  if (selectedKanbanBoard() !== board) return;
  applyKanbanCardActivity(card, cardStatus(card), summary);
}

function cardsForTask(taskId: string, board: string): HTMLElement[] {
  if (selectedKanbanBoard() !== board) return [];
  return Array.from(document.querySelectorAll<HTMLElement>('.hermes-kanban-card[data-task-id]')).filter(card => card.dataset.taskId === taskId);
}

/** Install one throttled poller; no xterm, PTY, per-card socket, or heartbeat prose. */
export function installKanbanCardActivity(): void {
  if ((window as any).__HERMES_WORKBENCH_KANBAN_CARD_ACTIVITY__) return;
  (window as any).__HERMES_WORKBENCH_KANBAN_CARD_ACTIVITY__ = true;
  let frame = 0;
  let timer = 0;
  let polling = false;
  let currentBoard = '';

  const poll = async () => {
    timer = 0;
    if (document.hidden || polling) return;
    if (!window.location.pathname.includes('kanban')) {
      scheduleTimer();
      return;
    }
    polling = true;
    try {
      const board = selectedKanbanBoard();
      if (board !== currentBoard) {
        cache.clear();
        currentBoard = board;
      }
      const now = Date.now();
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.hermes-kanban-card[data-task-id]'));
      const taskIds = new Set<string>();
      for (const card of cards) {
        const status = cardStatus(card);
        const taskId = card.dataset.taskId || '';
        const key = cacheKey(board, taskId);
        applyKanbanCardActivity(card, status, cache.get(key)?.summary || '');
        if (taskId && ACTIVE_OUTPUT_STATES.has(status) && (cache.get(key)?.nextFetchAt || 0) <= now) taskIds.add(taskId);
      }
      const summaries = await fetchKanbanTaskSummaries(Array.from(taskIds), board, fetch);
      if (selectedKanbanBoard() !== board) return;
      for (const taskId of taskIds) {
        const summary = summaries.get(taskId) || '';
        cache.set(cacheKey(board, taskId), { summary, nextFetchAt: Date.now() + (summary ? POLL_INTERVAL_MS : EMPTY_RETRY_MS) });
        for (const card of cardsForTask(taskId, board)) applyKanbanCardActivity(card, cardStatus(card), summary);
      }
    } finally {
      polling = false;
      scheduleTimer();
    }
  };

  const scheduleTimer = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };
  const scheduleFrame = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      void poll();
    });
  };
  new MutationObserver(scheduleFrame).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', scheduleFrame);
  window.addEventListener('popstate', scheduleFrame);
  scheduleFrame();
}
