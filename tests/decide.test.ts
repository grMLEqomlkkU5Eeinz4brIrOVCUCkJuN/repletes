import assert from "node:assert/strict";
import { test } from "node:test";

import { decide } from "../src/index.js";
import type { Entry } from "../src/index.js";

const entry: Entry<string> = {
	value: "held",
	storedAt: 1000,
	freshFor: 100,
	staleWhileRevalidate: 100,
	staleIfError: 400,
};

test("absent entry is a miss", () => {
	assert.deepEqual(decide(undefined, 1000), { state: "miss" });
});

test("the four states, at their boundaries", () => {
	const at = (now: number): string => decide(entry, now).state;

	assert.equal(at(1000), "fresh");
	assert.equal(at(1100), "fresh", "freshFor is inclusive");
	assert.equal(at(1101), "stale");
	assert.equal(at(1200), "stale", "freshFor + swr is inclusive");
	assert.equal(at(1201), "retained");
	assert.equal(at(1500), "retained", "freshFor + sie is inclusive");
	assert.equal(at(1501), "miss", "beyond retention");
});

test("a hit carries the value and its age", () => {
	const decision = decide(entry, 1150);
	assert.equal(decision.state, "stale");
	assert.equal(decision.state === "stale" ? decision.value : undefined, "held");
	assert.equal(decision.state === "stale" ? decision.age : undefined, 150);
});

test("swr shorter than sie leaves a retained-only band", () => {
	const short: Entry<string> = { ...entry, staleWhileRevalidate: 0 };
	assert.equal(decide(short, 1101).state, "retained");
});

test("a clock that went backwards reads as age zero, not as an error", () => {
	assert.equal(decide(entry, 500).state, "fresh");
	const decision = decide(entry, 500);
	assert.equal(decision.state === "fresh" ? decision.age : undefined, 0);
});
