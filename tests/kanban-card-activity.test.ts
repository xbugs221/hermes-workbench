// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyKanbanCardActivity,
  extractRecentWorkerOutput,
  fetchKanbanTaskSummaries,
  loadKanbanCardActivity,
  selectedKanbanBoard,
} from '../dashboard/src/kanban-card-activity';

function cardFixture(status = 'running', taskId = 't_abc'): HTMLElement {
  document.body.innerHTML = `
    <section data-kanban-column="${status}">
      <article class="hermes-kanban-card" data-task-id="${taskId}">
        <div class="hermes-kanban-card-content">
          <strong>Example task</strong>
          <div class="hermes-kanban-card-meta">agent</div>
        </div>
      </article>
    </section>`;
  return document.querySelector<HTMLElement>('.hermes-kanban-card')!;
}

describe('Kanban compact activity cards', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.lang = '';
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('extracts the last two useful lines and strips terminal noise', () => {
    const raw = [
      'Query: work kanban task t_abc',
      'Initializing agent...\r',
      '\u001b[33m⚠ Deprecated .env settings detected:\u001b[0m',
      '  ┊ 🔎 grep      activity  0.2s\r',
      '  ┊ ✍️  write     dashboard/src/card.ts  1.1s\r',
      'Resume this session with:',
      "hermes --resume 'session-id'",
      'Duration: 8m 22s',
    ].join('\n');

    expect(extractRecentWorkerOutput(raw)).toBe(
      '┊ 🔎 grep      activity  0.2s\n┊ ✍️  write     dashboard/src/card.ts  1.1s',
    );
  });

  it('uses the last carriage-return frame for in-place progress output', () => {
    expect(extractRecentWorkerOutput('Downloading 10%\rDownloading 95%')).toBe('Downloading 95%');
  });

  it('prefers the last Hermes panel, resolves controls, and redacts credentials', () => {
    const raw = [
      '\u001b[31mold activity\u001b[0m',
      '─ ⚕ Hermes ─────────────────────────',
      '旧结果',
      '────────────────────────────────────',
      '\u001bPprivate control\u001b\\noise',
      '─ ⚕ Hermes ─────────────────────────',
      '已发布到 https://example.test/share/credential?token=secret',
      'API_TOKEN=super-secret Authorization: Bearer abc.def.ghi',
      '────────────────────────────────────',
      'Resume this session with:',
    ].join('\n');

    const summary = extractRecentWorkerOutput(raw);
    expect(summary).toContain('https://example.test/…');
    expect(summary).toContain('API_TOKEN=[REDACTED]');
    expect(summary).toContain('Bearer [REDACTED]');
    expect(summary).not.toContain('credential');
    expect(summary).not.toContain('super-secret');
    expect(summary).not.toContain('旧结果');
  });

  it('resolves backspaces after stripping ANSI controls', () => {
    expect(extractRecentWorkerOutput('\u001b[32mvisible\u001b[0m\bX')).toBe('visiblX');
  });

  it('renders one colour state and one recent-output block without visible status prose', () => {
    document.documentElement.lang = 'zh-CN';
    const card = cardFixture();

    applyKanbanCardActivity(card, 'running', '最近一步\n正在测试');
    applyKanbanCardActivity(card, 'running', '最近一步\n正在测试');

    expect(card.dataset.htiKanbanState).toBe('running');
    expect(card.querySelectorAll('.hti-kanban-state-mark')).toHaveLength(1);
    expect(card.querySelector('.hti-kanban-state-mark')?.getAttribute('aria-label')).toBe('进行中');
    expect(card.querySelectorAll('.hti-kanban-recent-output')).toHaveLength(1);
    expect(card.querySelector('.hti-kanban-recent-output')?.textContent).toBe('最近一步\n正在测试');
    expect(card.querySelector('.hti-kanban-recent-output')?.getAttribute('aria-label')).toBe(
      '最近输出: 最近一步；正在测试',
    );
    expect(card.getAttribute('aria-describedby')?.split(' ')).toHaveLength(2);
    expect(card.textContent).not.toContain('响应中');
    expect(card.textContent).not.toMatch(/心跳.*前/);
  });

  it('loads active logs through one aggregate request and preserves the board scope', async () => {
    window.history.replaceState({}, '', '/kanban?board=digital-hub');
    const active = cardFixture('running');
    const requestMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      board: 'digital-hub',
      items: [{ task_id: 't_abc', content: 'first\nlatest' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = requestMock as unknown as typeof fetch;

    await loadKanbanCardActivity(active, request);

    expect(requestMock).toHaveBeenCalledOnce();
    expect(String(requestMock.mock.calls[0][0])).toBe('/api/plugins/workbench/kanban-activity');
    expect(JSON.parse(String(requestMock.mock.calls[0][1]?.body))).toEqual({
      board: 'digital-hub',
      task_ids: ['t_abc'],
      tail_bytes: 8192,
    });
    expect(active.querySelector('.hti-kanban-recent-output')?.textContent).toBe('first\nlatest');

    const idle = cardFixture('todo', 't_idle');
    await loadKanbanCardActivity(idle, request);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(idle.querySelector('.hti-kanban-recent-output')).toBeNull();
  });

  it('uses the native persisted board when the route has no explicit board', () => {
    window.history.replaceState({}, '', '/kanban');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: vi.fn(() => 'digital-hub') },
    });
    expect(selectedKanbanBoard()).toBe('digital-hub');

    window.history.replaceState({}, '', '/kanban?board=explicit');
    expect(selectedKanbanBoard()).toBe('explicit');
  });

  it('splits more than 32 cards into bounded sequential aggregate requests', async () => {
    const taskIds = Array.from({ length: 33 }, (_, index) => `t_${index}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const requestMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = JSON.parse(String(init?.body));
      await Promise.resolve();
      inFlight -= 1;
      return new Response(JSON.stringify({
        board: 'digital-hub',
        items: body.task_ids.map((taskId: string) => ({ task_id: taskId, content: `output ${taskId}` })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const summaries = await fetchKanbanTaskSummaries(
      taskIds,
      'digital-hub',
      requestMock as unknown as typeof fetch,
    );

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(requestMock.mock.calls[0][1]?.body)).task_ids).toHaveLength(32);
    expect(JSON.parse(String(requestMock.mock.calls[1][1]?.body)).task_ids).toHaveLength(1);
    expect(maxInFlight).toBe(1);
    expect(summaries.size).toBe(33);
  });

  it('discards a response after the native board changes', async () => {
    window.history.replaceState({}, '', '/kanban');
    let selected = 'board-a';
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: vi.fn(() => selected) },
    });
    const card = cardFixture('running', 't_shared');
    const request = vi.fn(async () => {
      selected = 'board-b';
      return new Response(JSON.stringify({
        board: 'board-a',
        items: [{ task_id: 't_shared', content: 'wrong board output' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    await loadKanbanCardActivity(card, request);

    expect(card.querySelector('.hti-kanban-recent-output')).toBeNull();
  });
});
