/** A clock the tests move by hand. No `setTimeout` waits anywhere in the suite. */
export function clock(start = 1_000_000): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let current = start;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

/** Windows in milliseconds, small enough to read at a glance. */
export const WINDOWS = {
	freshFor: 100,
	staleWhileRevalidate: 100,
	staleIfError: 400,
};
