import assert from "node:assert/strict";
import { test } from "node:test";

import { Cache, MemoryStore, fixed } from "../src/index.js";
import type { Entry, Event, Store } from "../src/index.js";
import { WINDOWS, clock } from "./clock.js";
import { refusal } from "./refusal.js";

function build(options?: {
	onEvent?: (event: Event) => void;
	store?: Store<string>;
	namespace?: string;
	version?: string;
}): { cache: Cache<string>; time: ReturnType<typeof clock> } {
	const time = clock();
	const cache = new Cache<string>({
		store: options?.store ?? new MemoryStore<string>({ maxEntries: 8, now: time.now }),
		freshness: fixed(WINDOWS),
		now: time.now,
		onEvent: options?.onEvent,
		namespace: options?.namespace,
		version: options?.version,
	});
	return { cache, time };
}

function counter(value: string): {
	action: () => Promise<string>;
	calls: () => number;
} {
	let calls = 0;
	return {
		action: async () => {
			calls += 1;
			return `${value}-${calls}`;
		},
		calls: () => calls,
	};
}

test("a miss calls the action, stores it, and reports itself as a miss", async () => {
	const { cache } = build();
	const { action, calls } = counter("v");

	const result = await cache.read("k", action);

	assert.deepEqual(result, { value: "v-1", state: "miss", age: 0 });
	assert.equal(calls(), 1);
});

test("a fresh read serves without calling the action", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(50);
	const result = await cache.read("k", action);

	assert.deepEqual(result, { value: "v-1", state: "fresh", age: 50 });
	assert.equal(calls(), 1);
});

test("a stale read serves now and refreshes behind", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(150);

	const stale = await cache.read("k", action);
	assert.deepEqual(stale, { value: "v-1", state: "stale", age: 150 });
	assert.equal(calls(), 2, "the refresh is already running");

	await cache.settled();
	assert.deepEqual(await cache.read("k", action), {
		value: "v-2",
		state: "fresh",
		age: 0,
	});
});

test("concurrent stale reads produce exactly one refresh", async () => {
	const { cache, time } = build();
	const { action, calls } = counter("v");

	await cache.wrap("k", action);
	time.advance(150);

	const reads = await Promise.all([
		cache.read("k", action),
		cache.read("k", action),
		cache.read("k", action),
	]);

	assert.deepEqual(
		reads.map((read) => read.state),
		["stale", "stale", "stale"]
	);
	await cache.settled();
	assert.equal(calls(), 2, "one fill plus one refresh");
});

test("a read concurrent with a refresh is answered from the entry, not the refresh", async () => {
	const { cache, time } = build();
	let release: (value: string) => void = () => {};
	const slow = async (): Promise<string> =>
		new Promise<string>((resolve) => {
			release = resolve;
		});

	await cache.wrap("k", async () => "first");
	time.advance(150);

	assert.equal((await cache.read("k", slow)).value, "first");
	assert.equal((await cache.read("k", slow)).value, "first");

	release("second");
	await cache.settled();
	assert.equal((await cache.read("k", slow)).value, "second");
});

test("a failed refresh leaves the previous entry readable", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "held");
	time.advance(150);

	const stale = await cache.read("k", async () => {
		throw new Error("upstream down");
	});
	assert.equal(stale.value, "held");
	await cache.settled();

	assert.equal((await cache.read("k", async () => "unused")).value, "held");
	assert.ok(
		events.some((event) => event.type === "refresh" && event.ok === false),
		"the failure is reported, not thrown"
	);
});

test("stale-if-error serves the retained entry when the action fails", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "held");
	time.advance(250);

	const result = await cache.read("k", async () => {
		throw new Error("upstream down");
	});

	assert.deepEqual(result, { value: "held", state: "retained", age: 250 });
	assert.ok(events.some((event) => event.type === "served-stale"));
});

test("a retained entry is replaced when the action succeeds", async () => {
	const { cache, time } = build();

	await cache.wrap("k", async () => "old");
	time.advance(250);

	assert.deepEqual(await cache.read("k", async () => "new"), {
		value: "new",
		state: "miss",
		age: 0,
	});
	assert.equal((await cache.read("k", async () => "unused")).value, "new");
});

test("every action failure is reported exactly once, wherever it happened", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });
	const boom = async (): Promise<string> => {
		throw new Error("upstream down");
	};
	const types = (): string[] => events.map((event) => event.type);
	const failures = (): Extract<Event, { type: "action-error" }>[] =>
		events.filter((event) => event.type === "action-error");

	// On a miss, before the error is rethrown.
	await assert.rejects(cache.wrap("k", boom));
	assert.deepEqual(types(), ["action-error"]);
	assert.equal(failures()[0]?.background, false);
	assert.equal((failures()[0]?.error as Error).message, "upstream down");

	// Behind a stale read, marked as the refresh nobody awaited.
	events.length = 0;
	await cache.wrap("k", async () => "held");
	time.advance(150);
	await cache.wrap("k", boom);
	await cache.settled();
	assert.deepEqual(types(), ["miss", "write", "hit", "action-error", "refresh"]);
	assert.equal(failures()[0]?.background, true);

	// Under a retained entry, before the stale value is served.
	events.length = 0;
	time.advance(150);
	await cache.wrap("k", boom);
	assert.deepEqual(types(), ["action-error", "served-stale", "hit"]);
	assert.equal(failures()[0]?.background, false);
});

