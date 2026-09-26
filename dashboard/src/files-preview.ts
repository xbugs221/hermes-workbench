import { openFilePreview } from './file-preview';
import { uiText } from './ui-locale';

type ManagedRead = { name: string; mime_type?: string; data_url: string };
type ClickLike = Pick<MouseEvent, 'target' | 'preventDefault' | 'stopPropagation' | 'stopImmediatePropagation'>;

const FILES_PATH = '/files';

function isFilesRoute(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === FILES_PATH;
}

/** Read the exact active directory exposed by the native Files upload target. */
export function visibleManagedPath(root: ParentNode = document): string {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Path"]');
  if (input?.value.trim()) return input.value.trim();
  const target = root.querySelector<HTMLElement>('button[aria-label="Upload files"] [title]')
    || root.querySelector<HTMLElement>('button[aria-label="上传文件"] [title]');
  return target?.getAttribute('title')?.trim() || '';
}

function joinManagedPath(base: string, name: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${name}` : `${base}${separator}${name}`;
}

/**
 * Resolve a native filename button to its managed path using only the current DOM.
 * The right-hand Download action is the file/directory discriminator.
 */
export function managedFileClickPath(button: HTMLButtonElement, root: ParentNode = document): string {
  const name = button.querySelector<HTMLElement>('span.truncate')?.textContent?.trim() || '';
  const row = button.closest<HTMLElement>('div.grid');
  const path = visibleManagedPath(root);
  if (!name || !row || !path) return '';
  const labels = Array.from(row.querySelectorAll<HTMLElement>('button[aria-label]'))
    .map(action => action.getAttribute('aria-label')?.trim() || '');
  const hasDownloadAction = labels.some(label => /^download\s/i.test(label) || /^下载(?:\s|：|:)/.test(label));
  return hasDownloadAction ? joinManagedPath(path, name) : '';
}

/** Synchronously stop React's filename-download handler before any async preview work. */
export function interceptManagedFileClick(event: ClickLike, root: ParentNode = document): string {
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  const button = target?.closest?.('button') as HTMLButtonElement | null;
  if (!button) return '';
  const path = managedFileClickPath(button, root);
  if (!path) return '';
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  return path;
}

/** Native Files always renders '..' before entries; discard rows React left above it after navigation. */
export function removeRowsBeforeParent(root: ParentNode = document): number {
  const parent = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.trim() === '..');
  // The host renders '..' as the row button itself. Using parentElement here
  // selected the entire table body, so stale rows from the previous directory
  // (for example skill-library) were never removed.
  const parentRow = parent;
  if (!parentRow) return 0;
  let removed = 0;
  let sibling = parentRow.previousElementSibling;
  while (sibling) {
    const previous = sibling.previousElementSibling;
    if (!sibling.matches('div.grid') || !sibling.querySelector('button')) break;
    sibling.remove();
    removed += 1;
    sibling = previous;
  }
  return removed;
}

/** Read through the server's existing file policy; timeout includes response bodies. */
export async function readManagedFile(path: string): Promise<{ name: string; blob: Blob; mime: string }> {
  const sdk = (window as any).__HERMES_PLUGIN_SDK__;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const url = `/api/files/read?path=${encodeURIComponent(path)}`;
    const response = sdk?.authedFetch
      ? await sdk.authedFetch(url, { signal: controller.signal })
      : await fetch(url, { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) {
      const reason = ({ 401: '登录已失效', 403: '没有读取权限', 404: '文件不存在', 413: '文件过大' } as Record<number, string>)[response.status];
      throw new Error(reason || uiText(`文件读取失败（${response.status}）`, `Could not read file (${response.status})`));
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(uiText('文件接口未返回有效数据', 'Invalid file API response'));
    const payload = await response.json() as ManagedRead;
    if (typeof payload.name !== 'string' || typeof payload.data_url !== 'string' || !/^data:[^,]*;base64,/i.test(payload.data_url)) {
      throw new Error(uiText('文件内容无效', 'Invalid file content'));
    }
    const blobResponse = await fetch(payload.data_url, { signal: controller.signal });
    if (!blobResponse.ok) throw new Error(uiText('文件内容解码失败', 'Could not decode file content'));
    return { name: payload.name, blob: await blobResponse.blob(), mime: payload.mime_type || '' };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(uiText('文件读取超时，请重试', 'File read timed out. Please retry.'));
    throw error;
  } finally { window.clearTimeout(timer); }
}

/** File names never download implicitly; every non-directory opens the preview surface. */
export function managedEntryOpensPreview(isDirectory: boolean): boolean {
  return !isDirectory;
}

function decorateVisibleFiles(root: ParentNode = document): void {
  for (const span of Array.from(root.querySelectorAll<HTMLElement>('button span.truncate'))) {
    const button = span.closest<HTMLButtonElement>('button');
    if (!button || !managedFileClickPath(button, root)) continue;
    button.dataset.htiFilesPreview = 'true';
    const name = span.textContent?.trim() || uiText('文件', 'file');
    button.title = uiText(`预览 ${name}（右侧按钮可下载）`, `Preview ${name} (use the action on the right to download)`);
  }
}

function refreshFilesPreview(): void {
  if (!isFilesRoute()) return;
  removeRowsBeforeParent();
  decorateVisibleFiles();
}

/** Capture filename clicks immediately; observers only restore optional decoration after React rerenders. */
export function installFilesPreview(): void {
  if ((window as any).__HERMES_WORKBENCH_FILES_PREVIEW__) return;
  (window as any).__HERMES_WORKBENCH_FILES_PREVIEW__ = true;
  document.addEventListener('click', event => {
    if (!isFilesRoute()) return;
    const path = interceptManagedFileClick(event);
    if (!path) return;
    const button = (event.target as Element | null)?.closest('button') as HTMLButtonElement | null;
    button?.setAttribute('aria-busy', 'true');
    void readManagedFile(path)
      .then(file => openFilePreview(file.name, file.blob, file.mime))
      .catch(error => {
        if (button) button.title = uiText(
          `预览失败：${error instanceof Error ? error.message : String(error)}`,
          `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => button?.removeAttribute('aria-busy'));
  }, true);

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      refreshFilesPreview();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['lang'],
  });
  window.addEventListener('popstate', schedule);
  schedule();
}
