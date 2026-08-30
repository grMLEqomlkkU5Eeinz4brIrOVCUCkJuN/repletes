import { decide } from "./decide.js";
import { RepletesError } from "./errors.js";
import type {
	Action,
	Entry,
	Event,
	Freshness,
	Result,
	Store,
} from "./types.js";
import { assertWindows, retentionFor } from "./windows.js";

export interface CacheOptions<T> {
	store: Store<T>;
	/** Whether a completed value is stored, and for how long. */
	freshness: Freshness<T>;
	/** Prefixed onto every key. Nothing is derived, hashed or normalised. */
	namespace?: string;
	/** Prefixed after the namespace. Bump it to orphan every entry of an old shape. */
	version?: string | number;
	/** Swappable clock. Defaults to `Date.now`. */
	now?: () => number;
	/** Told about everything. A listener that throws is ignored, not propagated. */
	onEvent?: (event: Event) => void;
}

/**
 * A store plus every decision about caching one kind of thing. Construct it
 * once and share it deliberately.
 *
 * The cache belongs outside your retry and rate-limit layers: a hit should not
 * consume a bulkhead slot. Only a miss becomes a call.
 */
export class Cache<T> {
	readonly #store: Store<T>;
	readonly #freshness: Freshness<T>;
	readonly #prefix: string;
	readonly #now: () => number;
	readonly #onEvent: ((event: Event) => void) | undefined;
	readonly #refreshing = new Map<string, Promise<void>>();

	constructor(options: CacheOptions<T>) {
		this.#store = options.store;
		this.#freshness = options.freshness;
		this.#now = options.now ?? Date.now;
		this.#onEvent = options.onEvent;

		const parts: string[] = [];
		if (options.namespace !== undefined) parts.push(String(options.namespace));
		if (options.version !== undefined) parts.push(String(options.version));
		this.#prefix = parts.length === 0 ? "" : `${parts.join(":")}:`;
	}

	/**
	 * The value behind a key, from the store when the windows say so and from
	 * `action` when they do not.
	 *
	 * An action failure on a miss rethrows untouched. An action failure covered
	 * by `staleIfError` serves the retained value instead.
	 */
	async wrap(key: string, action: Action<T>): Promise<T> {
		const result = await this.read(key, action);
		return result.value;
	}

	/**
	 * {@link wrap}, with where the value came from. Use this when a caller has
	 * to tell a fresh answer from one that survived an upstream failure.
	 */
	async read(key: string, action: Action<T>): Promise<Result<T>> {
		const id = this.#id(key);
		const entry = await this.#get(id);
		const decision = decide(entry, this.#now());

		switch (decision.state) {
		case "fresh": {
			this.#emit({ type: "hit", key: id, state: "fresh", age: decision.age });
			return { value: decision.value, state: "fresh", age: decision.age };
		}

		case "stale": {
			this.#emit({ type: "hit", key: id, state: "stale", age: decision.age });
			this.#refresh(id, entry, action);
			return { value: decision.value, state: "stale", age: decision.age };
		}

		case "retained": {
			try {
				return await this.#call(id, entry, action);
			} catch {
				this.#emit({ type: "served-stale", key: id, age: decision.age });
				this.#emit({
					type: "hit",
					key: id,
					state: "retained",
					age: decision.age,
				});
				return { value: decision.value, state: "retained", age: decision.age };
			}
		}

		case "miss": {
			return await this.#call(id, entry, action);
		}
		}
	}

	/**
	 * What the store holds, without calling anything and without triggering a
	 * refresh. `undefined` when nothing readable is there.
	 */
	async peek(key: string): Promise<Result<T> | undefined> {
		const id = this.#id(key);
		const decision = decide(await this.#get(id), this.#now());
		if (decision.state === "miss") return undefined;
		return { value: decision.value, state: decision.state, age: decision.age };
	}

	/**
	 * Drop one key. This is the mechanism; deciding when a write made a read
	 * wrong is the caller's, because a cache cannot see it.
	 */
	async forget(key: string): Promise<void> {
		const id = this.#id(key);
		try {
			await this.#store.delete(id);
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "delete", error });
		}
	}

	/**
	 * Empty the store. Optional on the `Store` interface and potentially O(n).
	 * A store shared by several caches is cleared entirely, namespace or not.
	 */
	async clear(): Promise<void> {
		const clear = this.#store.clear;
		if (clear === undefined) {
			throw new RepletesError(
				"clear-unsupported",
				"this store does not implement clear()"
			);
		}
		try {
			await clear.call(this.#store);
		} catch (error) {
			this.#emit({ type: "store-error", key: "", operation: "clear", error });
		}
	}

	/**
	 * Resolves once no background refresh is in flight. For tests and for
	 * shutdown; a caller never has to await a refresh to get an answer.
	 */
	async settled(): Promise<void> {
		while (this.#refreshing.size > 0) {
			await Promise.all([...this.#refreshing.values()]);
		}
	}

	#id(key: string): string {
		if (typeof key !== "string" || key === "") {
			throw new RepletesError(
				"invalid-key",
				`key must be a non-empty string, received ${String(key)}`
			);
		}
		return this.#prefix + key;
	}

	async #call(
		id: string,
		previous: Entry<T> | undefined,
		action: Action<T>
	): Promise<Result<T>> {
		let value: T;
		try {
			value = await action(previous);
		} catch (error) {
			this.#emit({ type: "action-error", key: id, error, background: false });
			throw error;
		}

		// The miss is why the write happens, so it is reported first. Exactly one
		// of hit or miss is emitted per read that returns a value.
		this.#emit({ type: "miss", key: id });
		await this.#write(id, value);
		return { value, state: "miss", age: 0 };
	}

	#refresh(id: string, previous: Entry<T> | undefined, action: Action<T>): void {
		if (this.#refreshing.has(id)) return;

		const task = (async (): Promise<void> => {
			try {
				const value = await action(previous);
				await this.#write(id, value);
				this.#emit({ type: "refresh", key: id, ok: true });
			} catch (error) {
				this.#emit({ type: "action-error", key: id, error, background: true });
				this.#emit({ type: "refresh", key: id, ok: false });
			}
		})().finally(() => {
			this.#refreshing.delete(id);
		});

		this.#refreshing.set(id, task);
	}

	async #get(id: string): Promise<Entry<T> | undefined> {
		try {
			return await this.#store.get(id);
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "get", error });
			return undefined;
		}
	}

	async #write(id: string, value: T): Promise<void> {
		const windows = this.#freshness(value);
		if (windows === undefined) {
			this.#emit({ type: "skip", key: id });
			return;
		}

		const checked = assertWindows(windows);
		const retainFor = retentionFor(checked);
		if (retainFor <= 0) {
			this.#emit({ type: "skip", key: id });
			return;
		}

		const entry: Entry<T> = { value, storedAt: this.#now(), ...checked };
		try {
			await this.#store.set(id, entry, retainFor);
			this.#emit({ type: "write", key: id, retainFor });
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "set", error });
		}
	}

	#emit(event: Event): void {
		if (this.#onEvent === undefined) return;
		try {
			this.#onEvent(event);
		} catch {
			// A listener is an observer. It does not get to fail a read.
		}
	}
}
