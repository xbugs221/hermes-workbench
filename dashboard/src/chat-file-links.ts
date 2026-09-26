import { readManagedFile } from './files-preview';
import { openFilePreview, showFilePreviewLoading } from './file-preview';

// These are URL routes, not filesystem roots. Explicit file: links can disambiguate.
const APP_ROUTE = /^\/(?:chat|files|config|settings|cron|skills|sessions|plugins|api|dashboard-plugins|login|logout)(?:\/|$)/;

/** Resolve references syntactically; only the file API decides existence/access. */
export function localFilePath(href: string, workspace: string): string | null {
  if (!href || href.startsWith('//') || /^[#?]/.test(href)) return null;
  let explicit = false;
  if (/^file:\/\//i.test(href)) {
    // Reject remote file authorities; they are not local paths on this server.
    href = href.replace(/^file:\/\/(?:localhost(?=\/))?/i, '');
    if (!href.startsWith('/')) return null;
    explicit = true;
  } else if (/^sandbox:\//i.test(href)) {
    href = href.slice('sandbox:'.length);
    explicit = true;
  } else if (/^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let path: string;
  try { path = decodeURIComponent(href.split(/[?#]/)[0]).replace(/:\d+(?::\d+)?$/, ''); }
  catch { return null; }
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.startsWith('//')) return null;
  const absolute = path.startsWith('/');
  if (!absolute) {
    if (!workspace.startsWith('/')) return null;
    path = `${workspace}/${path}`;
  }
  // Normalize dot segments without URL encoding/decoding a second time.
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  path = '/' + parts.join('/');
  if (absolute && !explicit && (path === '/' || APP_ROUTE.test(path))) return null;
  return path;
}

/** Keep failures and late responses inside the preview that requested them. */
export async function openChatFilePreview(path: string): Promise<void> {
  const body = showFilePreviewLoading(path);
  body.dataset.fileBase = path.slice(0, path.lastIndexOf('/')) || '/';
  try {
    const file = await readManagedFile(path);
    if (!body.isConnected) return;
    await openFilePreview(file.name, file.blob, file.mime, body);
  } catch (error) {
    if (body.isConnected) body.textContent = `预览失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export function installChatFileLinks(workspace: string, open: (path: string, anchor: HTMLElement) => void): () => void {
  const click = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
    // Do not hijack sidebar links, application controls or native downloads.
    if (!anchor || anchor.hasAttribute('download') || !anchor.closest('.hti-rich-markdown, #hti-file-preview .hti-rich-text')) return;
    const base = anchor.closest<HTMLElement>('[data-file-base]')?.dataset.fileBase || workspace;
    const path = localFilePath(anchor.getAttribute('href') || '', base);
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    open(path, anchor);
  };
  window.addEventListener('click', click, true);
  return () => window.removeEventListener('click', click, true);
}
