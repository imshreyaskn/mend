# Correct by construction

Make whole classes of bugs impossible to write, using the cheapest technique that removes the class. Examples are TypeScript / React Native. The ideas carry to any typed language. Library versions were checked on 2026-11-26; confirm current versions with `vet-package.mjs` before adding anything.

## Contents
1. The ladder: pick the cheapest rung that removes the bug class
2. Types: unions, exhaustiveness, brands
3. Parse at trust boundaries
4. Lifecycle: pure reducer, effects at the edge
5. Assertions that stay on
6. Errors: throw for bugs, results for expected failures
7. Bounded everything: timeouts, retries, cleanup
8. Inject nondeterminism (clock, random, network)
9. Property and stateful tests
10. Formal models: only for protocols
11. Diff red-flag checklist

## 1. The ladder

| Rung | Technique | Use when | Skip when |
|---|---|---|---|
| 1 | Types: discriminated unions, brands for IDs and units, `readonly`, exhaustive `never` / `satisfies` | Always | Never; it costs almost nothing |
| 2 | Schema parsing at trust boundaries | Data crosses a network, storage, process or app-version boundary | Data already typed in-process; do not re-parse between your own modules |
| 3 | Pure reducer over a state union, effects at the edge | Anything with a lifecycle | Single independent flags |
| 4 | Assertions kept in production | Invariants types cannot express: ranges, cross-field relations, "cannot happen given the protocol" | Things the type system already guarantees |
| 5 | Property-based and stateful tests | Logic with invariants, encode/decode pairs, state machines, merging | Glue code and layout, or when the only property restates the implementation |
| 6 | Injected clock/random/network plus a scheduler in tests | Retries, timeouts, ordering, queues, sync, token refresh, native events | Pure rendering |
| 7 | STPA control-action table (in the plan) | Features that control real effects: audio out, sync, payment, delete, notify | Display-only features |
| 8 | Formal model (Quint, TLA+, P) | Multi-party protocols: offline sync, multi-device, leases | One device, one writer |

## 2. Types

**Illegal states unrepresentable.** Two booleans that interact are a union waiting to happen.

```ts
// Bad: most combinations are nonsense, and every consumer must guess which are real.
type PlayerBad = { isPlaying: boolean; isBuffering: boolean; trackId?: TrackId; positionMs?: number; error?: string };

// Good: each state carries exactly the fields valid in it.
type Player =
  | { kind: 'idle' }
  | { kind: 'loading'; track: TrackId; gen: number }
  | { kind: 'playing'; track: TrackId; positionMs: Ms }
  | { kind: 'paused'; track: TrackId; positionMs: Ms; reason: 'user' | 'interruption' | 'noisy' }
  | { kind: 'buffering'; track: TrackId; positionMs: Ms; resumeTo: 'playing' | 'paused' }
  | { kind: 'failed'; track: TrackId; error: PlayerError };
```

Recording *why* playback paused (`reason`) is what makes the resume rule correct. Boolean parameters (`play(true)`) become named options (`play({ from: 'start' })`).

**Exhaustiveness.** Adding a variant must break the build everywhere that has to handle it.

```ts
export function assertNever(x: never): never {
  // Log only the discriminant: the full value may hold tokens or personal data.
  throw new Error(`Unhandled variant: ${String((x as { kind?: unknown }).kind)}`);
}
switch (s.kind) { /* every case */ default: return assertNever(s); }

const label = { idle: '', loading: 'Loading', playing: 'Playing', paused: 'Paused', buffering: 'Buffering', failed: 'Error' }
  as const satisfies Record<Player['kind'], string>;
```

**Brands for IDs and units.** Mars Climate Orbiter was lost to pound-force seconds read as newton-seconds across a *file* boundary. So the unit must live in the boundary schema, and the schema must be the only way to make the branded value. Use **one** brand mechanism per codebase. A Zod brand (`number & z.$brand<'Ms'>`) and a hand-written brand are different types, and mixing them forces the casts this skill forbids.

```ts
// With Zod: the schema is the brand's only constructor, at boundaries and inside the app alike.
export const Ms = z.number().int().nonnegative().brand<'Ms'>();
export type Ms = z.infer<typeof Ms>;
export const TrackId = z.string().min(1).brand<'TrackId'>();
export type TrackId = z.infer<typeof TrackId>;
export const toMs = (seconds: number): Ms => Ms.parse(Math.round(seconds * 1000)); // throws on NaN or negative: a bug, not input

// Without Zod, the hand-written equivalent (pick one style, never both):
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
```

