/** Browser clipboard images must be uploaded before the PTY can attach them with /image. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
};
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Keep browser-selected files inside the active Workbench workspace. */
export function workbenchUploadPath(workspacePath: string, filename: string, uniqueId: string): string {
  const root = workspacePath.trim().replace(/\/+$/, '') || '/opt/data/workspace';
  const safeName = filename.trim()
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || 'attachment.bin';
  const safeId = uniqueId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || String(Date.now());
  return `${root}/uploads/${safeId}-${safeName}`;
}

export function imageFilesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  // items and files are two views of the same transfer, not separate inputs.
  // Clipboard File wrappers may have different lastModified values between views.
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file?.type.startsWith('image/')) files.push(file);
  }
  if (files.length) return files;
  // Some drag-and-drop implementations only populate files.
  for (const file of Array.from(data.files || [])) {
    if (file.type.startsWith('image/')) files.push(file);
  }
  return files;
}

export function transferMayContainImage(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.items || []).some(item =>
    item.kind === 'file' && (!item.type || item.type.startsWith('image/')))
    || Array.from(data.files || []).some(file => file.type.startsWith('image/'));
}

/** Read image blobs from the browser clipboard after a keyboard user gesture. */
export async function readClipboardImageFiles(
  clipboard: Pick<Clipboard, 'read'> | undefined,
): Promise<File[]> {
  if (!clipboard || typeof clipboard.read !== 'function') return [];
  const files: File[] = [];
  for (const item of await clipboard.read()) {
    const type = item.types.find(candidate => candidate.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = IMAGE_EXTENSIONS[type] || type.split('/')[1]?.split('+')[0] || 'png';
    files.push(new File([blob], `clipboard.${extension}`, { type }));
  }
  return files;
}

function asDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('image read failed'));
    reader.readAsDataURL(file);
  });
}

/** Upload into the same Hermes profile that owns the active Workbench TUI. */
export async function uploadWorkbenchImage(file: File, profile: string): Promise<string> {
  if (!file.size) throw new Error('clipboard image is empty');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('image too large (max 25 MB)');
  const mime = file.type || 'image/png';
  const extension = IMAGE_EXTENSIONS[mime] || 'png';
  const filename = file.name || `clipboard.${extension}`;
  const response = await fetch(`/api/chat/image-upload?profile=${encodeURIComponent(profile)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data_url: await asDataUrl(file), filename }),
  });
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.path) throw new Error('image upload did not return a path');
  return String(payload.path);
}

/** Stream a non-image browser file into the workspace and return its agent-readable path. */
export async function uploadWorkbenchFile(file: File, workspacePath: string): Promise<string> {
  if (!file.size) throw new Error('selected file is empty');
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  const path = workbenchUploadPath(workspacePath, file.name, `${Date.now()}-${token}`);
  const body = new FormData();
  body.append('file', file, file.name || 'attachment.bin');
  body.append('path', path);
  body.append('overwrite', 'false');
  const response = await fetch('/api/files/upload-stream', {
    method: 'POST', credentials: 'same-origin', body,
  });
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
  const payload = await response.json();
  return String(payload?.path || path);
}
