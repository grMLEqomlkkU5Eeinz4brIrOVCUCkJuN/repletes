import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What each entry point exports at runtime. Adding a name here is a minor
 * release and removing one is a major, so the list is written down rather than
 * derived: a diff on this array is the thing a release has to explain.
 */
const SURFACE: Record<string, readonly string[]> = {
	repletes: [
		"Cache",
		"MemoryStore",
		"RepletesError",
		"decide",
		"fixed",
		"fromCacheControl",
	],
};

function npm(args: string[], cwd: string): string {
	// npm sets npm_execpath when it runs us, which avoids the .cmd shim that
	// execFileSync cannot spawn on Windows without a shell.
	const cli = process.env.npm_execpath;
	if (cli !== undefined && cli.endsWith(".js")) {
		return execFileSync(process.execPath, [cli, ...args], {
			cwd,
			encoding: "utf8",
			timeout: 300_000,
		});
	}
	return execFileSync("npm", args, {
		cwd,
		encoding: "utf8",
		timeout: 300_000,
		shell: process.platform === "win32",
	});
}

const workspace = mkdtempSync(path.join(tmpdir(), "repletes-artifact-"));
after(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const project = path.join(workspace, "consumer");
mkdirSync(project);
writeFileSync(
	path.join(project, "package.json"),
	`${JSON.stringify({ name: "repletes-consumer", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`
);

npm(["run", "build"], root);
const tarball =
	npm(["pack", "--pack-destination", workspace, "--silent"], root)
		.trim()
		.split("\n")
		.at(-1) ?? "";
npm(
	["install", "--no-audit", "--no-fund", "--no-package-lock", path.join(workspace, tarball)],
	project
);

const installed = path.join(project, "node_modules", "repletes");

/** Runs ESM in the consumer project, so imports resolve the way a user's do. */
function inConsumer(source: string): { stdout: string; stderr: string } {
	const run = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			// The trailing exit runs once stdout has drained, so a timer or handle
			// left behind by an import fails the assertion below instead of keeping
			// this child alive until the timeout.
			"--eval",
			`${source}\nprocess.stdout.write("", () => { process.exit(0); });`,
		],
		{ cwd: project, encoding: "utf8", timeout: 60_000 }
	);
	assert.equal(
		run.status,
		0,
		`the consumer script failed:\n${run.stdout}\n${run.stderr}`
	);
	return { stdout: run.stdout, stderr: run.stderr };
}

test("the tarball carries every path the exports map points at, and no sources", () => {
	const manifest = JSON.parse(
		readFileSync(path.join(installed, "package.json"), "utf8")
	) as { exports: Record<string, string | Record<string, string>> };

	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		const targets = typeof entry === "string" ? [entry] : Object.values(entry);
		for (const target of targets) {
			assert.ok(
				existsSync(path.join(installed, target)),
				`exports["${subpath}"] points at ${target}, which the tarball does not carry`
			);
		}
	}

	for (const excluded of [
		"src",
		"tests",
		"tsconfig.json",
		"eslint.config.mjs",
		".github",
	]) {
		assert.ok(
			!existsSync(path.join(installed, excluded)),
			`${excluded} was published`
		);
	}
});

test("the built entry points export exactly the public surface", () => {
	const { stdout } = inConsumer(`
		const surface = {};
		for (const specifier of ${JSON.stringify(Object.keys(SURFACE))}) {
			surface[specifier] = Object.keys(await import(specifier)).sort();
		}
		console.log(JSON.stringify(surface));
	`);

	assert.deepEqual(
		JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"),
		Object.fromEntries(
			Object.entries(SURFACE).map(([specifier, names]) => [
				specifier,
				[...names].sort(),
			])
		)
	);
});

test("importing the package prints nothing and holds nothing open", () => {
	const { stdout, stderr } = inConsumer(`
		const before = process.getActiveResourcesInfo().sort();
		for (const specifier of ${JSON.stringify(Object.keys(SURFACE))}) {
			await import(specifier);
		}
		const held = process.getActiveResourcesInfo().sort();
		console.log(JSON.stringify({ before, held }));
	`);

	const lines = stdout.trim().split("\n");
	const { before, held } = JSON.parse(lines.at(-1) ?? "{}") as {
		before: string[];
		held: string[];
	};

	assert.deepEqual(
		held,
		before,
		"importing repletes opened a handle or scheduled a timer"
	);
	assert.deepEqual(lines.slice(0, -1), [], "importing repletes wrote to stdout");
	assert.equal(stderr, "", "importing repletes wrote to stderr");
});

