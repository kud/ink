import {Buffer} from 'node:buffer';
import EventEmitter from 'node:events';
import {writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import process from 'node:process';
import {setTimeout} from 'node:timers/promises';
import React from 'react';
import {Box, Text, render, useAnimation} from '../../src/index.js';

// One measurement of one scenario. `index.ts` runs this in a fresh process per sample.
// Usage: scenario.tsx <scenario> <fake|tty> <result-file>
const [scenarioName = 'shimmer', mode = 'fake', resultFile] =
	process.argv.slice(2);
const columns = 100;
const rows = 40;
// Faster than the default `maxFps` of 30, so every scenario is render-bound.
const interval = 16;

const palette = ['#5f5f87', '#8787af', '#afafd7', '#d7d7ff', '#ffffff'];

// A highlight band moving across a line: one `<Text color>` per character, all re-rendered each tick.
function Shimmer({
	text,
	offset = 0,
}: {
	readonly text: string;
	readonly offset?: number;
}) {
	const {frame} = useAnimation({interval});
	const band = (frame + offset) % (text.length + 10);

	return (
		<Text>
			{[...text].map((character, index) => {
				const distance = Math.abs(index - band + 5);
				const color = palette[Math.max(0, palette.length - 1 - distance)]!;
				return (
					// eslint-disable-next-line @eslint-react/no-array-index-key -- Characters have no identity of their own.
					<Text key={index} color={color}>
						{character}
					</Text>
				);
			})}
		</Text>
	);
}

function Counter() {
	const {frame} = useAnimation({interval});
	return <Text>Frames rendered: {frame}</Text>;
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
	const {frame} = useAnimation({interval});
	return (
		<Text>
			<Text color="cyan">{spinnerFrames[frame % spinnerFrames.length]}</Text>{' '}
			Loading
		</Text>
	);
}

function ProgressBar() {
	const {frame} = useAnimation({interval});
	const filled = frame % 41;
	return (
		<Text>
			<Text color="green">{'█'.repeat(filled)}</Text>
			<Text dimColor>{'░'.repeat(40 - filled)}</Text>{' '}
			{Math.round((filled / 40) * 100)}%
		</Text>
	);
}

function Pulse() {
	const {frame} = useAnimation({interval});
	const color = palette[Math.abs((frame % 8) - 4)]!;
	return (
		<Text bold color={color}>
			● Live
		</Text>
	);
}

function Gradient() {
	const {frame} = useAnimation({interval});
	return (
		<Text>
			{Array.from({length: 30}, (_, index) => (
				<Text
					key={index}
					backgroundColor={`ansi256(${232 + ((index + frame) % 24)})`}
				>
					{' '}
				</Text>
			))}
		</Text>
	);
}

const line = 'Thinking about how to render this response quickly…';

const scenarios: Record<string, () => React.JSX.Element> = {
	counter: () => <Counter />,
	shimmer: () => <Shimmer text={line} />,
	mix: () => (
		<Box flexDirection="column">
			<Spinner />
			<Shimmer text={line} />
			<ProgressBar />
			<Pulse />
			<Gradient />
			<Counter />
		</Box>
	),
	stress: () => (
		<Box flexDirection="column">
			{Array.from({length: 20}, (_, index) => (
				<Shimmer key={index} text={'x'.repeat(80)} offset={index * 3} />
			))}
		</Box>
	),
	// The same tree as `mix`, frozen: measures what an idle app costs.
	settled: () => (
		<Box flexDirection="column">
			<Text color="cyan">⠋ Loading</Text>
			<Text color="#afafd7">{line}</Text>
			<Text color="green">{'█'.repeat(20)}</Text>
			<Text bold>● Live</Text>
			<Text>Frames rendered: 0</Text>
		</Box>
	),
};

const scenario =
	scenarios[scenarioName] ??
	(() => {
		throw new Error(`Unknown scenario: ${scenarioName}`);
	});

const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 1000);
const windowMs = Number(process.env.BENCH_WINDOW_MS ?? 3000);
let bytes = 0;
let writes = 0;

// Synchronized output markers are written on their own around a frame, so they count as bytes but not as frames.
const isFrame = (chunk: string | Uint8Array) =>
	chunk !== '\u{1B}[?2026h' && chunk !== '\u{1B}[?2026l';

const createFakeStdout = (): NodeJS.WriteStream => {
	// Ink waits for nothing from a fake stream, so it never applies backpressure.
	// eslint-disable-next-line unicorn/prefer-event-target -- Ink listens with `on`, like on `process.stdout`.
	const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
	stdout.columns = columns;
	stdout.rows = rows;
	stdout.isTTY = true;
	stdout.write = ((chunk: string | Uint8Array) => {
		bytes += Buffer.byteLength(chunk);
		writes += isFrame(chunk) ? 1 : 0;
		return true;
	}) as NodeJS.WriteStream['write'];
	return stdout;
};

const countWrites = (stdout: NodeJS.WriteStream): NodeJS.WriteStream => {
	const write = stdout.write.bind(stdout);
	stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
		bytes += Buffer.byteLength(chunk);
		writes += isFrame(chunk) ? 1 : 0;
		return write(chunk, ...rest);
	}) as NodeJS.WriteStream['write'];
	return stdout;
};

const stdout =
	mode === 'tty' ? countWrites(process.stdout) : createFakeStdout();
if (mode === 'tty' && process.stdout.isTTY !== true) {
	throw new Error('`tty` mode needs a terminal, run it through `index.ts`');
}

const {unmount} = render(scenario(), {
	stdout,
	stderr: createFakeStdout(),
	patchConsole: false,
	exitOnCtrlC: false,
	interactive: true,
});

await setTimeout(warmupMs);

const startBytes = bytes;
const startWrites = writes;
const startCpu = process.cpuUsage();
const startTime = performance.now();
await setTimeout(windowMs);
const cpu = process.cpuUsage(startCpu);
const elapsed = performance.now() - startTime;
const frameBytes = bytes - startBytes;
const frames = writes - startWrites;

unmount();

const cpuMs = (cpu.user + cpu.system) / 1000;
const result = {
	scenario: scenarioName,
	mode,
	frames,
	cpuMs,
	elapsedMs: elapsed,
	msPerFrame: frames > 0 ? cpuMs / frames : 0,
	corePercent: (cpuMs / elapsed) * 100,
	bytesPerFrame: frames > 0 ? frameBytes / frames : 0,
};

if (resultFile === undefined) {
	console.log(result);
} else {
	writeFileSync(resultFile, JSON.stringify(result));
}
