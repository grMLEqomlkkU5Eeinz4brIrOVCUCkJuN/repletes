/**
 * Every duration in repletes is milliseconds, measured against the clock the
 * {@link Cache} was constructed with. There are no defaults: freshness is a
 * property of your data, so all three numbers are required.
 */
export interface Windows { // hee hee windows
	/** How long a stored value answers a read outright. */
	freshFor: number;
	/** How long past `freshFor` a value is served while a refresh runs behind it. */
	staleWhileRevalidate: number;
	/** How long past `freshFor` a value is served, but only if the action failed. */
	staleIfError: number;
}

/**
 * This is what the store holds exactly. The window travel with the value rather than living on the cache, so the retention can be re-checked on the way out.
 * That said, the config change will never silently re-interpret wha is already written down.
 */
export interface Entry<T> extends Windows {
	value: T;
	/**Milliseconds, from the clock of whoevery wrote the entry*/
	storedAt: number;
}

/** "miss" means that the value came from the action, not the structutre. */
export type ReadState = "fresh" | "stale" | "retained" | "miss";

/** decision per entry */
export type Decision<T> =
	| { state: "fresh"; value: T; age: number }
	| { state: "stale"; value: T; age: number }
	| { state: "retained"; value: T; age: number }
	| { state: "miss" };

/** will be used to decide whether if this is worth storing + how long it would stay (undefined will decline the write) */
export type Freshness<T> = (value: T) => Windows | undefined;

/** `previous` refers to the entry that the store still holds. It will use undefined if the store holds nothing. */
export type Action<T> = (previous: Entry<T> | undefined) => T | Promise<T>;

/** value + where it came from */
export interface Result<T> {
	value: T;
	state: ReadState;
	/** milliseconds, only zero when it comes from the actions */
	age: number;
}

/**
 * to be used for turning an out of process {@link Store} entry into something it can hold.
 * repletes never calls this itself, but the store may use it to serialize and deserialize entries.
*/
export interface Codec<T, Wire = string> {
	encode(entry: Entry<T>): Wire | Promise<Wire>;
	decode(wire: Wire): Entry<T> | Promise<Entry<T>>;
}

/**
 * Where the bytes live. Async everywhere, including in memory, so that moving
 * from a process-local store to a networked one is a constructor change.
 */
export interface Store<T = unknown> {
	get(key: string): Promise<Entry<T> | undefined>;
	/**
	 * `retainFor` is `freshFor + max(swr, sie)`. Treat it as a hint for
	 * reclaiming space; repletes re-checks the windows on the way out and never
	 * trusts store expiry for correctness.
	 */
	set(key: string, entry: Entry<T>, retainFor: number): Promise<void>;
	delete(key: string): Promise<void>;
	/** Optional, and may be O(n) on a store that has to scan a key prefix. */
	clear?(): Promise<void>;
}

/**
 * Everything observable. Reported, never thrown.
 *
 * `action-error` and `store-error` carry what went wrong; the rest are facts
 * about what the cache did, so a listener counts them without unpacking an
 * error it does not need.
 */
export type Event =
	| { type: "hit"; key: string; state: "fresh" | "stale" | "retained"; age: number }
	| { type: "miss"; key: string }
	| { type: "write"; key: string; retainFor: number }
	| { type: "skip"; key: string }
	| { type: "refresh"; key: string; ok: boolean }
	| { type: "served-stale"; key: string; age: number }
	/**
	 * The action failed. Emitted wherever an action throws (on a miss before the
	 * error is rethrown, under a retained entry before it is served, and behind a
	 * stale read), so that upstream failure rate is one count rather than three.
	 * `background` marks the refresh case, which no caller awaited.
	 */
	| { type: "action-error"; key: string; error: unknown; background: boolean }
	| {
			type: "store-error";
			key: string;
			operation: "get" | "set" | "delete" | "clear";
			error: unknown;
	  };