const LINK_ATTR = 'data-workbench-version-link';
const PANEL_ATTR = 'data-workbench-version-panel';

function versionRoute(): boolean {
  const url = new URL(window.location.href);
  return url.pathname === '/config' && url.searchParams.get('workbench') === 'versions';
}

function navigate(url: string): void {
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function renderCodexRuntime(panel: HTMLElement): Promise<void> {
  const status = panel.querySelector<HTMLElement>('[data-codex-runtime-status]');
  const button = panel.querySelector<HTMLButtonElement>('[data-codex-runtime-update]');
  if (!status || !button) return;
  try {
    const response = await fetch('/api/plugins/workbench/codex-runtime/status', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      installed_version: string; latest_version: string; update_available: boolean; busy: boolean; last_updated_at?: string | null;
    };
    status.textContent = data.update_available
      ? `当前 ${data.installed_version}，可更新至 ${data.latest_version}${data.busy ? '；自动更新会等当前任务结束' : ''}`
      : `当前版本 ${data.installed_version}，已是最新版本`;
    button.hidden = !data.update_available;
    button.textContent = data.update_available ? '立即更新并重启' : '已是最新版本';
    button.onclick = async () => {
      if (!window.confirm('更新会重启 Codex App Server，正在运行的 Codex 任务可能中断。继续吗？')) return;
      button.disabled = true;
      button.textContent = '正在下载、验证并重启…';
      status.textContent = '正在更新 Codex App Server…';
      try {
        const updated = await fetch('/api/plugins/workbench/codex-runtime/update', {
          method: 'POST', credentials: 'same-origin',
        });
        const result = await updated.json() as { installed_version?: string; detail?: string };
        if (!updated.ok) throw new Error(result.detail || `HTTP ${updated.status}`);
        status.textContent = `更新完成，当前版本 ${result.installed_version || data.latest_version}`;
        button.hidden = true;
        button.textContent = '已是最新版本';
      } catch (error) {
        status.textContent = `更新失败：${String(error)}`;
        button.disabled = false;
        button.textContent = '重试更新';
      }
    };
  } catch (error) {
    status.textContent = `Codex 版本检查失败：${String(error)}`;
    button.hidden = true;
  }
}

function addSettingsLink(): void {
  const nav = document.querySelector<HTMLElement>('.dashboard-settings-nav');
  if (!nav || nav.querySelector(`[${LINK_ATTR}]`)) return;
  const link = document.createElement('a');
  link.setAttribute(LINK_ATTR, 'true');
  link.href = '/config?workbench=versions';
  link.textContent = '版本切换';
  link.addEventListener('click', event => {
    event.preventDefault();
    navigate(link.href);
  });
  nav.append(link);
}

async function renderPanel(): Promise<void> {
  const main = document.querySelector<HTMLElement>('.dashboard-owned-page') || document.querySelector<HTMLElement>('main');
  if (!main) return;
  let panel = main.querySelector<HTMLElement>(`[${PANEL_ATTR}]`);
  if (!versionRoute()) {
    main.querySelectorAll<HTMLElement>('[data-workbench-settings-preserved]').forEach(node => {
      node.style.display = '';
      node.removeAttribute('data-workbench-settings-preserved');
    });
    panel?.remove();
    return;
  }
  if (panel) return;
  const preserved = Array.from(main.children).filter(node => !(node as HTMLElement).hasAttribute(PANEL_ATTR));
  preserved.forEach(node => {
    const element = node as HTMLElement;
    element.setAttribute('data-workbench-settings-preserved', 'true');
    element.style.display = 'none';
  });
  panel = document.createElement('section');
  panel.setAttribute(PANEL_ATTR, 'true');
  panel.innerHTML = '<h2>Codex App Server</h2><p class="workbench-version-muted">每天自动检查稳定版更新。更新会重启 App Server，正在运行的 Codex 任务可能中断。</p><div class="workbench-version-row"><strong data-codex-runtime-status role="status">正在检查 Codex 版本…</strong><button type="button" data-codex-runtime-update hidden>立即更新并重启</button></div><h2>Workbench 版本切换</h2><p class="workbench-version-muted" data-workbench-version-description>正在读取更新方式…</p><div class="workbench-version-list" role="list">正在读取版本…</div>';
  main.append(panel);
  void renderCodexRuntime(panel);
  await renderWorkbenchVersions(panel);

}

export async function waitForReleaseJob(id: string, report: (message: string) => void): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    let result: { id?: string; phase?: string; error?: string };
    try {
      const response = await fetch('/api/plugins/workbench/versions/update-status', { credentials: 'same-origin' });
      if (!response.ok) continue; // The backend is briefly unavailable during activation/rollback.
      result = await response.json();
    } catch { continue; }
    if (result.id !== id) throw new Error('更新状态已变化，请刷新页面确认当前版本。');
    if (result.phase === 'succeeded') return;
    if (result.phase === 'failed') throw new Error(result.error || '更新失败，已保留原版本。');
    report(result.phase === 'activating' ? '正在启动新版本；失败会自动回滚…' : '正在准备完整版本…');
  }
  throw new Error('更新状态暂不可确认，请稍后刷新查看；不要重复提交更新。');
}

