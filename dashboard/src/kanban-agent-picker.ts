/** Load the actual installed roster; never disguise API failure as a default-only roster. */
import type { FetchJSON } from './workbench-api';

const AGENT_CHINESE_NAMES: Record<string, string> = {
  "default": "默认 Agent",
  "career-coach": "就业导师",
  "finance-advisor": "经济顾问",
  "health-advisor": "健康咨询师",
  "learning-mentor": "清北名师",
  "project-manager": "项目经理",
  "social-advisor": "社交大师",
  "travel-assistant": "旅行助理",
  "writer": "大文豪"
};

export function agentDisplayName(name: string): string {
  const label = AGENT_CHINESE_NAMES[name];
  return label ? `${name}（${label}）` : name;
}

export async function loadKanbanProfiles(fetchJSON: FetchJSON, url: string): Promise<string[]> {
  const payload = await fetchJSON<{ profiles: Array<{ name: string }> }>(url);
  if (!Array.isArray(payload?.profiles)) throw new Error('智能体列表格式异常');
  const names = [...new Set(payload.profiles.map(p => String(p?.name || '').trim()).filter(Boolean))];
  if (!names.length) throw new Error('未找到已安装的智能体');
  return names;
}

export async function populateKanbanAgentSelect(
  select: HTMLSelectElement, actions: HTMLButtonElement[], host: HTMLElement,
  load: () => Promise<string[]>,
): Promise<void> {
  const status = document.createElement('div');
  status.className = 'hti-kanban-agent-status';
  status.setAttribute('role', 'status');
  host.append(status);
  let loading = false;
  const refresh = async () => {
    if (loading) return;
    loading = true;
    const previous = select.value;
    select.disabled = true;
    actions.forEach(button => { button.disabled = true; });
    status.hidden = false;
    status.setAttribute('role', 'status');
    status.textContent = '正在读取智能体…';
    const pending = document.createElement('option');
    pending.textContent = '加载中…'; pending.value = '';
    select.replaceChildren(pending);
    try {
      const names = await load();
      select.replaceChildren(...names.map(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = agentDisplayName(name);
        return option;
      }));
      select.value = names.includes(previous) ? previous : names.includes('default') ? 'default' : names[0];
      select.disabled = false;
      actions.forEach(button => { button.disabled = false; });
      status.hidden = true;
    } catch (error) {
      const failed = document.createElement('option');
      failed.textContent = '智能体加载失败'; failed.value = '';
      select.replaceChildren(failed);
      status.setAttribute('role', 'alert');
      status.textContent = `无法读取智能体：${String(error)} `;
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'hti-kanban-action'; retry.textContent = '重试';
      retry.addEventListener('click', () => { void refresh(); });
      status.append(retry);
    } finally { loading = false; }
  };
  await refresh();
}
