/** Select one side of legacy `中文 / English` UI text and keep language switching reversible. */
import { chineseUI } from './ui-locale';

const textSources = new WeakMap<Text, string>();
const attributeSources = new WeakMap<Element, Map<string, string>>();
const localizedAttributes = ['aria-label', 'title', 'placeholder'];

export function bilingualText(value: string, chinese: boolean): string {
  const match = value.match(/^(.*[\u3400-\u9fff].*?)\s+\/\s+([A-Za-z].*)$/s);
  if (!match) return value;
  return (chinese ? match[1] : match[2]).trim();
}

function localizeTextNode(node: Text, chinese: boolean): void {
  const source = textSources.get(node) || node.data;
  const localized = bilingualText(source, chinese);
  if (localized === source) return;
  textSources.set(node, source);
  if (node.data !== localized) node.data = localized;
}

function localizeElement(element: Element, chinese: boolean): void {
  let sources = attributeSources.get(element);
  for (const name of localizedAttributes) {
    const current = element.getAttribute(name);
    const source = sources?.get(name) || current;
    if (!source) continue;
    const localized = bilingualText(source, chinese);
    if (localized === source) continue;
    if (!sources) {
      sources = new Map();
      attributeSources.set(element, sources);
    }
    sources.set(name, source);
    if (current !== localized) element.setAttribute(name, localized);
  }
}

export function localizeWorkbenchUI(root: ParentNode = document): void {
  const chinese = chineseUI();
  if (root instanceof Element) localizeElement(root, chinese);
  for (const element of Array.from(root.querySelectorAll('*'))) localizeElement(element, chinese);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    localizeTextNode(node as Text, chinese);
    node = walker.nextNode();
  }
}

export function installWorkbenchLocaleOverlay(): void {
  if ((window as any).__HERMES_WORKBENCH_LOCALE_OVERLAY__) return;
  (window as any).__HERMES_WORKBENCH_LOCALE_OVERLAY__ = true;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      localizeWorkbenchUI();
    });
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['lang'],
  });
  schedule();
}