export async function renderWorkbenchVersions(panel: HTMLElement, reload = () => window.location.reload()): Promise<void> {
  const list = panel.querySelector<HTMLElement>('.workbench-version-list')!;
  const status = document.createElement('p');
  status.className = 'workbench-version-muted';
  status.setAttribute('role', 'status');
  list.before(status);
  try {
    const response = await fetch('/api/plugins/workbench/versions', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      active: string; warning?: string; update_mode?: string; update?: { id?: string; phase?: string; error?: string };
      versions: Array<{ version: string; ready?: boolean; notes?: string; prerelease?: boolean; published_at?: string; source?: string }>;
    };
    const description = panel.querySelector('[data-workbench-version-description]');
    if (description) description.textContent = data.update_mode === 'release'
      ? '用户版：手动选择 GitHub 正式版本，前后端一起更新。任务运行中不能切换，启动失败自动回滚。'
      : '开发版：运行可编辑源码；这里仅切换界面资源，后端由开发者构建和实测。';
    status.textContent = data.warning || data.update?.error || `当前版本 ${data.active} · 按版本从新到旧排列`;
    list.replaceChildren(...data.versions.map(item => {
      const card = document.createElement('article');
      card.className = 'workbench-version-card';
      card.setAttribute('role', 'listitem');
      const row = document.createElement('div');
      row.className = 'workbench-version-row';
      const heading = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = item.version;
      const meta = document.createElement('small');
      meta.className = 'workbench-version-muted';
      meta.textContent = [item.prerelease ? '预发布' : item.source === 'github' ? '正式发布' : '本地版本',
        item.published_at ? new Date(item.published_at).toLocaleDateString() : '',
        item.ready ? '已缓存' : '点击更新时下载'].filter(Boolean).join(' · ');
      heading.append(label, meta);
      row.append(heading);
      if (item.version === data.active) {
        const badge = document.createElement('span');
        badge.className = 'workbench-version-active';
        badge.textContent = '当前版本';
        row.append(badge);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        const caption = item.ready ? '切换到此版本' : '更新到此版本';
        button.textContent = caption;
        button.addEventListener('click', async () => {
          const controls = list.querySelectorAll<HTMLButtonElement>('button');
          controls.forEach(control => { control.disabled = true; });
          button.textContent = '校验并切换中…';
          status.textContent = `正在准备 ${item.version}，请稍候…`;
          try {
            const switched = await fetch('/api/plugins/workbench/versions/switch', {
              method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: item.version }),
            });
            const result = await switched.json() as { detail?: string; pending?: boolean; job_id?: string };
            if (!switched.ok) throw new Error(result.detail || `HTTP ${switched.status}`);
            if (result.pending && result.job_id) await waitForReleaseJob(result.job_id, message => { status.textContent = message; });
            status.textContent = '切换完成，正在刷新…';
            reload();
          } catch (error) {
            status.textContent = `切换失败：${error instanceof Error ? error.message : String(error)}`;
            controls.forEach(control => { control.disabled = false; });
            button.textContent = caption;
          }
        });
        row.append(button);
      }
      const details = document.createElement('details');
      details.className = 'workbench-version-notes';
      const summary = document.createElement('summary');
      summary.textContent = '更新日志';
      const notes = document.createElement('div');
      // GitHub release text is untrusted; never inject it as HTML.
      notes.textContent = item.notes || '此版本暂无更新日志。';
      details.append(summary, notes);
      card.append(row, details);
      return card;
    }));
    if (data.update?.id && ['preparing', 'queued', 'activating'].includes(data.update.phase || '')) {
      list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
      try {
        await waitForReleaseJob(data.update.id, message => { status.textContent = message; });
        reload();
      } catch (error) {
        status.textContent = String(error);
        list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; });
      }
    }
    if (!data.versions.length) list.textContent = '暂无可用版本。';
  } catch (error) {
    list.textContent = `版本列表读取失败：${String(error)}`;
  }
}

export function installWorkbenchVersionSettings(): void {
  if ((window as any).__HERMES_WORKBENCH_VERSION_SETTINGS__) return;
  (window as any).__HERMES_WORKBENCH_VERSION_SETTINGS__ = true;
  const schedule = () => window.requestAnimationFrame(() => { addSettingsLink(); void renderPanel(); });
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  schedule();
}
