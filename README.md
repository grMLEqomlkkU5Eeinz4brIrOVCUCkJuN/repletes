# Repletes (Coming Soon)
![repletes logo](https://github.com/Smiduweorc/Repletes/raw/master/assets/logo.png)

Repletes is a cache policy engine for arbitrary async computations. You supply the key, store, and freshness/retention windows; Repletes decides whether to serve, refresh, replace, or rethrow. Its stale-while-revalidate and stale-if-error semantics are inspired by RFC 5861, with optional HTTP response support.

## Repletes Does/Does Nots

| Repletes Owns | Not Repletes |
|---|---|
| The read decision: fresh -> serve, stale -> serve and refresh behind, retained -> serve only if the action failed, otherwise miss | Key derivation, normalization, hashing |
| The windows, measured from storedAt against a clock you can swap in tests | Eviction for capacity, which is the store's |
| Retention math: freshFor + max(swr, sie) going into the store, re-checked coming out | Deciding when to invalidate, which is the caller's |
| Background refresh: one per key, never awaited, never an unhandled rejection, existing entry left intact if it fails | Retries, deadlines, dedup, which are Firefly's |
| Stale-if-error: catch, decide, rethrow the original error untouched | Hash-as-key |
| Writing once per completed action, and never writing a failure unless asked | |
| The Store interface, plus MemoryStore | |
| Namespace and version prefixing on keys | |
| forget(key) and clear() as mechanisms | |
| onEvent | |
| HTTP half: clone before storing, serialise status/headers/bytes, drop Set-Cookie and hop-by-hop headers, hand each caller a fresh Response, and treat a 304 as refresh-the-timestamps rather than replace-the-body | |

### Design Sidenotes
When I was working on my own project, I felt that I was perhaps too pedantic when it came to how stale-if-error was handled. I wanted something that could clearly communitycate whether something returned was freshed or if it was just fallback stale data due to failures upstream somewhere. I want people to think this library more so for the cache policies and less so the storage mecahnism. Also this is NOT a http cache, it just happens to have a transport that supports it.

### About keys

Repletes doesn't care what the key looks like. A URL, a UUID, whatever: it all works the same. No hashing, no normalization, no derivation logic lives here.

If you're using content-addressed keys (where the key is derived from the content), that's on you. The upside: the entry can never go stale since the content determines the key. The downside: Repletes has no way to detect a collision if you hash wrong. That risk is yours now, not ours.

### API details

Hashing a request body is async, so here's how it shakes out:

- `wrap(key: string, action)` takes a plain string. Hash the body yourself if you need to.
- The HTTP transport's `key(request)` can return either `string` or `Promise<string>`.
- Repletes clones the request before handing it to `key()`, otherwise the body gets consumed and you've got nothing left to send.

### Random Lore
Repletes are not actually a species of insects and the logo isn't really accurate. Repletes refer to a caste of ants that act as living food storage tanks for their colony. This happens to only rough 20 different species out of the thousands of different ant species.
