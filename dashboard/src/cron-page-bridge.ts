/** Redesign native Cron cards without replacing their React behavior. */

import {
  attachCronHistories,
  loadCronJobs,
  loadCronRuns,
  type CronJobSummary,
} from './cron-run-history';

function normalizedText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function cronState(text: string): 'active' | 'paused' | 'error' | 'inactive' {
  if (/paused|暂停/i.test(text)) return 'paused';
  if (/error|failed|异常|错误|失败/i.test(text)) return 'error';
  if (/completed|disabled|finished|已完成|已结束|已禁用/i.test(text)) return 'inactive';
  return 'active';
}

function actionLabels(rawLabel: string, index: number): { kind: string; visible: string } {
  const chinese = document.documentElement.lang.toLowerCase().startsWith('zh');
  if (index === 0) {
    const resume = /resume|恢复|继续/i.test(rawLabel);
    return { kind: 'toggle', visible: resume ? (chinese ? '恢复' : 'Resume') : (chinese ? '暂停' : 'Pause') };
  }
  if (index === 1) return { kind: 'run', visible: chinese ? '立即运行' : 'Run now' };
  if (index === 2) return { kind: 'edit', visible: chinese ? '编辑' : 'Edit' };
  return { kind: 'delete', visible: chinese ? '删除任务' : 'Delete job' };
}

function addVisibleActionLabel(button: HTMLButtonElement, label: string): void {
  let text = button.querySelector<HTMLElement>('[data-hti-cron-action-text="true"]');
  if (!text) {
    text = document.createElement('span');
    text.dataset.htiCronActionText = 'true';
    button.append(text);
  }
  text.textContent = label;
}

function addMoreMenu(actions: HTMLElement, nativeDelete: HTMLButtonElement, deleteLabel: string): void {
  nativeDelete.dataset.htiCronNativeDelete = 'true';
  if (actions.querySelector('[data-hti-cron-more="true"]')) return;

  const menu = document.createElement('details');
  menu.dataset.htiCronMore = 'true';
  const trigger = document.createElement('summary');
  trigger.textContent = '⋯';
  trigger.setAttribute('aria-label', document.documentElement.lang.toLowerCase().startsWith('zh') ? '更多操作' : 'More actions');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = deleteLabel;
  remove.addEventListener('click', () => {
    menu.open = false;
    nativeDelete.click();
  });
  menu.append(trigger, remove);
  actions.append(menu);
}

/** Mark and reshape one native job card with stable semantic hooks. */
export function enhanceCronJobCard(card: HTMLElement): void {
  const body = card.firstElementChild as HTMLElement | null;
  if (!body) return;
  const main = body.firstElementChild as HTMLElement | null;
  const actions = body.lastElementChild as HTMLElement | null;
  const titleRow = main?.firstElementChild as HTMLElement | null;
  const buttons = actions
    ? Array.from(actions.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
      .filter((button) => button.parentElement === actions)
    : [];
  if (!main || !titleRow || !actions || buttons.length < 4) return;

  card.dataset.htiCronCard = 'true';
  body.dataset.htiCronCardBody = 'true';
  main.dataset.htiCronCardMain = 'true';
  titleRow.dataset.htiCronTitleRow = 'true';
  actions.dataset.htiCronActions = 'true';

  const title = titleRow.firstElementChild as HTMLElement | null;
  if (title) title.dataset.htiCronTitle = 'true';

  Array.from(titleRow.children).slice(1).forEach((badge, index) => {
    const element = badge as HTMLElement;
    if (index === 0) {
      const label = normalizedText(element);
      element.dataset.htiCronStatus = cronState(label);
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', label);
      element.title = label;
      return;
    }
    // Profile/default, model, execution mode, skills and toolsets belong in Edit.
    element.dataset.htiCronAuxiliary = 'true';
  });
  const status = titleRow.querySelector<HTMLElement>('[data-hti-cron-status]');
  if (status && main.querySelector('.text-destructive')) {
    status.dataset.htiCronStatus = 'error';
  }

  const metadata = Array.from(main.children).find((child) => {
    const text = normalizedText(child);
    return /repeat:|上次:|下次:|last:|next:/i.test(text);
  }) as HTMLElement | undefined;
  if (metadata) {
    metadata.dataset.htiCronMetadata = 'true';
    Array.from(metadata.children).forEach((item, index) => {
      const element = item as HTMLElement;
      element.dataset.htiCronMeta = String(index);
      if (/^repeat:/i.test(normalizedText(element)) || /^(上次|last):/i.test(normalizedText(element))) {
        element.dataset.htiCronAuxiliary = 'true';
      }
    });

    // An explicit-name card otherwise repeats its prompt between title and timing.
    const metadataIndex = Array.from(main.children).indexOf(metadata);
    Array.from(main.children).slice(1, metadataIndex).forEach((element) => {
      (element as HTMLElement).dataset.htiCronAuxiliary = 'true';
    });
  }

  buttons.slice(0, 3).forEach((button, index) => {
    const label = actionLabels(button.getAttribute('aria-label') || '', index);
    button.dataset.htiCronAction = label.kind;
    addVisibleActionLabel(button, label.visible);
  });
  const nativeDelete = buttons[3];
  const deleteLabel = actionLabels(nativeDelete.getAttribute('aria-label') || '', 3);
  addMoreMenu(actions, nativeDelete, deleteLabel.visible);
}

/** Find the current native Cron list and enhance only its cards. */
export function cronCards(root: ParentNode = document): HTMLElement[] {
  const filter = root.querySelector<HTMLElement>('#cron-profile-filter')
    || document.querySelector<HTMLElement>('#cron-profile-filter');
  if (!filter) return [];
  let list: HTMLElement | null = filter.parentElement;
  while (list && !Array.from(list.children).some((child) => (
    child.querySelectorAll?.('button[aria-label]').length >= 4
  ))) {
    list = list.parentElement;
  }
  if (!list) return [];
  const cards = Array.from(list.children)
    .filter(child => child.querySelectorAll?.('button[aria-label]').length >= 4) as HTMLElement[];
  cards.forEach(enhanceCronJobCard);
  return cards;
}

export function enhanceCronPage(root: ParentNode = document): void {
  cronCards(root);
}

/** Reapply hooks after native React replaces or updates the page. */
export function installCronPageBridge(): void {
  if ((window as any).__HERMES_WORKBENCH_CRON_PAGE_BRIDGE__) return;
  (window as any).__HERMES_WORKBENCH_CRON_PAGE_BRIDGE__ = true;
  let queued = false;
  let catalog: CronJobSummary[] | null = null;
  let catalogRequest: Promise<CronJobSummary[]> | null = null;
  let generation = 0;
  const refresh = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      const cards = cronCards();
      if (!cards.length) return;
      if (catalog) {
        attachCronHistories(cards, catalog, loadCronRuns);
        if (cards.every(card => Boolean(card.dataset.htiCronJobId))) return;
        // A newly-created job is not in the cached catalog. Refresh immediately
        // rather than leaving its history undiscoverable until page reload.
        catalog = null;
      }
      if (catalogRequest) return;
      const requestGeneration = ++generation;
      catalogRequest = loadCronJobs();
      void catalogRequest.then(jobs => {
        if (requestGeneration !== generation) return;
        catalog = jobs;
        attachCronHistories(cronCards(), jobs, loadCronRuns);
      }).catch(() => {
        // Native job actions remain usable; a later React refresh retries the read-only catalog.
      }).finally(() => { catalogRequest = null; });
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
}
