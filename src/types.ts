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