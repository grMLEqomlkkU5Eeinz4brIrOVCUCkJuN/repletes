/**
 * Every duration in repletes is milliseconds, measured against the clock the
 * {@link Cache} was constructed with. There are no defaults: freshness is a
 * property of your data, so all three numbers are required.
 */
export interface Windows { // hee hee windows
	freshFor: number;
	staleWhileRevalidate: number;
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