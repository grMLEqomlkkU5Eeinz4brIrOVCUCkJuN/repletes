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

// "miss" means that the value came from the action, not the structutre.
export type ReadState = "fresh" | "stale" | "retained" | "miss";

// decision per entry
export type Decision<T> =
	| { state: "fresh"; value: T; age: number }
	| { state: "stale"; value: T; age: number }
	| { state: "retained"; value: T; age: number }
	| { state: "miss" };

// will be used to decide whether if this is worth storing + how long it would stay (undefined will decline the write)
export type Freshness<T> = (value: T) => Windows | undefined;

