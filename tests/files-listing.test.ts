// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeManagedListing, installManagedFilesListing } from '../dashboard/src/files-listing';
import { closeFilePreview, openFilePreview, showFilePreviewLoading } from '../dashboard/src/file-preview';

afterEach(() => { closeFilePreview(); vi.unstubAllGlobals(); delete (window as any).__HTI_FILES_LISTING__; });
describe('Files symlink and download regressions', () => {
  it('retains separate aliases with unique native React keys and removes identical duplicate rows', () => {
    const entry = { name: 'skill-library', path: '/opt/data/skill-library', is_directory: true };
    const listing = { path: '/opt/data', parent: '/opt', entries: [entry, { ...entry, name: 'skill-library-local' }, entry] };
    const result = normalizeManagedListing(listing) as typeof listing;
    expect(result.entries.map(e => e.path)).toEqual(['/opt/data/skill-library', '/opt/data/skill-library-local']);
    expect(result.entries.map(e => e.name)).toEqual(['skill-library', 'skill-library-local']);
    expect(listing.entries).toHaveLength(3);
    expect(normalizeManagedListing(result)).toEqual(result);
  });
  it('does not rewrite errors, cross-origin requests or file reads', async () => {
    window.history.replaceState(null, '', '/files');
    const raw = { path: '/data', entries: [{ name: 'alias', path: '/target' }] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    installManagedFilesListing();
    expect((await (await fetch('/api/files')).json()).entries[0].path).toBe('/data/alias');
    for (const path of ['/api/files/read', 'https://elsewhere.test/api/files']) {
      expect(await (await fetch(path)).json()).toEqual(raw);
    }
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify(raw), { status: 403, headers: { 'content-type': 'application/json' } }));
    expect(await (await fetch('/api/files')).json()).toEqual(raw);
  });
  it.each(['README.md', 'notes.txt', 'picture.png', 'paper.pdf', 'archive.zip'])('offers original-byte download for %s', async name => {
    const create = vi.fn(() => 'blob:test-download');
    vi.spyOn(URL, 'createObjectURL').mockImplementation(create);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const blob = new Blob(['original bytes']);
    const body = showFilePreviewLoading(name);
    const overlay = document.getElementById('hti-file-preview')!;
    // happy-dom cannot navigate a blob PDF; native browser coverage checks attached UI.
    if (name.endsWith('.pdf')) overlay.remove();
    await openFilePreview(name, blob, '', body);
    const link = overlay.querySelector<HTMLAnchorElement>('header a[download]');
    expect(link?.download).toBe(name);
    expect(link?.href).toBe('blob:test-download');
    expect(create).toHaveBeenCalledWith(blob);
    closeFilePreview();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-download');
    vi.restoreAllMocks();
  });
});