Brand entity IDs and physical or time units. Do not brand every string: noise without a real mix-up risk is over-engineering. Audio libraries commonly report seconds while JS timers use milliseconds, so that is a real mix-up risk worth a brand.

## 3. Parse, don't validate

A validator answers yes/no and throws the knowledge away. A parser returns a more precise type that carries the proof. Parse once where untrusted data enters; core code accepts only parsed types.

Trust boundaries in an app: HTTP responses, storage reads (MMKV, AsyncStorage, SQLite), deep links, push payloads, native module events, remote config, clipboard, and data persisted by an *older app version* (that last one is a migration problem).

```ts
import * as z from 'zod';
export const Episode = z.object({
  id: z.string().brand<'EpisodeId'>(),
  durationMs: z.number().int().nonnegative().brand<'Ms'>(),
  audioUrl: z.url(),
});
export type Episode = z.infer<typeof Episode>;
const parsed = Episode.safeParse(json);   // returns a result; never throws on bad input
```

Default to Zod 4 (small core, fast, best ecosystem). Use `zod/mini` or Valibot only when bundle size is *measured* to matter.

**Limits, with a decided over-limit behaviour.** Take size caps from documented upstream limits or measurements, with headroom, never invented. Then write down what happens when input exceeds them: reject that one item, keep the last good value, or degrade. Cloudflare's November 2025 outage is the warning in both directions. A feature file doubled in size, hit a hard limit, and the limit *crashed* the proxy instead of degrading (FP-38). A cap that throws, or that rejects a whole payload when the server legitimately grows, is an outage in waiting.

**Never throw on the launch path.** `JSON.parse` and `Schema.parse` both throw. At boundaries on startup or in background handlers, use a non-throwing parse and turn failure into a state:

```ts
export function parseJson<T>(text: string, schema: z.ZodType<T>): Result<T, ParseError> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: { kind: 'malformed' } }; }
  const r = schema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: { kind: 'invalid', issues: r.error.issues.map((i) => i.path.join('.')) } };
}
```

## 4. Lifecycle: pure reducer, effects at the edge

The reducer is a pure `(state, event) => state`. A separate function maps transitions to effects (native commands, storage writes). Pure reducers can be tested with thousands of random event sequences in milliseconds.

```ts
export function reduce(s: Player, e: PlayerEvent): Player {
  switch (s.kind) {
    case 'playing':
      switch (e.type) {
        case 'PAUSE':           return { kind: 'paused', track: s.track, positionMs: s.positionMs, reason: 'user' };
        case 'INTERRUPT_BEGAN': return { kind: 'paused', track: s.track, positionMs: s.positionMs, reason: 'interruption' };
        case 'STALL':           return { kind: 'buffering', track: s.track, positionMs: s.positionMs, resumeTo: 'playing' };
        case 'ERROR':           return { kind: 'failed', track: s.track, error: e.error };
        default:                return s; // explicitly ignored in this state
      }
    case 'paused':
      // Build the next state explicitly. `{ ...s, kind: 'playing' }` would compile and carry the stale `reason` along.
      if (e.type === 'INTERRUPT_ENDED') return s.reason === 'interruption' && e.shouldResume ? { kind: 'playing', track: s.track, positionMs: s.positionMs } : s;
      return s;
    case 'loading':
      if (e.type === 'LOADED' && e.gen !== s.gen) return s; // stale completion from an earlier load: drop it
      // ... handle the current LOADED, ERROR, etc.
      return s;
    // ... every remaining state, each ending in a return
    default: return assertNever(s);
  }
}
```

**Generation tokens** (`gen`) or an `AbortSignal` on every async command make stale completions harmless. Otherwise a slow earlier response lands after a newer user action, which is the most common lifecycle bug.

Reach for XState v5 only for nested or parallel states, `after` timers, actors that must auto-cancel, or roughly ten or more guarded transitions. Below that, the reducer is simpler. (The threshold is a judgement call, not a measured result.)

## 5. Assertions that stay on

JPL kept assertions enabled in flight; a failed assertion sent the spacecraft to a known safe state. Aim for meaningful assertions on every invariant a type cannot express (Power of Ten suggests about two per non-trivial function; treat that as a guide, not a quota). Keep the messages in production builds, and never put secrets or personal data in them.