test("a cache built from the tarball serves, stores and reports its state", () => {
	const { stdout } = inConsumer(`
		import { Cache, MemoryStore, RepletesError, fixed } from "repletes";

		const cache = new Cache({
			store: new MemoryStore({ maxEntries: 4 }),
			freshness: fixed({ freshFor: 60_000, staleWhileRevalidate: 0, staleIfError: 0 }),
		});

		const first = await cache.read("k", () => "from-the-action");
		const second = await cache.read("k", () => "never-called");

		let code;
		try {
			new MemoryStore({ maxEntries: 0 });
		} catch (error) {
			code = error instanceof RepletesError ? error.code : "not-a-repletes-error";
		}

		console.log(JSON.stringify([first.state, second.state, second.value, code]));
	`);

	assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]"), [
		"miss",
		"fresh",
		"from-the-action",
		"invalid-capacity",
	]);
});

test("the published declarations typecheck from a consumer, with nothing widened to any", () => {
	writeFileSync(
		path.join(project, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				module: "nodenext",
				moduleResolution: "nodenext",
				target: "es2022",
				// The package imports no node builtin, so DOM alone has to supply
				// every global its declarations mention.
				lib: ["es2022", "dom"],
				strict: true,
				noEmit: true,
				types: [],
			},
			include: ["consumer.ts"],
		})
	);
	writeFileSync(path.join(project, "consumer.ts"), CONSUMER);

	try {
		execFileSync(
			process.execPath,
			[
				path.join(root, "node_modules", "typescript", "bin", "tsc"),
				"--project",
				path.join(project, "tsconfig.json"),
			],
			{ encoding: "utf8", timeout: 120_000 }
		);
	} catch (error) {
		const report = (error as { stdout?: string }).stdout ?? String(error);
		assert.fail(`the published declarations do not typecheck:\n${report}`);
	}
});

const CONSUMER = `
import {
	Cache,
	MemoryStore,
	RepletesError,
	decide,
	fixed,
	fromCacheControl,
} from "repletes";
import type { Entry, Event, Result, Store, Windows } from "repletes";

/**
 * never when T is any. Every use below applies it to an inferred \`typeof\`,
 * because a hand-written annotation would absorb an \`any\` instead of catching
 * it: any is assignable to every type except never.
 */
type NotAny<T> = 0 extends 1 & T ? never : T;

const windows: Windows = {
	freshFor: 30_000,
	staleWhileRevalidate: 60_000,
	staleIfError: 300_000,
};

const store: Store<string> = new MemoryStore<string>({ maxEntries: 64 });
const cache = new Cache<string>({
	store,
	freshness: fixed<string>(windows),
	onEvent: (event: Event) => {
		if (event.type === "store-error") throw event.error;
	},
});

export async function read(): Promise<string> {
	const result = await cache.read("k", (previous: Entry<string> | undefined) =>
		previous?.value ?? "v"
	);
	const checked: NotAny<typeof result> = result;
	const asResult: Result<string> = checked;
	return asResult.state === "fresh" ? asResult.value : "";
}

export function state(entry: Entry<string> | undefined): string {
	const decision = decide(entry, Date.now());
	const checked: NotAny<typeof decision> = decision;
	return checked.state;
}

export function reason(error: unknown): string | undefined {
	return error instanceof RepletesError ? error.code : undefined;
}

/**
 * \`fromCacheControl\` reads headers but touches no transport: it is a
 * \`Freshness\` over anything shaped like a response, which is why it survives
 * in a library with no http entry point.
 */
const fromHeaders = fromCacheControl<{ headers: Headers; status: number }>({
	fallback: windows,
});
export const checkedFreshness: NotAny<typeof fromHeaders> = fromHeaders;

export function shelfLife(response: Response): Windows | undefined {
	return checkedFreshness({
		headers: response.headers,
		status: response.status,
	});
}
`;
