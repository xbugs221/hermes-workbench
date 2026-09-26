import { describe, expect, it, vi } from 'vitest';
import { filePreviewKind } from '../dashboard/src/file-preview';
import {
  interceptManagedFileClick,
  managedEntryOpensPreview,
  managedFileClickPath,
  removeRowsBeforeParent,
  visibleManagedPath,
} from '../dashboard/src/files-preview';

describe('native Files preview policy', () => {
  it('classifies preview formats safely', () => {
    expect(filePreviewKind('README.md')).toBe('markdown');
    expect(filePreviewKind('diagram.svg')).toBe('image');
    expect(filePreviewKind('paper.pdf')).toBe('pdf');
    expect(filePreviewKind('config.yaml')).toBe('text');
    expect(filePreviewKind('archive.zip')).toBe('download');
  });

  it('opens every file name in preview and leaves directories navigable', () => {
    expect(managedEntryOpensPreview(false)).toBe(true);
    expect(managedEntryOpensPreview(true)).toBe(false);
  });

  it('synchronously blocks the native filename download handler', () => {
    const row = { querySelectorAll: () => [{ getAttribute: () => 'Download README.md' }] };
    const button = {
      querySelector: () => ({ textContent: 'README.md' }),
      closest: () => row,
    } as unknown as HTMLButtonElement;
    const root = {
      querySelector: (selector: string) => selector.startsWith('input')
        ? null
        : { getAttribute: () => '/opt/data/workspace/startup' },
    } as unknown as ParentNode;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();
    const event = {
      target: { closest: () => button },
      preventDefault,
      stopPropagation,
      stopImmediatePropagation,
    } as unknown as MouseEvent;
    expect(managedFileClickPath(button, root)).toBe('/opt/data/workspace/startup/README.md');
    expect(interceptManagedFileClick(event, root)).toBe('/opt/data/workspace/startup/README.md');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('reads the upload target after Chinese locale rewrites its aria-label', () => {
    const root = {
      querySelector: (selector: string) => selector === 'button[aria-label="上传文件"] [title]'
        ? { getAttribute: () => '/opt/data/workspace/startup' }
        : null,
    } as unknown as ParentNode;
    expect(visibleManagedPath(root)).toBe('/opt/data/workspace/startup');
  });

  it('preserves the table header while removing stale rows above parent', () => {
    const remove = vi.fn();
    const headerRemove = vi.fn();
    const header = { previousElementSibling: null, matches: () => true, querySelector: () => null, remove: headerRemove };
    const stale = { previousElementSibling: header, matches: () => true, querySelector: () => ({}), remove };
    const parent = { textContent: '..', previousElementSibling: stale };
    const root = { querySelectorAll: () => [parent] } as unknown as ParentNode;
    expect(removeRowsBeforeParent(root)).toBe(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(headerRemove).not.toHaveBeenCalled();
  });
});
