import { describe, it, expect } from 'vitest';
import { groupWorkspaceEntries, uniqueWorkspaceEntries, workspaceEntryKey, workspaceAbsolutePath } from '../dashboard/src/workspace-file-actions';
describe('Workbench sidebar tree', () => {
  it('deduplicates repeated backend entries and preserves independently named aliases', () => {
    const entry = { path: 'skill-library', name: 'skill-library', type: 'directory' };
    const alias = { ...entry, name: 'skill-library-local' };
    const result = uniqueWorkspaceEntries([entry,entry,alias,entry]);
    expect(result).toEqual([entry,alias]);
    expect(new Set(result.map(workspaceEntryKey)).size).toBe(2);
  });
  it('resolves root-relative file tree paths before native file download', () => {
    expect(workspaceAbsolutePath('/opt/data','hermes_mcp_compat.py')).toBe('/opt/data/hermes_mcp_compat.py');
    expect(workspaceAbsolutePath('/opt/data','/srv/report.pdf')).toBe('/srv/report.pdf');
  });
});

it('groups only the service root and keeps every entry reachable', () => {
  const entries = ['logs', 'memories', 'workspace', 'plugins', 'skill-library'].map(name => ({ name, path: name, type: 'directory' }));
  const { common, other } = groupWorkspaceEntries(entries, '/opt/data');
  expect(common.map(e => e.name)).toEqual(['workspace', 'memories', 'skill-library', 'plugins']);
  expect(other.map(e => e.name)).toEqual(['logs']);
  expect(common.length + other.length).toBe(entries.length);
  expect(groupWorkspaceEntries(entries, '/some/project')).toEqual({ common: entries, other: [] });
});
