/**
 * Bare Enter in an editor, against the keymap the app actually installs.
 *
 * The behaviour that matters is not "which branch was taken" but what the
 * editor did: with `sendOnEnter` false the document must gain a block and the
 * submit callback must not run (a mobile Return that both inserted a newline
 * and sent the message would be the worst of both); with it true the callback
 * must run and the document must be untouched. The getter form is covered too,
 * since that is what lets the chat composer follow the input device without
 * rebuilding the editor.
 *
 * The list case drives the real `splitListItem` command against a real editor
 * state, so "a newline inside a list is another list item" is the command's
 * behaviour, not a stub's echo.
 *
 * Written against `node:test` + `node:assert` (available without adding a
 * dependency to app-lite; app-lite ships no test runner of its own) so the
 * file runs under both `bun test` and `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { splitListItem } from "@tiptap/pm/schema-list";
import { EditorState } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { initKeyboardShortcutHandler } from "./keyboardShortcut.ts";

const schema = getSchema([StarterKit]);

function paragraph(text: string) {
  return schema.node("paragraph", null, [schema.text(text)]);
}

function listItem(text: string) {
  return schema.node("listItem", null, [paragraph(text)]);
}

type SendOnEnter = boolean | (() => boolean);

/** What the keymap plugin calls on a keydown: a view and the key event. */
type EnterHandler = (
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  event: KeyboardEvent,
) => boolean;

/**
 * Press bare Enter in a document, as the installed extension sees it.
 *
 * The editor context hands the handler the real `splitListItem` bound to the
 * same state, which is what `this.editor.commands.splitListItem` resolves to
 * in the app.
 */
function pressEnter(doc: ProseMirrorNode, sendOnEnter: SendOnEnter) {
  let submits = 0;
  const extension = initKeyboardShortcutHandler({ onEnter: () => submits++, sendOnEnter });
  const state = EditorState.create({ schema, doc });
  const dispatched: Transaction[] = [];
  const dispatch = (tr: Transaction) => dispatched.push(tr);
  const plugins = extension.config.addProseMirrorPlugins!.call({
    editor: {
      commands: {
        splitListItem: (type: string) => splitListItem(schema.nodes[type]!)(state, dispatch),
      },
    },
  } as never);

  // Bound to the plugin instance in the real keymap; the handler itself only
  // reads `this.editor`, supplied above.
  const handleKeyDown = plugins[0]!.props.handleKeyDown as unknown as EnterHandler;
  const handled = handleKeyDown({ state, dispatch }, { key: "Enter" } as KeyboardEvent);

  const after = dispatched.length > 0 ? dispatched[dispatched.length - 1]!.doc : state.doc;
  return { handled, submits, doc: after };
}

describe("bare Enter", () => {
  test("inserts a new block and does not submit when sendOnEnter is false", () => {
    const { submits, doc } = pressEnter(schema.node("doc", null, [paragraph("hi")]), false);
    assert.equal(submits, 0);
    assert.equal(doc.childCount, 2);
    assert.equal(doc.textContent, "hi");
  });

  test("submits and leaves the document alone when sendOnEnter is true", () => {
    const { handled, submits, doc } = pressEnter(schema.node("doc", null, [paragraph("hi")]), true);
    assert.equal(handled, true);
    assert.equal(submits, 1);
    assert.equal(doc.childCount, 1);
    assert.equal(doc.textContent, "hi");
  });

  test("in a list, a new block is another list item — one list, not a broken one", () => {
    const { submits, doc } = pressEnter(
      schema.node("doc", null, [schema.node("bulletList", null, [listItem("one")])]),
      false,
    );
    assert.equal(submits, 0);
    assert.equal(doc.childCount, 1);
    const list = doc.child(0);
    assert.equal(list.type.name, "bulletList");
    assert.equal(list.childCount, 2);
  });

  test("the send/newline decision follows the device between keypresses", () => {
    // One handler, as the app builds it: the answer is read per keypress, so
    // a device that gains a hardware keyboard needs no new editor.
    let touchPrimary = true;
    let submits = 0;
    const extension = initKeyboardShortcutHandler({
      onEnter: () => submits++,
      sendOnEnter: () => !touchPrimary,
    });
    const state = EditorState.create({ schema, doc: schema.node("doc", null, [paragraph("hi")]) });
    const dispatched: Transaction[] = [];
    const dispatch = (tr: Transaction) => dispatched.push(tr);
    const plugins = extension.config.addProseMirrorPlugins!.call({
      editor: {
        commands: {
          splitListItem: (type: string) => splitListItem(schema.nodes[type]!)(state, dispatch),
        },
      },
    } as never);
    const handleKeyDown = plugins[0]!.props.handleKeyDown as unknown as EnterHandler;
    const view = { state, dispatch };

    handleKeyDown(view, { key: "Enter" } as KeyboardEvent);
    assert.equal(submits, 0, "touch-primary: Return must not send");
    assert.equal(dispatched.length, 1, "touch-primary: Return must insert a new block");

    touchPrimary = false;
    handleKeyDown(view, { key: "Enter" } as KeyboardEvent);
    assert.equal(submits, 1, "hardware keyboard: Enter must send");
    assert.equal(dispatched.length, 1, "hardware keyboard: Enter must not touch the document");
  });
});
