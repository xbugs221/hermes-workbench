/** Keep native Files React keys unique without changing server access policy. */
export function normalizeManagedListing(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const listing = value as { path?: unknown; entries?: unknown };
  if (typeof listing.path !== 'string' || !Array.isArray(listing.entries)) return value;
  const base = listing.path;
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const seen = new Set<string>();
  return { ...listing, entries: listing.entries.flatMap(entry => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.path !== 'string'
      || !entry.name || entry.name === '.' || entry.name === '..'
      || /[/\\]/.test(entry.name)) return [entry];
    // The server resolves symlinks. Using that target as React's key caused
    // skill-library and skill-library-local to share a key and leave stale rows.
    const path = `${base}${base.endsWith('/') || base.endsWith('\\') ? '' : separator}${entry.name}`;
    if (seen.has(path)) return [];
    seen.add(path);
    return [{ ...entry, path }];
  }) };
}

/** Adapt only successful same-origin directory JSON; reads and mutations stay native. */
export function installManagedFilesListing(): void {
  const host = window as typeof window & { __HTI_FILES_LISTING__?: boolean };
  if (host.__HTI_FILES_LISTING__) return;
  host.__HTI_FILES_LISTING__ = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url || String(input), window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== '/api/files'
      || (init?.method || request?.method || 'GET').toUpperCase() !== 'GET'
      || !response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
    const readJSON = response.json.bind(response);
    response.json = async () => normalizeManagedListing(await readJSON());
    return response;
  };
}
