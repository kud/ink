import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

// Run with: npm run benchmark -- benchmark/animation/index.ts [scenario...]
// Compare the same script on the base and the PR. Every sample is a fresh process with React's production build, so caches and JIT state from one don't affect the next.
// `fake` renders into an in-memory stdout. `tty` renders into a real pseudo-terminal through util-linux `script`, so the cost of writing to a terminal is included.
// BENCH_SAMPLES, BENCH_WARMUP_MS, BENCH_WINDOW_MS and BENCH_MODES override the defaults.

type Result = {
	scenario: string;
	mode: string;
	frames: number;
	msPerFrame: number;
	corePercent: number;
	bytesPerFrame: number;
};

const allScenarios = ['counter', 'shimmer', 'mix', 'stress', 'settled'];
const scenarios =
	process.argv.length > 2 ? process.argv.slice(2) : allScenarios;
const modes = (process.env.BENCH_MODES ?? 'fake,tty').split(',');
const samples = Number(process.env.BENCH_SAMPLES ?? 5);
const scenarioFile = fileURLToPath(new URL('scenario.tsx', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'ink-bench-'));
// Without a forced color level, `fake` mode inherits the level of whatever stdout runs this script, and a piped run would render no colors at all.
const environment: NodeJS.ProcessEnv = {...process.env};
environment.FORCE_COLOR ??= '3';
environment.NODE_ENV = 'production';
environment.NODE_NO_WARNINGS = '1';

const shellQuote = (value: string) =>
	`'${value.replaceAll("'", String.raw`'\''`)}'`;

const runSample = (scenario: string, mode: string, sample: number): Result => {
	const resultFile = path.join(directory, `${scenario}-${mode}-${sample}.json`);
	const command = [
		process.execPath,
		'--import=tsx',
		scenarioFile,
		scenario,
		mode,
		resultFile,
	];

	if (mode === 'tty') {
		// `script` gives the child a real pty and copies everything it prints to /dev/null.
		execFileSync(
			'script',
			['-qec', command.map(part => shellQuote(part)).join(' '), '/dev/null'],
			{
				env: environment,
				stdio: ['ignore', 'ignore', 'inherit'],
			},
		);
	} else {
		execFileSync(command[0], command.slice(1), {
			env: environment,
			stdio: 'inherit',
		});
	}

	return JSON.parse(readFileSync(resultFile, 'utf8')) as Result;
};

const median = (values: number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};

const rows: string[] = [
	'| Scenario | Stdout | Frames/s | CPU ms/frame | % of a core | Bytes/frame |',
	'| --- | --- | ---: | ---: | ---: | ---: |',
];

for (const scenario of scenarios) {
	for (const mode of modes) {
		const results = Array.from({length: samples}, (_, sample) =>
			runSample(scenario, mode, sample),
		);
		const windowSeconds = Number(process.env.BENCH_WINDOW_MS ?? 3000) / 1000;
		const row = [
			scenario,
			mode,
			(median(results.map(result => result.frames)) / windowSeconds).toFixed(1),
			median(results.map(result => result.msPerFrame)).toFixed(2),
			median(results.map(result => result.corePercent)).toFixed(1),
			Math.round(
				median(results.map(result => result.bytesPerFrame)),
			).toString(),
		];
		rows.push(`| ${row.join(' | ')} |`);
		console.error(rows.at(-1));
	}
}

rmSync(directory, {recursive: true, force: true});
console.log(
	`\nMedians of ${samples} samples, Node.js ${process.version}, NODE_ENV=production, FORCE_COLOR=${environment.FORCE_COLOR}.\n`,
);
console.log(rows.join('\n'));
