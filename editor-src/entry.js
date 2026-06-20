import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { yCollab } from 'y-codemirror.next';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

function basicExtensions(editable) {
  const ext = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(),
    indentOnInput(), bracketMatching(), highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown(), EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    history(),
  ];
  if (!editable) ext.push(EditorView.editable.of(false));
  return ext;
}

window.DesoEditor = {
  Y, EditorState, EditorView, basicExtensions, yCollab,
  Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates,
};
