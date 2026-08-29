import { RepletesError } from "./errors.js";
import type { Windows } from "./types.js";

const NAMES = ["freshFor", "staleWhileRevalidate", "staleIfError"] as const;

/** Rejects the numbers that would make the read decision meaningless. */
export function assertWindows(windows: Windows): Windows {
	for (const name of NAMES) {
		const value = windows[name];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new RepletesError(
				"invalid-windows",
				`${name} must be a finite number of milliseconds >= 0, received ${String(value)}`
			);
		}
	}
	return {
		freshFor: windows.freshFor,
		staleWhileRevalidate: windows.staleWhileRevalidate,
		staleIfError: windows.staleIfError,
	};
}

/** How long the store is asked to keep an entry: past this it can never be read. */
export function retentionFor(windows: Windows): number {
	return (
		windows.freshFor +
		Math.max(windows.staleWhileRevalidate, windows.staleIfError)
	);
}