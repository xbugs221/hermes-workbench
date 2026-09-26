import { filePreviewKind, openFilePreview } from './file-preview';

const KANBAN_API = '/api/plugins/kanban';

type Attachment = { id: string; filename: string; content_type?: string };
type PreviewKind = 'markdown' | 'image' | 'pdf' | 'text' | 'download';

/** Pure classification keeps the preview policy explicit and regression-testable. */
export function attachmentPreviewKind(filename: string, contentType = ''): PreviewKind {
  return filePreviewKind(filename, contentType);
}

function boardFromLocation(): string {
  return new URLSearchParams(window.location.search).get('board') || '';
}

function api(path: string): string {
  const board = boardFromLocation();
  return board ? `${KANBAN_API}${path}${path.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}` : `${KANBAN_API}${path}`;
}

async function authedFetch(url: string): Promise<Response> {
  const sdk = (window as any).__HERMES_PLUGIN_SDK__;
  if (sdk?.authedFetch) return await sdk.authedFetch(url);
  return await fetch(url, { credentials: 'same-origin' });
}

function closePreview(): void {
  document.getElementById('hti-file-preview')?.remove();
}

/** Render Markdown/images/PDFs inside the Dashboard; unsupported binary files retain a download action. */
async function openPreview(attachment: Attachment): Promise<void> {
  closePreview();
  const response = await authedFetch(api(`/attachments/${encodeURIComponent(attachment.id)}`));
  if (!response.ok) throw new Error(`附件读取失败（${response.status}）`);
  const blob = await response.blob();
  await openFilePreview(attachment.filename, blob, attachment.content_type || blob.type);
}

async function installDrawerPreviews(drawer: HTMLElement): Promise<void> {
  const taskId = drawer.querySelector('.hermes-kanban-drawer-head span')?.textContent?.trim() || '';
  if (!taskId) return;
  const response = await authedFetch(api(`/tasks/${encodeURIComponent(taskId)}/attachments`));
  if (!response.ok) return;
  const payload = await response.json();
  const attachments: Attachment[] = Array.isArray(payload.attachments) ? payload.attachments : [];
  for (const downloadButton of Array.from(drawer.querySelectorAll('.hermes-kanban-attachment-link'))) {
    const filename = downloadButton.getAttribute('title') || downloadButton.textContent?.trim() || '';
    const attachment = attachments.find(item => item.filename === filename);
    const row = downloadButton.parentElement;
    if (!attachment || !row || row.querySelector('.hti-kanban-attachment-preview-button')) continue;
    const preview = document.createElement('button');
    preview.type = 'button'; preview.className = 'hti-kanban-attachment-preview-button'; preview.textContent = '预览';
    preview.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      void openPreview(attachment).catch(error => { preview.textContent = `预览失败`; preview.title = String(error); });
    });
    row.insertBefore(preview, downloadButton.nextSibling);
  }
}

/** Inject only after native React has rendered the drawer; observers reapply after its data refreshes. */
export function installKanbanAttachmentPreview(): void {
  if ((window as any).__HERMES_WORKBENCH_ATTACHMENT_PREVIEW__) return;
  (window as any).__HERMES_WORKBENCH_ATTACHMENT_PREVIEW__ = true;
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      for (const drawer of Array.from(document.querySelectorAll('.hermes-kanban-drawer'))) {
        void installDrawerPreviews(drawer as HTMLElement).catch(() => undefined);
      }
    });
  };
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
}
