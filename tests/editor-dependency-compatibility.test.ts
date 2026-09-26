// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { EditorView, lineNumbers } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';

it.each([['javascript', javascript], ['markdown', markdown], ['python', python]] as const)(
  'opens and edits %s using compatible CodeMirror extensions', (_name, language) => {
    const parent = document.createElement('div');
    document.body.append(parent);
    let view: EditorView | undefined;
    try {
      view = new EditorView({ doc: 'original', parent, extensions: [
        lineNumbers(), syntaxHighlighting(defaultHighlightStyle), language(),
      ] });
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'edited' } });
      expect(view.state.doc.toString()).toBe('edited');
      expect(parent.querySelector('.cm-content')).not.toBeNull();
    } finally { view?.destroy(); parent.remove(); }
  },
);
