/** Collapse the native Cron advanced section on each newly mounted form. */
export function collapseAdvancedFields(dialog: HTMLElement): void {
  for (const details of Array.from(dialog.querySelectorAll<HTMLDetailsElement>('details'))) {
    const summary = details.querySelector('summary');
    if (!/^advanced fields$/i.test(summary?.textContent?.trim() || '')) continue;
    if (details.dataset.htiCronAdvancedInitialized === 'true') continue;
    details.dataset.htiCronAdvancedInitialized = 'true';
    details.open = false;
  }
}

/** Put the native close control in the dialog header's normal flow.
 *
 * The host renders this button before the header and positions it absolutely.
 * On mobile that creates a separate hit-testing layer below the Dashboard bar.
 * Moving the existing node preserves its React click handler while removing the
 * overlap instead of trying to win it with a larger z-index.
 */
export function normalizeCronDialogLayout(dialog: HTMLElement): void {
  const panel = dialog.firstElementChild as HTMLElement | null;
  if (!panel) return;

  const header = Array.from(panel.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'HEADER',
  );
  const closeButton = Array.from(panel.children).find(
    (child): child is HTMLButtonElement => child instanceof HTMLButtonElement,
  );
  if (!header || !closeButton) return;

  closeButton.dataset.htiCronDialogClose = 'true';
  if (closeButton.parentElement !== header) header.append(closeButton);
  panel.dataset.htiCronDialogPanel = 'true';
}

/** Reapply after the native React Cron dialog mounts or is replaced. */
export function installCronEditDialogBridge(): void {
  if ((window as any).__HERMES_WORKBENCH_CRON_EDIT_DIALOG_BRIDGE__) return;
  (window as any).__HERMES_WORKBENCH_CRON_EDIT_DIALOG_BRIDGE__ = true;
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      for (const dialog of Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-labelledby="create-cron-title"], '
        + '[role="dialog"][aria-labelledby="edit-cron-title"]',
      ))) {
        normalizeCronDialogLayout(dialog);
        collapseAdvancedFields(dialog);
      }
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
}
