import test, {type TestContext} from 'node:test';
import chalk from 'chalk';
import React from 'react';
import wrapAnsi from 'wrap-ansi';
import {Box, Text, Transform, render} from '../src/index.js';
import {type DOMElement} from '../src/dom.js';
import sanitizeAnsi, {normalizeC1Controls} from '../src/sanitize-ansi.js';
import squashTextNodes from '../src/squash-text-nodes.js';
import createStdout from './helpers/create-stdout.js';
import {renderToString} from './helpers/render-to-string.js';

test('nested transforms receive each explicit line with its line index', (t: TestContext) => {
	const output = renderToString(
		<Text>
			<Transform
				transform={(line, index) => line.replaceAll('x', () => String(index))}
			>
				<Text>{'xx\nxx'}</Text>
			</Transform>
		</Text>,
	);

	t.assert.strictEqual(output, '00\n11');
});

test('nested transform line indices do not depend on preceding siblings', (t: TestContext) => {
	const output = renderToString(
		<Text>
			prefix
			<Transform
				transform={(line, index) => line.replaceAll('x', () => String(index))}
			>
				<Text>xx</Text>
			</Transform>
		</Text>,
	);

	t.assert.strictEqual(output, 'prefix00');
});

// `squashTextNodes` as it was before it skipped sanitizing text that was already sanitized and cached its results.
const referenceSquashTextNodes = (node: DOMElement): string => {
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
				nodeText = referenceSquashTextNodes(childNode);
			}

			if (
				nodeText.length > 0 &&
				typeof childNode.internal_transform === 'function'
			) {
				const transform = childNode.internal_transform;
				nodeText = nodeText
					.split('\n')
					.map((line, lineIndex) => transform(line, lineIndex))
					.join('\n');
			}
		}

		text += nodeText;
	}

	text = normalizeC1Controls(sanitizeAnsi(text.replaceAll('\r\n', '\n')));

	if (node.nodeName === 'ink-text' && text.includes('\t')) {
		text = wrapAnsi(text, Infinity, {trim: false});
	}

	return text;
};

const collectTextNodes = (node: DOMElement, nodes: DOMElement[] = []) => {
	for (const childNode of node.childNodes) {
		if (childNode.nodeName === 'ink-text') {
			nodes.push(childNode);
		} else if (childNode.nodeName !== '#text') {
			collectTextNodes(childNode, nodes);
		}
	}

	return nodes;
};

const shimmerColors = ['#5f5f87', '#afafd7', '#ffffff'];

const fixtures: Record<string, React.JSX.Element> = {
	shimmer: (
		<Text>
			{[...'Thinking…'].map((character, index) => (
				// eslint-disable-next-line @eslint-react/no-array-index-key -- Characters have no identity of their own.
				<Text key={index} color={shimmerColors[index % 3]}>
					{character}
				</Text>
			))}
		</Text>
	),
	'every style prop': (
		<Text bold color="red" backgroundColor="blue">
			a{' '}
			<Text
				italic
				underline
				strikethrough
				inverse
				dimColor
				color="#00ff00"
				backgroundColor="ansi256(21)"
			>
				b
			</Text>{' '}
			<Text color="rgb(1, 2, 3)">c</Text>
		</Text>
	),
	'inherited background': (
		<Box backgroundColor="red">
			<Text>
				bg <Text color="white">w</Text>
			</Text>
		</Box>
	),
	'raw escape sequences': (
		<Text>
			{'\u{1B}[38:5:196mred\u{1B}[0m \u{9B}31mc1\u{1B}[39m\u{1B}[2J'}
			<Text color="green">{'\u{1B}[4:3mcurly\u{1B}[4:0m'}</Text>
		</Text>
	),
	'combining mark after a style': (
		<Text>
			e<Text color="red">{'\u{301}x'}</Text>
		</Text>
	),
	hyperlink: (
		<Text color="blue">
			{'\u{1B}]8;;https://example.com\u{7}link\u{1B}]8;;\u{7}'}
		</Text>
	),
	'tabs and line breaks': <Text color="cyan">{'a\tb\r\nc\td'}</Text>,
	'control characters': (
		<Text>
			bell{'\u{7}'} del{'\u{7F}'} <Text color="red">{'nel\u{85}'}</Text>
		</Text>
	),
	'nested transform': (
		<Text>
			<Transform transform={(line, index) => `${index}:${line}`}>
				<Text color="green">{'x\ny'}</Text>
			</Transform>
		</Text>
	),
};

for (const level of [0, 1, 2, 3] as const) {
	for (const [name, fixture] of Object.entries(fixtures)) {
		test(`squash ${name} like before at color level ${level}`, (t: TestContext) => {
			const previousLevel = chalk.level;
			chalk.level = level;
			t.after(() => {
				chalk.level = previousLevel;
			});

			const ref = React.createRef<DOMElement>();
			const {unmount} = render(<Box ref={ref}>{fixture}</Box>, {
				stdout: createStdout(),
				debug: true,
			});
			t.after(unmount);

			const textNodes = collectTextNodes(ref.current!);
			t.assert.ok(textNodes.length > 0);
			for (const node of textNodes) {
				t.assert.strictEqual(
					squashTextNodes(node),
					referenceSquashTextNodes(node),
				);
			}
		});
	}
}

const renderFrames = (elements: React.JSX.Element[]): string[] => {
	const stdout = createStdout();
	const {rerender, unmount} = render(elements[0], {stdout, debug: true});
	const frames = [stdout.get()];
	for (const element of elements.slice(1)) {
		rerender(element);
		frames.push(stdout.get());
	}

	unmount();
	return frames;
};

function Styled({
	color,
	text,
	transform,
}: {
	readonly color: string;
	readonly text: string;
	readonly transform: (line: string) => string;
}) {
	return (
		<Box flexDirection="column">
			<Text>
				a<Text color={color}>b</Text>
			</Text>
			<Text>
				<Text bold>
					<Text>{text}</Text>
				</Text>
			</Text>
			<Text>
				<Transform transform={transform}>
					<Text>t</Text>
				</Transform>
			</Text>
		</Box>
	);
}

test('a rerender squashes text nodes again', (t: TestContext) => {
	const upperCase = (line: string) => line.toUpperCase();
	const repeat = (line: string) => line.repeat(2);
	const steps = [
		{color: 'red', text: 'one', transform: upperCase},
		// Only a nested style changes.
		{color: 'blue', text: 'one', transform: upperCase},
		// Only a deeply nested text changes.
		{color: 'blue', text: 'two', transform: upperCase},
		// Only a nested transform changes.
		{color: 'blue', text: 'two', transform: repeat},
	];

	// Rerendering the same component type keeps the same DOM nodes, so each frame needs the cached text of the previous one to be dropped.
	const frames = renderFrames(steps.map(props => <Styled {...props} />));

	for (const [index, props] of steps.entries()) {
		t.assert.strictEqual(
			frames[index],
			renderFrames([<Styled {...props} />])[0],
		);
	}

	t.assert.strictEqual(new Set(frames).size, steps.length);
});
