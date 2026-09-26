import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { uiText } from './ui-locale';

type PreviewKind = 'markdown' | 'image' | 'pdf' | 'text' | 'download';
type MermaidAPI = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, definition: string, container?: Element) => Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
};

const MERMAID_SCRIPT_ID = 'hti-mermaid-runtime';
const MERMAID_SCRIPT_URL = '/dashboard-plugins/workbench/dist/mermaid.min.js';
let mermaidLoad: Promise<MermaidAPI> | undefined;
let previewObjectUrls: string[] = [];
let mermaidSequence = 0;

/** Shared policy for Kanban attachments and the native Files page. */
export function filePreviewKind(filename: string, contentType = ''): PreviewKind {
  const lower = filename.toLowerCase();
  if (/\.(?:md|markdown|mdown|mdx)$/.test(lower) || contentType.includes('markdown')) return 'markdown';
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower) || contentType.startsWith('image/')) return 'image';
  if (lower.endsWith('.pdf') || contentType === 'application/pdf') return 'pdf';
  if (/\.(?:txt|log|csv|json|ya?ml|toml|ini|cfg|conf|xml|py|ts|tsx|js|jsx|sh|bash|css|html?|sql|c|cc|cpp|h|hpp|rs|go|java)$/.test(lower) || contentType.startsWith('text/')) return 'text';
  return 'download';
}

export function closeFilePreview(): void {
  document.getElementById('hti-file-preview')?.remove();
  for (const url of previewObjectUrls) URL.revokeObjectURL(url);
  previewObjectUrls = [];
}

function objectUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  previewObjectUrls.push(url);
  return url;
}

function mermaidGlobal(): MermaidAPI | undefined {
  return (window as unknown as { mermaid?: MermaidAPI }).mermaid;
}

function loadMermaid(): Promise<MermaidAPI> {
  const loaded = mermaidGlobal();
  if (loaded) return Promise.resolve(loaded);
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise<MermaidAPI>((resolve, reject) => {
    const existing = document.getElementById(MERMAID_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing || document.createElement('script');
    const finish = () => {
      const api = mermaidGlobal();
      if (api) resolve(api);
      else reject(new Error(uiText('Mermaid 运行时未注册', 'Mermaid runtime is unavailable')));
    };
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new Error(uiText('Mermaid 运行时加载失败', 'Could not load Mermaid runtime'))), { once: true });
    if (!existing) {
      script.id = MERMAID_SCRIPT_ID;
      script.src = MERMAID_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch(error => {
    mermaidLoad = undefined;
    throw error;
  });
  return mermaidLoad;
}

/** Render fenced ```mermaid blocks after safe Markdown conversion. */
export async function renderMermaidBlocks(root: HTMLElement): Promise<number> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'));
  if (!blocks.length) return 0;
  const mermaid = await loadMermaid();
  const dark = document.documentElement.classList.contains('dark')
    || document.documentElement.getAttribute('data-theme')?.includes('dark');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
  });
  let rendered = 0;
  for (const code of blocks) {
    const source = code.textContent || '';
    const host = document.createElement('div');
    host.className = 'hti-mermaid';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', uiText('Mermaid 图表', 'Mermaid diagram'));
    try {
      const result = await mermaid.render(`hti-mermaid-${Date.now()}-${mermaidSequence++}`, source);
      host.innerHTML = result.svg;
      result.bindFunctions?.(host);
      code.parentElement?.replaceWith(host);
      rendered += 1;
    } catch (error) {
      code.parentElement?.classList.add('hti-mermaid-error');
      const note = document.createElement('small');
      note.className = 'hti-mermaid-error-note';
      note.textContent = uiText(
        `Mermaid 渲染失败：${error instanceof Error ? error.message : String(error)}`,
        `Mermaid rendering failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      code.parentElement?.appendChild(note);
    }
  }
  return rendered;
}

function previewShell(filename: string): { overlay: HTMLElement; body: HTMLElement } {
  closeFilePreview();
  const overlay = document.createElement('div');
  overlay.id = 'hti-file-preview';
  overlay.className = 'hti-file-preview';
  overlay.addEventListener('click', event => { if (event.target === overlay) closeFilePreview(); });
  const panel = document.createElement('article');
  panel.className = 'hti-file-preview-panel';
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = filename;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = uiText('关闭', 'Close');
  close.setAttribute('aria-label', uiText('关闭预览', 'Close preview'));
  close.addEventListener('click', closeFilePreview);
  header.append(title, close);
  const body = document.createElement('div');
  body.className = 'hti-file-preview-body';
  panel.append(header, body);
  overlay.append(panel);
  document.body.append(overlay);
  return { overlay, body };
}

/** Show immediate feedback while the file API is being read. */
export function showFilePreviewLoading(filename: string): HTMLElement {
  const { body } = previewShell(filename);
  body.textContent = uiText('正在读取文件…', 'Loading file…');
  return body;
}

/** Open a safe, theme-aware in-page preview while preserving native downloads. */
export async function openFilePreview(filename: string, blob: Blob, contentType = blob.type, existingBody?: HTMLElement): Promise<void> {
  const kind = filePreviewKind(filename, contentType);
  const body = existingBody || previewShell(filename).body;
  body.replaceChildren();
  if (kind === 'markdown') {
    body.classList.add('hti-rich-text');
    body.innerHTML = micromark(await blob.text(), {
      allowDangerousHtml: false,
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    });
    await renderMermaidBlocks(body);
  } else if (kind === 'image') {
    const image = document.createElement('img');
    image.src = objectUrl(blob);
    image.alt = filename;
    body.appendChild(image);
  } else if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = objectUrl(blob);
    frame.title = filename;
    body.appendChild(frame);
  } else if (kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = await blob.text();
    body.appendChild(pre);
  } else {
    const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
    const pre = document.createElement('pre');
    pre.textContent = Array.from({ length: Math.ceil(bytes.length / 16) }, (_, row) => {
      const chunk = bytes.slice(row * 16, row * 16 + 16);
      return `${(row * 16).toString(16).padStart(8, '0')}  ${Array.from(chunk, byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${Array.from(chunk, byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('')}`;
    }).join('\n');
    const note = document.createElement('p');
    note.textContent = uiText(
      `此格式显示二进制预览（前 ${bytes.length} 字节，共 ${blob.size} 字节）；可下载完整文件。`,
      `Binary preview (first ${bytes.length} of ${blob.size} bytes). Download for the complete file.`,
    );
    const link = document.createElement('a');
    link.href = objectUrl(blob);
    link.download = filename;
    link.textContent = uiText('下载文件', 'Download file');
    body.append(note, pre, link);
  }
}
