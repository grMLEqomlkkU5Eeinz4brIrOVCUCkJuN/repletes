import type { Freshness, Windows } from "./types.js";
import { assertWindows } from "./windows.js";


/**
 * simple factory that you can use to configure the cache's freshness policy
* ```ts
* fixed({ freshFor: 30_000, staleWhileRevalidate: 60_000, staleIfError: 300_000 })
* ```
 */
export function fixed<T = unknown>(windows: Windows): Freshness<T> {
	const frozen = assertWindows(windows);
	return () => frozen;
}