```ts
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { const e = new Error(`Assertion failed: ${msg}`); reportError(e); throw e; } // msg: a fixed string plus non-sensitive ids only
}
```

**Where the throw lands decides whether it is safe.** React error boundaries catch errors thrown during render and in code render calls, such as reducers run by `useReducer`. They do **not** catch errors in event handlers, promises, timers, or native event listeners, which is where most I/O and lifecycle code runs. In a React Native release build, an uncaught synchronous throw in a native callback crashes the app, and an async throw becomes an unhandled rejection. So:
- **Render and reducer code:** let the assertion throw. Place an error boundary per screen that resets that screen's state.
- **Async, event, timer and listener code:** catch at the edge of the effect or service, report it, and move the state machine to its `failed` state. Do not let it escape.
- Do not limp on with corrupted state in either case.

- **Pair assertions** (TigerBeetle): a contract between caller and callee is asserted on *both* sides. A bug must slip past two independent checks.
- **Assert the negative space:** check what must *not* be true as well as what must be ("queue contains no duplicate ids", "position ≤ duration").
- **Bound assertions in loops:** a loop that "should" run at most n times asserts it ran fewer than a generous multiple of n.
- **Every test executes at least one assertion.** A test with no `expect` proves only that nothing threw.

## 6. Errors

- **Throw for bugs** (violated invariants).
- **Return a result for expected failures** the caller must handle: offline, timeout, validation, permission. Map the error union to UI exhaustively.
- **Define errors out of existence** where the semantics allow (Ousterhout). Deleting something already gone is a no-op. Clamping an out-of-range seek is correct behaviour.
- A Result type in every signature is noise. Use one only where the caller has real decisions to make.

```ts
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export type FetchError =
  | { kind: 'offline' } | { kind: 'timeout' } | { kind: 'aborted' }
  | { kind: 'http'; status: number } | { kind: 'parse'; issues: readonly string[] };
```

Chain causes when rethrowing: `throw new Error('saving recording', { cause: e })`.

## 7. Bounded everything

Power of Ten rule 2, generalised: every loop, retry, queue, cache, payload and wait has a number.

**Timeouts and cancellation.** Every I/O call takes a signal and has a timeout.

```ts
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
const res = await fetch(url, { signal });
```

Recent React Native has `AbortSignal.timeout` and `AbortSignal.any` built in (in-tree since mid-2026; Expo SDK 58 dropped its polyfills). Check the project's React Native version before relying on them.

**Retries.** Retry only transient errors, and only for idempotent operations (GET, or writes carrying an idempotency key). Use full-jitter backoff with a cap on both attempts and total time. p-retry's defaults (10 retries, no jitter, no maximum time) are too aggressive for mobile; if you use it, set `retries`, `maxTimeout`, `maxRetryTime`, `randomize: true` and `signal`.

```ts
export async function retry<T>(fn: (signal: AbortSignal) => Promise<T>, o: {
  signal: AbortSignal; retryable: (e: unknown) => boolean; attempts: number; baseMs: number; capMs: number; env: Pick<Env, 'random' | 'sleep'>;
}): Promise<T> {
  assert(o.attempts >= 1 && o.attempts <= 10, 'retry attempts out of range');
  let lastError: unknown;
  for (let attempt = 0; attempt < o.attempts; attempt += 1) {      // explicit upper bound
    try { return await fn(o.signal); } catch (e) {
      lastError = e;
      if (o.signal.aborted || !o.retryable(e) || attempt === o.attempts - 1) break;
      await o.env.sleep(o.env.random() * Math.min(o.capMs, o.baseMs * 2 ** attempt), o.signal); // full jitter
    }
  }
  throw lastError;
}
```

**Effect cleanup.** Every subscription, listener, timer and in-flight request started in an effect is undone in its cleanup. React's StrictMode double-mount in development exists to expose missing cleanup.

```ts
useEffect(() => {
  const ac = new AbortController();
  load(id, ac.signal).then(setData, (e) => { if (!ac.signal.aborted) setError(e); });
  const sub = AppState.addEventListener('change', onAppState);
  return () => { ac.abort(); sub.remove(); };
}, [id]);
```

**Runtime reality (React Native).** Jest runs on Node, which has APIs Hermes may lack (`structuredClone`, `crypto.randomUUID`), so a green test can hide a crash on the device. Confirm built-ins on a development build. Consider deleting such globals in the Jest setup file (`delete globalThis.structuredClone`) so tests fail the way the app would.

