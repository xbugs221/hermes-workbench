// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localFilePath, installChatFileLinks, openChatFilePreview } from '../dashboard/src/chat-file-links';
import { closeFilePreview } from '../dashboard/src/file-preview';
import { readManagedFile } from '../dashboard/src/files-preview';
vi.mock('../dashboard/src/files-preview', () => ({ readManagedFile: vi.fn() }));
afterEach(() => { closeFilePreview(); document.body.replaceChildren(); vi.resetAllMocks(); });

describe('file references without filesystem prefix restrictions', () => {
  const root = '/srv/project';
  it('resolves arbitrary roots, extensions, encoded names and line references', () => {
    for (const path of ['/srv/projects/README.md', '/etc/hosts', '/srv/LICENSE', '/opt/data/artifacts/report.md', '/custom/report.xyz']) {
      expect(localFilePath(path, root)).toBe(path);
      expect(localFilePath(`${path}:12:2`, root)).toBe(path);
      expect(localFilePath(`file://${path}`, root)).toBe(path);
    }
    expect(localFilePath('docs/../中文%20报告.md', root)).toBe('/srv/project/中文 报告.md');
    expect(localFilePath('../README.md', root)).toBe('/srv/README.md');
    expect(localFilePath('sandbox:/mnt/data/result.pdf', root)).toBe('/mnt/data/result.pdf');
    expect(localFilePath('file://localhost/etc/hosts', root)).toBe('/etc/hosts');
    expect(localFilePath('file:///config/README.md', root)).toBe('/config/README.md');
  });
  it('keeps web URLs, routes, fragments and invalid references out of file reads', () => {
    for (const href of ['https://example.com/a.md', 'http://localhost/chat', '//example.com/a.pdf', '#title', '?profile=a', '/chat', '/plugins/kanban', '/api/files/read', '/x/../chat', 'javascript:alert(1)', 'mailto:a@b.com', 'file://server/share', '%invalid', '/a%00b', 'blob:abc']) {
      expect(localFilePath(href, root), href).toBeNull();
    }
  });
  it('captures only content links and uses the nearest document base', () => {
    document.body.innerHTML = '<nav><a href="/srv/report.md">Nav</a></nav><section data-file-base="/other/project"><div class="hti-rich-markdown"><a href="../report.md"><span>Report</span></a><a href="/chat">Chat</a><a href="/srv/report.md" download>Download</a></div></section>';
    const open = vi.fn(); const router = vi.fn();
    const cleanup = installChatFileLinks(root, open);
    document.addEventListener('click', router);
    const dispatch = (selector: string) => document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    try {
      expect(dispatch('span')).toBe(false);
      expect(open).toHaveBeenCalledWith('/other/report.md', expect.any(HTMLElement));
      expect(router).not.toHaveBeenCalled();
      dispatch('nav a'); dispatch('a[href="/chat"]'); dispatch('a[download]');
      expect(open).toHaveBeenCalledTimes(1);
      expect(router).toHaveBeenCalledTimes(3);
    } finally { cleanup(); document.removeEventListener('click', router); }
  });
  it('does not reopen a preview closed before a file read finishes', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(readManagedFile).mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = openChatFilePreview('/srv/slow.txt');
    closeFilePreview();
    resolve({ name: 'slow.txt', blob: new Blob(['late']), mime: 'text/plain' });
    await pending;
    expect(document.getElementById('hti-file-preview')).toBeNull();
  });
  it('keeps an older response from replacing a newer preview', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(readManagedFile).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const first = openChatFilePreview('/srv/old.txt');
    vi.mocked(readManagedFile).mockRejectedValueOnce(new Error('文件不存在'));
    await openChatFilePreview('/srv/new.txt');
    resolve({ name: 'old.txt', blob: new Blob(['old']), mime: 'text/plain' }); await first;
    expect(document.getElementById('hti-file-preview')?.textContent).toContain('文件不存在');
    expect(document.getElementById('hti-file-preview')?.textContent).toContain('/srv/new.txt');
  });
});
