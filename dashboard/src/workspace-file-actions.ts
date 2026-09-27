import { readManagedFile } from './files-preview';

export type WorkspaceEntry = { path: string; name: string; type: string; size?: number };
/** Symlink aliases share a resolved target but must not share React identity. */
export function workspaceEntryKey(entry: WorkspaceEntry): string {
  return JSON.stringify([entry.path, entry.name]);
}
export function uniqueWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = workspaceEntryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function workspaceAbsolutePath(root: string, path: string): string {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(path) ? path : `${root.replace(/[\\/]$/, '')}/${path}`;
}
export async function downloadWorkspaceFile(root: string, path: string): Promise<void> {
  const file = await readManagedFile(workspaceAbsolutePath(root, path));
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = path.split(/[\\/]/).pop() || file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser must consume the URL before it is released.
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Keep everyday folders visible; retain all other data behind one disclosure. */
export function groupWorkspaceEntries(entries: WorkspaceEntry[], root: string): { common: WorkspaceEntry[]; other: WorkspaceEntry[] } {
  if (root.replace(/\/$/, '') !== '/opt/data') return { common: entries, other: [] };
  const names = ['workspace', 'memories', 'skill-library', 'plugins'];
  const common = names.flatMap(name => entries.filter(entry => entry.type === 'directory' && entry.name === name));
  if (!common.length) return { common: entries, other: [] };
  const selected = new Set(common);
  return { common, other: entries.filter(entry => !selected.has(entry)) };
}
