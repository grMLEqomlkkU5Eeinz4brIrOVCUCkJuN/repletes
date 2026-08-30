import type { Decision, Entry } from "./types.js";

/**
 * The whole policy, over one entry, at one instant.
 *
 * | State | Condition | What a read does |
 * | --- | --- | --- |
 * | fresh | `age <= freshFor` | serves, no work |
 * | stale | within `freshFor + staleWhileRevalidate` | serves now, refreshes behind |
 * | retained | within `freshFor + staleIfError` | serves only if the action failed |
 * | miss | beyond retention, or absent | calls the action |
 *
 * A clock that went backwards is treated as an entry stored this instant. A
 * store handing back something from the future is not a reason to throw.
 */
export function decide<T>(entry: Entry<T> | undefined, now: number): Decision<T> {
	if (entry === undefined) return { state: "miss" };

	const age = Math.max(0, now - entry.storedAt);
	const value = entry.value;

	if (age <= entry.freshFor) return { state: "fresh", value, age };
	if (age <= entry.freshFor + entry.staleWhileRevalidate) {
		return { state: "stale", value, age };
	}
	if (age <= entry.freshFor + entry.staleIfError) {
		return { state: "retained", value, age };
	}
	return { state: "miss" };
}