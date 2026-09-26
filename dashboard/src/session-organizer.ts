/**
 * 文件目的：提供会话显示名称、集合、标签、固定和人工摘要的外层编辑对话框。
 * 业务边界：编辑结果只写入 Workbench 元数据 API，不触碰 Hermes 原始会话正文。
 */
import { saveSessionOrganization } from './session-organization-api';
import type { SessionOrganization } from './session-organization';

type SDK = Record<string, any>;

export interface SessionOrganizerProps {
  nativeSessionTitle: string;
  value: SessionOrganization;
  collections: string[];
  onClose: () => void;
  onSaved: (value: SessionOrganization | null, sessionId: string) => void;
}

/** Create one host-React element without bundling a second React runtime. */
function element(React: any, type: any, props?: Record<string, any> | null, ...children: any[]): any {
  return React.createElement(type, props, ...children);
}

/** Convert the comma-oriented field into bounded unique tags before backend validation. */
export function parseTagInput(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/[,，]/).flatMap((raw): string[] => {
    const tag = raw.trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  }).slice(0, 8);
}

/** Build the modal component against the SDK-provided React and authenticated fetch client. */
export function createSessionOrganizer(sdk: SDK): (props: SessionOrganizerProps) => any {
  const React = sdk.React;
  const { useState } = sdk.hooks;

  return function SessionOrganizer({
    nativeSessionTitle,
    value,
    collections,
    onClose,
    onSaved,
  }: SessionOrganizerProps): any {
    /** 用户路径：编辑完整组织信息，单次保存后更新左栏而不刷新会话正文。 */
    const [displayName, setDisplayName] = useState(value.displayName);
    const [collection, setCollection] = useState(value.collection);
    const [tagText, setTagText] = useState(value.tags.join(', '));
    const [pinned, setPinned] = useState(value.pinned);
    const [summary, setSummary] = useState(value.summary);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    /** Persist the complete form so a clear field also clears its stored value. */
    const save = async () => {
      setSaving(true);
      setError('');
      try {
        const saved = await saveSessionOrganization(sdk.fetchJSON, {
          ...value,
          displayName: String(displayName || '').trim(),
          collection: String(collection || '').trim(),
          tags: parseTagInput(String(tagText || '')),
          pinned: Boolean(pinned),
          summary: String(summary || '').trim(),
        });
        onSaved(saved, value.sessionId);
        onClose();
      } catch (reason) {
        setError(String(reason));
      } finally {
        setSaving(false);
      }
    };

    return element(React, 'div', {
      className: 'hti-organizer-backdrop',
      role: 'presentation',
      onMouseDown: (event: any) => {
        if (event.target === event.currentTarget && !saving) onClose();
      },
    }, element(React, 'section', {
      className: 'hti-organizer-dialog',
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'hti-organizer-title',
    },
    element(React, 'header', { className: 'hti-organizer-header' },
      element(React, 'div', null,
        element(React, 'span', null, '会话组织 / ORGANIZE SESSION'),
        element(React, 'strong', { id: 'hti-organizer-title' }, displayName || nativeSessionTitle)),
      element(React, 'button', {
        type: 'button',
        onClick: onClose,
        disabled: saving,
        'aria-label': '关闭 / Close',
      }, '×')),
    element(React, 'div', { className: 'hti-organizer-fields' },
      element(React, 'label', { htmlFor: 'hti-organizer-display-name' }, '显示名称（左侧标题） / Display name'),
      element(React, 'input', {
        id: 'hti-organizer-display-name',
        value: displayName,
        maxLength: 120,
        placeholder: `留空则显示：${nativeSessionTitle}`,
        onChange: (event: any) => setDisplayName(event.target.value),
      }),
      element(React, 'label', { htmlFor: 'hti-organizer-collection' }, '项目集合 / Collection'),
      element(React, 'input', {
        id: 'hti-organizer-collection',
        list: 'hti-organizer-collection-options',
        value: collection,
        maxLength: 80,
        placeholder: '例如：Hermes Workbench',
        onChange: (event: any) => setCollection(event.target.value),
      }),
      element(React, 'datalist', { id: 'hti-organizer-collection-options' },
        ...collections.map(name => element(React, 'option', { key: name, value: name }))),
      element(React, 'label', { htmlFor: 'hti-organizer-tags' }, '标签 / Tags'),
      element(React, 'input', {
        id: 'hti-organizer-tags',
        value: tagText,
        maxLength: 272,
        placeholder: '插件, UI, 部署（最多 8 个）',
        onChange: (event: any) => setTagText(event.target.value),
      }),
      element(React, 'label', { htmlFor: 'hti-organizer-summary' }, '会话摘要 / Summary'),
      element(React, 'textarea', {
        id: 'hti-organizer-summary',
        value: summary,
        maxLength: 2000,
        rows: 5,
        placeholder: '记录关键结论、已完成事项和下一步。',
        onChange: (event: any) => setSummary(event.target.value),
      }),
      element(React, 'label', { className: 'hti-organizer-pin' },
        element(React, 'input', {
          type: 'checkbox',
          checked: pinned,
          onChange: (event: any) => setPinned(event.target.checked),
        }),
        element(React, 'span', null, '固定到列表顶部 / Pin to top')),
      error ? element(React, 'div', { className: 'hti-organizer-error', role: 'alert' }, error) : null),
    element(React, 'footer', { className: 'hti-organizer-actions' },
      element(React, 'span', null, '显示名称留空时恢复 Hermes 原始标题；全部留空并取消固定后清除组织信息。'),
      element(React, 'div', null,
        element(React, 'button', { type: 'button', onClick: onClose, disabled: saving }, '取消 / Cancel'),
        element(React, 'button', {
          type: 'button', className: 'is-primary', onClick: save, disabled: saving,
        }, saving ? '保存中…' : '保存 / Save')))));
  };
}
