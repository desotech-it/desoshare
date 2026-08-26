import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';

function basicExtensions(editable) {
  const ext = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(),
    indentOnInput(), bracketMatching(), highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown(), EditorView.lineWrapping,
    // Undo/redo di Yjs (yCollab installa già un Y.UndoManager che traccia solo le
    // origini locali): la history nativa di CodeMirror registrerebbe anche le
    // transazioni della sync plugin, e Ctrl+Z annullerebbe il testo degli ALTRI.
    keymap.of([...defaultKeymap, ...yUndoManagerKeymap, indentWithTab]),
  ];
  if (!editable) ext.push(EditorView.editable.of(false));
  return ext;
}

window.DesoEditor = {
  Y, EditorState, EditorView, basicExtensions, yCollab,
  Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates,
};
