import wrapAnsi from 'wrap-ansi';
import {type DOMElement} from './dom.js';
import sanitizeAnsi, {
	isSanitized,
	normalizeC1Controls,
} from './sanitize-ansi.js';

// Layout measures each text node and rendering then squashes it again, and Yoga can measure a node more than once, so the same text was built, styled and sanitized several times per frame. The tree only changes while React commits, so a result stays valid until the next commit starts.
let commitGeneration = 0;
const squashedTexts = new WeakMap<
	DOMElement,
	{readonly generation: number; readonly text: string}
>();

export const invalidateSquashedTextNodes = (): void => {
	commitGeneration++;
};

// Squashing text nodes allows to combine multiple text nodes into one and write
// to `Output` instance only once. For example, <Text>hello{' '}world</Text>
// is actually 3 text nodes, which would result 3 writes to `Output`.
//
// Also, this is necessary for libraries like ink-link (https://github.com/sindresorhus/ink-link),
// which need to wrap all children at once, instead of wrapping 3 text nodes separately.
const squash = (node: DOMElement): string => {
	let text = '';

	for (const childNode of node.childNodes) {
		let nodeText = '';

		if (childNode.nodeName === '#text') {
			nodeText = childNode.nodeValue;
		} else {
			if (childNode.isHidden) {
				continue;
			}

			if (
				childNode.nodeName === 'ink-text' ||
				childNode.nodeName === 'ink-virtual-text'
			) {
				nodeText = squash(childNode);
			}

			// Since these text nodes are being concatenated, `Output` instance won't be able to
			// apply children transform, so we have to do it manually here for each text node
			if (
				nodeText.length > 0 &&
				typeof childNode.internal_transform === 'function'
			) {
				const transform = childNode.internal_transform;
				nodeText = nodeText.includes('\n')
					? nodeText
							.split('\n')
							.map((line, lineIndex) => transform(line, lineIndex))
							.join('\n')
					: transform(nodeText, 0);
			}
		}

		text += nodeText;
	}

	text = text.replaceAll('\r\n', '\n');

	// Text styled by `<Text>` is already sanitized, so skip tokenizing it again.
	if (!isSanitized(text)) {
		text = normalizeC1Controls(sanitizeAnsi(text));
	}

	// Expand tabs after combining nested text so measurement and rendering use the same columns.
	if (node.nodeName === 'ink-text' && text.includes('\t')) {
		text = wrapAnsi(text, Infinity, {trim: false});
	}

	return text;
};

const squashTextNodes = (node: DOMElement): string => {
	// Nested text is only squashed as part of the text node that holds it, so only that one is cached.
	if (node.nodeName !== 'ink-text') {
		return squash(node);
	}

	const cached = squashedTexts.get(node);
	if (cached?.generation === commitGeneration) {
		return cached.text;
	}

	const text = squash(node);
	squashedTexts.set(node, {generation: commitGeneration, text});

	return text;
};

export default squashTextNodes;