test("a successful read reports no error at all", async () => {
	const events: Event[] = [];
	const { cache, time } = build({ onEvent: (event) => events.push(event) });

	await cache.wrap("k", async () => "v");
	time.advance(50);
	await cache.wrap("k", async () => "v");

	assert.deepEqual(
		events.filter((event) => event.type === "action-error"),
		[]
	);
});

test("the original error survives stale-if-error untouched", async () => {
	const { cache, time } = build();
	class UpstreamError extends Error {
		readonly status = 503;
	}
	const original = new UpstreamError("gone");

	await cache.wrap("k", async () => "held");
	time.advance(600);

	await assert.rejects(
		cache.wrap("k", async () => {
			throw original;
		}),
		(error: unknown) => {
			assert.equal(error, original, "same instance, not wrapped");
			return true;
		}
	);
});

test("a failure is never written down", async () => {
	const { cache } = build();

	await assert.rejects(
		cache.wrap("k", async () => {
			throw new Error("no");
		})
	);
	assert.equal(await cache.peek("k"), undefined);
});

test("freshness declining a value skips the write", async () => {
	const events: Event[] = [];
	const time = clock();
	const cache = new Cache<string>({
		store: new MemoryStore<string>({ maxEntries: 4, now: time.now }),
		freshness: (value) => (value === "skip" ? undefined : WINDOWS),
		now: time.now,
		onEvent: (event) => events.push(event),
	});

	await cache.wrap("k", async () => "skip");

	assert.equal(await cache.peek("k"), undefined);
	assert.ok(events.some((event) => event.type === "skip"));
});

test("peek reads without calling anything or triggering a refresh", async () => {
	const { cache, time } = build();

	assert.equal(await cache.peek("k"), undefined);
	await cache.wrap("k", async () => "held");
	time.advance(150);

	assert.deepEqual(await cache.peek("k"), {
		value: "held",
		state: "stale",
		age: 150,
	});
	await cache.settled();
	assert.equal((await cache.peek("k"))?.value, "held", "peek refreshed nothing");

	time.advance(1000);
	assert.equal(await cache.peek("k"), undefined, "beyond retention");
});

test("forget drops one key, clear drops the store", async () => {
	const { cache } = build();

	await cache.wrap("a", async () => "a");
	await cache.wrap("b", async () => "b");

	await cache.forget("a");
	assert.equal(await cache.peek("a"), undefined);
	assert.equal((await cache.peek("b"))?.value, "b");

	await cache.clear();
	assert.equal(await cache.peek("b"), undefined);
});

test("clear on a store without one is a type error, not a silent no-op", async () => {
	const store: Store<string> = {
		get: async () => undefined,
		set: async () => {},
		delete: async () => {},
	};
	const { cache } = build({ store });

	await assert.rejects(cache.clear(), refusal("clear-unsupported"));
});

test("namespace and version prefix the key", async () => {
	const keys: string[] = [];
	const store: Store<string> = {
		get: async (key) => {
			keys.push(key);
			return undefined;
		},
		set: async () => {},
		delete: async () => {},
	};
	const { cache } = build({ store, namespace: "orders", version: "v2" });

	await cache.wrap("42", async () => "x");

	assert.deepEqual(keys, ["orders:v2:42"]);
});

test("an empty key is refused", async () => {
	const { cache } = build();
	await assert.rejects(cache.wrap("", async () => "x"), refusal("invalid-key"));
});

test("a store failure is a miss on read and a no-op on write", async () => {
	const events: Event[] = [];
	const store: Store<string> = {
		get: async () => {
			throw new Error("redis down");
		},
		set: async () => {
			throw new Error("redis down");
		},
		delete: async () => {
			throw new Error("redis down");
		},
	};
	const { cache } = build({ store, onEvent: (event) => events.push(event) });

	assert.equal(await cache.wrap("k", async () => "v"), "v");
	assert.equal(await cache.peek("k"), undefined);
	await cache.forget("k");

	assert.deepEqual(
		events
			.filter((event) => event.type === "store-error")
			.map((event) => (event.type === "store-error" ? event.operation : "")),
		["get", "set", "get", "delete"]
	);
});

test("an onEvent listener that throws does not fail a read", async () => {
	const { cache } = build({
		onEvent: () => {
			throw new Error("bad listener");
		},
	});

	assert.equal(await cache.wrap("k", async () => "v"), "v");
});

test("the action is handed whatever the store still holds", async () => {
	const { cache, time } = build();
	const seen: (Entry<string> | undefined)[] = [];
	const record = async (previous: Entry<string> | undefined): Promise<string> => {
		seen.push(previous);
		return "v";
	};

	await cache.wrap("k", record);
	time.advance(150);
	await cache.wrap("k", record);
	await cache.settled();

	assert.equal(seen.length, 2);
	assert.equal(seen[0], undefined);
	assert.equal(seen[1]?.value, "v");
});

test("windows are validated, not defaulted", () => {
	assert.throws(
		() => fixed({ freshFor: -1, staleWhileRevalidate: 0, staleIfError: 0 }),
		refusal("invalid-windows")
	);
	assert.throws(
		() =>
			fixed({
				freshFor: Number.NaN,
				staleWhileRevalidate: 0,
				staleIfError: 0,
			}),
		refusal("invalid-windows")
	);
});
