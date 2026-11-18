# @zinc/plugin-sdk (JS)

SDK for Zinc WASM plugins written in JavaScript (QuickJS, built by `scripts/build.ts`). See `src/index.ts` for the exports.

## Globals in a Zinc JS plugin

A QuickJS guest has no WASI clock, no console and no web APIs. `scripts/build.ts` prepends `src/prelude.js` to every plugin;
it patches the globals below (nothing runs a clock call at install time, so the wizer snapshot is clean) and skips any that already exist.

| Global | State |
| --- | --- |
| `Date.now()`, `new Date()`, `Date()` | Patched: read `timers.now()` (these trapped with `wasm unreachable` before). `new Date(x)`, `Date.parse`, `Date.UTC`, `instanceof Date`, subclassing, `toISOString`, `toLocale*` work. |
| `performance.now()` | Patched: `timers.monotonicMs()`, ms since first call (it trapped before). `performance.timeOrigin` is wall time of that origin. |
| `console.log/info/warn/error/debug/trace/assert` | Added: lines go to `log.write` (info/info/warn/error/debug). Objects are JSON-stringified. |
| `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` | Added, over `timers.set-timeout/set-interval/clear`. They fire through `events.onTimer`, which `definePlugin` routes first; ids it does not own reach your own `onTimer`. Needs `definePlugin` (a hand-written `events` export would not fire them). Delays are host-side: 64 timers per plugin, minimum 10 ms for intervals. |
| `TextEncoder`, `TextDecoder` | Added, UTF-8 only (`encodeInto`, `fatal`, `ignoreBOM` supported; other labels throw `RangeError`). Streaming decode is not supported. |
| `Math.random`, `JSON`, `Promise`, `queueMicrotask`, `Intl`-backed `toLocale*` | Native, already work. |
| `URL`, `URLSearchParams`, `structuredClone`, `fetch`, `AbortController`, `setImmediate`, `requestIdleCallback` | Not available. Use `net` (`zinc:plugin/net`) for HTTP, `timers.requestIdle` for idle callbacks, `JSON` round-trips for cloning. |

Tests: `bun test` (unit tests on a sandbox global, plus `test/prelude.built.test.ts`, which builds `test/fixtures/globals-probe` into a real component and runs each global inside it).
