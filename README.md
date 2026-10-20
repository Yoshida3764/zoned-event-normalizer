# Zoned Event Normalizer

Converts a local time with a timezone identifier into the correct UTC epoch milliseconds, handling ambiguous and non-existent times during DST transitions.

```js
import { normalizeZonedTime } from 'zoned-event-normalizer';

const { epochMillis, outcome } = normalizeZonedTime('2024-11-03T01:30', 'America/New_York');
// outcome === 'earlier'  (fall-back DST: 01:30 happened twice, we pick the first)
// epochMillis === 1721051400000
```

`normalizeZonedTime(localDateTime: string, timeZone: string)` returns
`{ epochMillis: number, outcome: 'unique' | 'earlier' | 'gap' }`.

- `unique` — the local time maps to exactly one UTC instant.
- `earlier` — the local time was ambiguous (fall-back); resolved to the earlier
  of the two possible instants.
- `gap` — the local time did not exist (spring-forward); resolved to the first
  real instant after the gap, i.e. the wall time advanced by the gap duration.

`ResolvedTime` is also exported as the list of possible outcome strings.

## Why this exists

Scheduling systems that ingest "local time + zone" need a deterministic UTC
stamp. `Date` and `Intl` give you the offsets but not a policy for the two DST
edge cases, and they do not tell you which case you hit. This library fixes one
policy and reports which case occurred.

The trade-off: we rely on the host platform's timezone data via
`Intl.DateTimeFormat`. We do not bundle tzdata, so the library is small and
zero-dependency, but results depend on the platform's zone rules being current.
For historical timestamps in zones that have changed their rules, you need a
platform with up-to-date tzdata.

## The awkward edge you will hit

For a spring-forward gap (e.g. `2024-03-10T02:30` in `America/New_York`), there
is no "correct" answer — the local time never happened. This library advances
the wall time into the post-transition real time and returns `outcome: 'gap'`.
If you need to reject gaps instead, check `outcome` and throw.

For fall-back ambiguity, we always pick the earlier occurrence. There is no
option to pick the later one; wrap the call if you need that policy.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

