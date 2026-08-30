# Repletes (Coming Soon)
![repletes logo](https://github.com/Smiduweorc/Repletes/raw/master/assets/logo.png)

Repletes is a cache policy engine for arbitrary async computations. You supply the key, store, and freshness/retention windows; Repletes decides whether to serve, refresh, replace, or rethrow. Its stale-while-revalidate and stale-if-error semantics are inspired by RFC 5861.

It has no dependencies, no `node:` imports, and one entry point.

## Repletes Does/Does Nots

| Repletes Owns | Not Repletes |
|---|---|
| The read decision: fresh -> serve, stale -> serve and refresh behind, retained -> serve only if the action failed, otherwise miss | Key derivation, normalization, hashing |
| The windows, measured from storedAt against a clock you can swap in tests | Eviction for capacity, which is the store's |
| Retention math: freshFor + max(swr, sie) going into the store, re-checked coming out | Deciding when to invalidate, which is the caller's |
| Background refresh: one per key, never awaited, never an unhandled rejection, existing entry left intact if it fails | Retries, deadlines, dedup, which are Firefly's |
| Stale-if-error: catch, decide, rethrow the original error untouched | Hash-as-key |
| Writing once per completed action, and never writing a failure unless asked | Transport: fetching, serialising responses, talking to a store |
| The Store interface, plus MemoryStore | |
| Namespace and version prefixing on keys | |
| forget(key) and clear() as mechanisms | |
| onEvent | |

### Design Sidenotes
When I was working on my own project, I felt that I was perhaps too pedantic when it came to how stale-if-error was handled. I wanted something that could clearly communicate whether something returned was fresh or if it was just fallback stale data due to failures upstream somewhere. I want people to think of this library more so for the cache policies and less so the storage mechanism. This is NOT an HTTP cache, and it does not ship a transport: `fromCacheControl` reads `Cache-Control` off anything shaped like a response, but fetching, serialising and storing are yours.

### About keys

Repletes doesn't care what the key looks like. A URL, a UUID, whatever: it all works the same. No hashing, no normalization, no derivation logic lives here.

If you're using content-addressed keys (where the key is derived from the content), that's on you. The upside: the entry can never go stale since the content determines the key. The downside: Repletes has no way to detect a collision if you hash wrong. That risk is yours now, not ours.

### API details

- `wrap(key, action)` returns the value; `read(key, action)` returns the value plus the state it came from, so a caller can tell a fresh answer from one that survived an upstream failure.
- `peek(key)` reads the store without calling the action and without triggering a refresh.
- `forget(key)` and `clear()` are mechanisms, not policy. `clear()` throws `clear-unsupported` on a store that does not implement it.
- `settled()` resolves once no background refresh is in flight. For tests and for shutdown; a caller never has to await a refresh to get an answer.
- Keys are plain strings. Hashing a request body is async, so if your key derives from a body, await it yourself before calling `wrap`.

### Things Repletes deliberately does not do

- **No single-flight on a miss.** Concurrent misses on the same key each call the action. Only the background refresh behind a stale read is deduplicated, one per key. Coalescing in-flight work is a concurrency concern, and it belongs in the layer that also owns retries and deadlines.
- **No way to prime the cache directly.** There is no `put`. Every stored value is the result of an action that ran, so an entry's windows always describe something that actually completed.
- **No capacity policy of its own.** `MemoryStore` evicts LRU past `maxEntries`, but that is the store's business. The read decision is made from the entry's own windows, never from whether a store still happens to hold it.

### Random Lore
Repletes are not actually a species of insects and the logo isn't really accurate. Repletes refer to a caste of ants that act as living food storage tanks for their colony. This happens to only rough 20 different species out of the thousands of different ant species.