**App lifecycle (React Native).** AppState states are `active`, `background`, and `inactive` (iOS only). `memoryWarning` is iOS only; Android has no JS memory event. On `background`, persist critical state and stop non-essential work. Never assume a later foreground or interruption-ended event will arrive.

## 8. Inject nondeterminism

FoundationDB and TigerBeetle find bugs that years of normal testing miss by routing all time, randomness and I/O through one interface, then driving it from a seeded simulator. At app scale, the cheap 80% is one injected port:

```ts
export interface Env {
  now(): number;                                 // wall clock, for timestamps shown to humans
  monotonic(): number;                           // performance.now(), for durations
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
```

In tests, a fake network drops, duplicates, delays and reorders replies under `fc.scheduler()`. That gives replayable seeds and automatic shrinking to the smallest failing sequence. Use it for sync, upload queues, token refresh and player event handling.

## 9. Property and stateful tests (fast-check)

Turn each requirement containing *always*, *never*, *for any* or *must* into one property:

| Pattern | Property | Typical use |
|---|---|---|
| Round-trip | `decode(encode(x))` equals `x` | Storage, URL params, serialisation |
| Invariant | Every operation preserves the invariant | Queues, positions, balances |
| Oracle | Matches a dumb reference implementation | Caches, ring buffers, sorting |
| Idempotence | `f(f(x))` equals `f(x)` | Normalise, dedupe, apply sync op twice |
| Convergence | Same ops in any order give the same state | Merge, sync, CRDT-like logic |
| Metamorphic | A known relation between two runs | Adding an item increases count by one |
| Totality | Never throws on any input; returns a result | Parsers on `fc.jsonValue()` |
| Stateful | Random command sequences keep the invariants | Reducers, players, outboxes |

```ts
test('REQ-PLAY-012: player invariants hold for any event sequence', () => {
  fc.assert(fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
    let s: Player = { kind: 'idle' };
    for (const e of events) { const prev = s; s = reduce(s, e); checkInvariants(prev, e, s); }
  }));
});
```

For impure objects, use `fc.commands` with `fc.modelRun`, `fc.asyncModelRun` or `fc.scheduledModelRun` (the last one finds races). On the scheduler, `waitAll`, `waitOne` and `count` are deprecated; use `waitIdle`, `waitFor` and `waitNext`. For XState, `createTestModel` now lives in `xstate/graph` (`@xstate/graph` is deprecated).

Never re-implement the function under test inside the test. That is a tautology, not a property.

## 10. Formal models

AWS used TLA+ to find a DynamoDB replication bug whose shortest trigger was 35 steps, and in 2025 used the P language to check S3's strong-consistency protocol. Engineers became productive in two to three weeks. For an app team, the smallest worthwhile model is the **offline outbox**: two clients, one server, and a network that drops, duplicates and reorders. Check three invariants: no acknowledged write is lost, no operation is applied twice, and no deleted item comes back. Quint has the friendliest syntax for TypeScript engineers. Carry each invariant back into code as a property test and an assertion; that bridge is where the value lands. Skip formal models for CRUD screens and single-device state.

## 11. Diff red-flag checklist

Run it on your own diff before declaring a phase done. Each item is checkable.

1. A new boolean field or parameter, or two booleans that interact. Make it a union or a named option.
2. `as`, `!` or `any` outside a boundary parser or brand constructor.
3. Re-validation of already-parsed data in core code, or `JSON.parse` / `unknown` used without a schema.
4. A switch or if-chain over a union with no `assertNever` or `satisfies Record<...>`.
5. A shallow module or pass-through: a function whose signature is as complex as its body, or that only forwards its arguments.
6. Information leakage: two places that know the same format, key, unit or protocol detail.
7. Temporal decomposition: modules split by execution order (fetch, transform, save) instead of by what they know.
8. Overexposure: a new optional parameter or config flag most callers now have to understand.
9. A new error path that could be defined away (clamp, make idempotent, no-op on missing).
10. Cognitive complexity over 15 or nesting deeper than 3 in a touched function.
11. Tidying mixed into a behaviour commit.
12. Speculative generality: an abstraction, generic or plugin point with one caller.
13. An effect with no cleanup: listener without remove, timer without clear, fetch without signal.
14. Anything unbounded: retries, cache, queue, I/O without a timeout, loop without a bound.
15. Something you cannot name or describe in one sentence. The decomposition is wrong.
16. A comment that repeats the code, or no comment where a unit, invariant or "why" is non-obvious.
