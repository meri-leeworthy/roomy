/***
 * Small text block — Discord's `-# small text` markdown extension.
 *
 * A block-level node rendered smaller than body text. Typing `-# ` at the
 * start of a line (or using the slash menu / Mod-Alt-s) converts the current
 * block into a small-text node. `proseMirrorDocToBlocks` maps it to the
 * `space.roomy.richtext.blocks#small` block.
 */

import { mergeAttributes, Node, textblockTypeInputRule } from "@tiptap/core";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		smallText: {
			setSmallText: () => ReturnType;
			toggleSmallText: () => ReturnType;
			unsetSmallText: () => ReturnType;
		};
	}
}

export const SmallText = Node.create({
	name: "smallText",

	group: "block",

	content: "inline*",

	parseHTML() {
		return [{ tag: "small" }, { tag: 'p[data-small="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"small",
			mergeAttributes(HTMLAttributes, {
				class: "text-xs text-base-500 dark:text-base-400",
			}),
			0,
		];
	},

	addCommands() {
		return {
			setSmallText:
				() =>
				({ commands }) =>
					commands.setNode(this.name),
			toggleSmallText:
				() =>
				({ commands }) =>
					commands.toggleNode(this.name, "paragraph"),
			unsetSmallText:
				() =>
				({ commands }) =>
					commands.setNode("paragraph"),
		};
	},

	addInputRules() {
		return [
			textblockTypeInputRule({
				find: /^-#\s$/,
				type: this.type,
			}),
		];
	},

	addKeyboardShortcuts() {
		return {
			"Mod-Alt-s": () => this.editor.commands.toggleSmallText(),
		};
	},
});
