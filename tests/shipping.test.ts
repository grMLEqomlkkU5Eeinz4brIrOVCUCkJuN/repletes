import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) return sources(full);
		return full.endsWith(".ts") ? [full] : [];
	});
}

const shipped = sources(path.join(root, "src"));

test("nothing shipped imports anything", () => {
	const pattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g;

	for (const file of shipped) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(pattern)) {
			const specifier = match[1] ?? "";
			assert.ok(
				specifier.startsWith("./") || specifier.startsWith("../"),
				`${path.relative(root, file)} imports ${specifier}; the library has no dependencies and no node: imports`
			);
		}
	}
});

test("no runtime dependencies are declared", () => {
	const manifest: Record<string, unknown> = JSON.parse(
		readFileSync(path.join(root, "package.json"), "utf8")
	);

	assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.peerDependencies, undefined);
	assert.equal(manifest.optionalDependencies, undefined);
});
