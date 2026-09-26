import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  imageFilesFromTransfer,
  readClipboardImageFiles,
  transferMayContainImage,
  uploadWorkbenchFile,
  workbenchUploadPath,
} from '../dashboard/src/workbench-image-paste';

describe('Workbench image paste and drop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('accepts image files from the drag files fallback', () => {
    const image = new File([new Uint8Array([1, 2, 3])], 'drop.png', { type: 'image/png' });
    const transfer = { items: [], files: [image] } as unknown as DataTransfer;

    expect(transferMayContainImage(transfer)).toBe(true);
    expect(imageFilesFromTransfer(transfer)).toEqual([image]);
  });

  it('deduplicates an image exposed by both items and files', () => {
    const image = new File([new Uint8Array([1])], 'same.png', { type: 'image/png' });
    const transfer = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      files: [image],
    } as unknown as DataTransfer;

    expect(imageFilesFromTransfer(transfer)).toEqual([image]);
  });

  it('reads one image when clipboard views use different modification times', () => {
    const itemImage = new File(['png'], 'image.png', { type: 'image/png', lastModified: 10 });
    const fileImage = new File(['png'], 'image.png', { type: 'image/png', lastModified: 11 });
    const transfer = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => itemImage }],
      files: [fileImage],
    } as unknown as DataTransfer;
    expect(imageFilesFromTransfer(transfer)).toHaveLength(1);
  });

  it('preserves separate images even when their metadata matches', () => {
    const images = ['abc', 'xyz'].map(bytes => new File([bytes], 'image.png', {
      type: 'image/png', lastModified: 10,
    }));
    const transfer = {
      items: images.map(image => ({ kind: 'file', type: 'image/png', getAsFile: () => image })),
      files: images,
    } as unknown as DataTransfer;
    expect(imageFilesFromTransfer(transfer)).toEqual(images);
  });

  it('uses files when item image retrieval fails', () => {
    const image = new File(['png'], 'image.png', { type: 'image/png' });
    const transfer = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }], files: [image],
    } as unknown as DataTransfer;
    expect(imageFilesFromTransfer(transfer)).toEqual([image]);
  });

  it('reads browser clipboard image blobs into uploadable files', async () => {
    const clipboard = {
      read: async () => [{
        types: ['text/plain', 'image/png'],
        getType: async (type: string) => new Blob([new Uint8Array([137, 80])], { type }),
      }],
    } as unknown as Pick<Clipboard, 'read'>;

    const files = await readClipboardImageFiles(clipboard);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'clipboard.png', type: 'image/png', size: 2 });
  });

  it('sanitizes a selected local filename into the active workspace uploads directory', () => {
    expect(workbenchUploadPath('/opt/data/workspace/demo/', '../报告 2026.pdf', '1-abc')).toBe(
      '/opt/data/workspace/demo/uploads/1-abc-_报告 2026.pdf',
    );
  });

  it('streams a selected local file and returns its agent-readable path', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      expect(_url).toBe('/api/files/upload-stream');
      const body = options.body as FormData;
      expect(body.get('path')).toMatch(/^\/opt\/data\/workspace\/demo\/uploads\/123-/);
      expect(body.get('overwrite')).toBe('false');
      return new Response(JSON.stringify({ path: body.get('path') }), { status: 200 });
    }));
    const path = await uploadWorkbenchFile(new File(['hello'], 'notes.txt'), '/opt/data/workspace/demo');
    expect(path).toMatch(/\/uploads\/123-.*-notes\.txt$/);
  });
});
