import type { Freshness, Windows } from "./types.js";
import { assertWindows } from "./windows.js";

/**
 * Freshness from numbers you chose. The default path.
 *
 * ```ts
 * fixed({ freshFor: 30_000, staleWhileRevalidate: 60_000, staleIfError: 300_000 })
 * ```
 */
export function fixed<T = unknown>(windows: Windows): Freshness<T> {
	const frozen = assertWindows(windows);
	return () => frozen;
}
