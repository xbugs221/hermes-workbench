/** Read-only Cron run history rendered inside the owning native job card. */

export type CronJobSummary = {
  id?: unknown;
  name?: unknown;
  prompt?: unknown;
  script?: unknown;
  profile?: unknown;
  profile_name?: unknown;
};

export type CronRunSummary = {
  id?: unknown;
  session_id?: unknown;
  title?: unknown;
  started_at?: unknown;
  last_active?: unknown;
  ended_at?: unknown;
  end_reason?: unknown;
};

type RunsResponse = { runs?: CronRunSummary[] };

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function cronJobTitle(job: CronJobSummary): string {
  return text(job.name) || truncate(text(job.prompt), 60) || truncate(text(job.script), 60) || text(job.id) || 'Cron job';
}

export function cronJobProfile(job: CronJobSummary): string {
  return text(job.profile) || text(job.profile_name) || 'default';
}

export function cronRunSessionId(run: CronRunSummary): string {
  return text(run.id) || text(run.session_id);
}

export function cronRunHref(profile: string, sessionId: string): string {
  const params = new URLSearchParams({ profile, session: sessionId });
  return `/chat?${params.toString()}`;
}

export function cronRunTime(run: CronRunSummary, locale?: string): string {
  const raw = run.last_active ?? run.ended_at ?? run.started_at;
  const numeric = typeof raw === 'number' && raw < 1_000_000_000_000 ? raw * 1000 : raw;
  const date = new Date(numeric as any);
  return Number.isFinite(date.getTime()) && date.getTime() > 0
    ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
}

export async function loadCronJobs(fetcher: typeof fetch = fetch): Promise<CronJobSummary[]> {
  const response = await fetcher('/api/cron/jobs?profile=all', { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Unable to load scheduled tasks (${response.status})`);
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}

export async function loadCronRuns(
  jobId: string,
  profile: string,
  fetcher: typeof fetch = fetch,
): Promise<CronRunSummary[]> {
  const params = new URLSearchParams({ profile, limit: '100' });
  const response = await fetcher(`/api/cron/jobs/${encodeURIComponent(jobId)}/runs?${params.toString()}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Unable to load run history (${response.status})`);
  const value = await response.json() as RunsResponse;
  return Array.isArray(value.runs) ? value.runs : [];
}

function chinese(): boolean {
  return document.documentElement.lang.toLowerCase().startsWith('zh');
}

function renderRuns(container: HTMLElement, runs: CronRunSummary[], profile: string): void {
  container.replaceChildren();
  if (!runs.length) {
    const empty = document.createElement('p');
    empty.dataset.htiCronRunsEmpty = 'true';
    empty.textContent = chinese() ? '暂无会话记录' : 'No session records';
    container.append(empty);
    return;
  }
  const list = document.createElement('ol');
  list.dataset.htiCronRunsList = 'true';
  for (const run of runs) {
    const sessionId = cronRunSessionId(run);
    if (!sessionId) continue;
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = cronRunHref(profile, sessionId);
    link.dataset.htiCronRunLink = 'true';
    const label = text(run.title) || sessionId;
    const title = document.createElement('span');
    title.textContent = label;
    const time = document.createElement('time');
    time.textContent = cronRunTime(run, document.documentElement.lang || undefined);
    link.append(title, time);
    item.append(link);
    list.append(item);
  }
  container.append(list);
}

/** Add one lazy, idempotent run-history disclosure to an already enhanced card. */
export function attachCronRunHistory(
  card: HTMLElement,
  job: CronJobSummary,
  loadRuns: (jobId: string, profile: string) => Promise<CronRunSummary[]> = loadCronRuns,
): void {
  const jobId = text(job.id);
  if (!jobId) return;
  const profile = cronJobProfile(job);
  card.dataset.htiCronJobId = jobId;
  card.dataset.htiCronProfile = profile;
  if (card.querySelector('[data-hti-cron-runs="true"]')) return;

  const body = card.querySelector<HTMLElement>('[data-hti-cron-card-body="true"]');
  const actions = card.querySelector<HTMLElement>('[data-hti-cron-actions="true"]');
  if (!body || !actions) return;

  const details = document.createElement('details');
  details.dataset.htiCronRuns = 'true';
  const summary = document.createElement('summary');
  summary.textContent = chinese() ? '运行记录' : 'Run history';
  summary.setAttribute('aria-label', chinese() ? `查看${cronJobTitle(job)}的运行记录` : `View run history for ${cronJobTitle(job)}`);
  const content = document.createElement('div');
  content.dataset.htiCronRunsContent = 'true';
  details.append(summary, content);
  body.insertBefore(details, actions);

  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.htiCronRunsLoaded === 'true' || details.dataset.htiCronRunsLoading === 'true') return;
    details.dataset.htiCronRunsLoading = 'true';
    content.textContent = chinese() ? '加载中…' : 'Loading…';
    void loadRuns(jobId, profile)
      .then(runs => {
        if (!details.isConnected) return;
        renderRuns(content, runs, profile);
        details.dataset.htiCronRunsLoaded = 'true';
      })
      .catch(reason => {
        if (!details.isConnected) return;
        content.textContent = `${chinese() ? '记录加载失败' : 'Could not load history'}: ${String(reason)}`;
      })
      .finally(() => { delete details.dataset.htiCronRunsLoading; });
  });
}

/** Match visible native cards to their jobs without depending on private React state or DOM-only IDs. */
export function attachCronHistories(
  cards: HTMLElement[],
  jobs: CronJobSummary[],
  loadRuns?: (jobId: string, profile: string) => Promise<CronRunSummary[]>,
): void {
  const remaining = [...jobs];
  for (const card of cards) {
    if (card.dataset.htiCronJobId) continue;
    const title = card.querySelector<HTMLElement>('[data-hti-cron-title="true"]')?.textContent?.trim() || '';
    const badges = Array.from(card.querySelectorAll<HTMLElement>('[data-hti-cron-auxiliary="true"]'))
      .map(node => node.textContent?.trim() || '');
    let index = remaining.findIndex(job => cronJobTitle(job) === title && badges.includes(cronJobProfile(job)));
    if (index < 0) index = remaining.findIndex(job => cronJobTitle(job) === title);
    if (index < 0) continue;
    const [job] = remaining.splice(index, 1);
    attachCronRunHistory(card, job, loadRuns);
  }
}
