# Duct-tape registry

Duct tape is any change that makes a symptom disappear without making the system correct. It always looks cheaper than the real fix. It is never cheaper. Each item comes with what it hides and what to do instead. `[scan: id]` means `ducttape-scan.mjs` flags it automatically; everything else you have to catch yourself in self-review.

If the real fix is out of scope, do not tape it. Stop and record it as a finding with a ticket, or ask. A visible gap is honest. A taped one is a lie the next person inherits.

## Contents
1. Type system
2. Errors and failure
3. Async, timing and concurrency
4. Tests
5. Data, time and numbers
6. Dependencies, config and tooling
7. React / React Native
8. Process tape

## 1. Type system

| Tape | What it hides | Do instead |
|---|---|---|
| `as any`, `: any` `[scan: any-type]` | The real shape of the data is unknown or wrong | Model the type. Use `unknown` and narrow at the boundary, or parse with a schema |
| `as unknown as T` `[scan: double-cast]` | Two types that do not fit, forced together | Fix the producer's type or convert explicitly |
| `value!` `[scan: non-null-assertion]` | A missing-value path nobody handled | Narrow with a check, or restructure so absence is impossible. If it truly cannot be absent, `invariant(value, 'why it cannot be absent')` |
| `@ts-ignore`, `@ts-nocheck` `[scan: ts-suppress]` | A type error, which is often a real bug | Fix it. For a wrong third-party type, use `@ts-expect-error <reason> <issue link>` so it fails loudly once fixed upstream |
| Optional chaining everywhere (`a?.b?.c?.d`) | A data model where everything is maybe-absent, which is rarely true | Make required fields required. Parse once at the edge, then trust the type inside |
| `Partial<T>` or optional props added to make a call compile | A caller that does not have what the function needs | Change the call site or split the type into its real states |
| Boolean flag soup (`isLoading`, `isError`, `hasData`) | Impossible combinations the UI must still render | One discriminated union: `{ status: 'loading' } \| { status: 'error'; error } \| { status: 'ready'; data }` |
| Widening a union to `string` | Values the code cannot handle | Keep the literal union and handle each member exhaustively (`never` check) |

## 2. Errors and failure

| Tape | What it hides | Do instead |
|---|---|---|
| `catch {}` / `catch (e) {}` `[scan: empty-catch]` | Every failure on that path, forever | Handle it, return a typed error, or rethrow with context: `throw new Error('loading track', { cause: e })` |
| `.catch(() => {})` `[scan: swallowed-promise]` | A rejected promise | Decide what the user or caller should see, then do that |
| `catch (e) { console.error(e) }` `[scan: log-and-swallow]` | The failure, behind a log nobody reads | Same as above. Logging is not handling |
| `\|\| defaultValue` on data that should exist | Bugs upstream that produce `undefined`, `0` or `''` | Use `??` only where a default is correct by design, and say why. Otherwise fail fast |
| Catch-all retry ("just retry it") | Non-transient errors (bad input, auth), and retry storms | Retry only errors known to be transient. Bound attempts, use backoff with jitter, and keep a total deadline |
| Returning `null` / `[]` on failure | The difference between "nothing there" and "it broke" | Return a result type or throw. Empty and failed are different states |
| Generic `throw new Error('failed')` | Which operation failed and why | Name the operation and the input that failed, and chain the cause |
| Silent fallback to a "safe" value | A broken invariant | If the fallback is a real product decision, write it down. Otherwise assert |

## 3. Async, timing and concurrency

| Tape | What it hides | Do instead |
|---|---|---|
| `setTimeout(fn, 0)` or a small delay to "let things settle" `[scan: timer-as-sync]` | An ordering bug | Await the event or promise that actually signals readiness, or model the state |
| Raising a timeout until the flake stops | A slow or hung dependency, or a race | Find what is slow. Set timeouts from measured budgets, and handle the timeout path |
| `while (true)` polling `[scan: unbounded-loop]` | No upper bound on work or time | Cap the iterations or set a deadline (`AbortSignal.timeout(ms)`), and handle hitting it |
| Floating promise (no `await`, no `.catch`) | Unhandled rejections and lost ordering | Await it, return it, or `void` it with a comment saying why fire-and-forget is correct |
| A flag to block re-entry (`if (busy) return`) bolted on | A state machine nobody modelled | Model the states and transitions explicitly. Make illegal transitions impossible |
| Debounce added to stop a double-submit | Non-idempotent operations | Make the operation idempotent (idempotency key), then debounce for UX only if still wanted |

## 4. Tests

| Tape | What it hides | Do instead |
|---|---|---|
| `.skip`, `.only`, `xit` `[scan: focused-or-skipped-test]` | What the suite no longer checks | Fix the test against the requirement, or stop and report that the test or requirement is wrong. The scan does not accept inline waivers for this rule |
| `it.todo('REQ-...')` or a comment naming a requirement, to make traceability pass | That the requirement has no test | `trace-check` ignores both. Write the real test, or report the requirement as not yet verified |
| Deleting or weakening an assertion `[scan: assertion-removed]` | A regression | Only change an assertion when a requirement changed, and name that requirement in the commit |
| Editing the expected value to match the new output | Exactly the bug the test exists to catch | Decide from the requirement which side is wrong. Never let the code under test decide |
| `sleep` / fixed waits in tests `[scan: sleep-in-test]` | Races, plus slow and flaky runs | Fake timers, or wait for the observable condition |
| Mocking the unit under test, or mocking so deep the test checks the mock | That nothing real is verified | Mock only at process or network boundaries. Prefer fakes with real behaviour |
| Snapshot update with `-u` without reading it `[scan: snapshot-changed]` | Any change at all, approved blindly | Read the snapshot diff. If it is too big to read, the snapshot is too big |
| Special-casing test inputs in production code | That the code is wrong for every other input | Never. Add a property-based test to make this impossible to get away with |
| Retrying a flaky test in CI | A race or a hidden dependency on order or time | Reproduce the flake (run it 50 times), find the cause, fix it |

## 5. Data, time and numbers

| Tape | What it hides | Do instead |
|---|---|---|
| `JSON.parse(x)` used as a typed value `[scan: json-parse-unvalidated]` | Malformed server data or config | Parse with a schema where the data enters. On startup and in background handlers, never throw: use a non-throwing helper (`parseJson` in correct-by-construction.md) and turn failure into a state |
| An invented size limit that throws or rejects the whole payload | The outage it causes when real data grows (Cloudflare Nov 2025) | Take limits from documented upstream limits with headroom, and decide the over-limit behaviour: reject the item, keep last-known-good, or degrade |
| `Date.now() - start` for durations `[scan: wall-clock-duration]` | Clock jumps (NTP sync, manual change, leap second) | Use `performance.now()` for elapsed time. Use wall clock only for timestamps shown to humans |
| Plain `number` for seconds vs milliseconds, or one unit vs another | Unit mix-ups (Mars Climate Orbiter) | Branded unit types (`Ms`, `Seconds`) or one unit everywhere, named in the identifier (`timeoutMs`) |
| Plain `string` for IDs of different kinds | Passing a trackId where a userId is expected | Branded ID types |
| `parseInt(x)` / `Number(x)` without checks | `NaN` flowing through arithmetic | Validate with the schema, and check `Number.isFinite` / `Number.isSafeInteger` |
| Float arithmetic for money | Rounding drift | Integer minor units, or a decimal library |
| `Math.random()` for IDs or tokens `[scan: insecure-random]` | Collisions and predictability | `crypto.randomUUID()` / `crypto.getRandomValues()`. React Native and Hermes do not provide `crypto.randomUUID`, so use `expo-crypto`'s `randomUUID()` there |
| `x \| 0`, `~~x`, `>>> 0` to make an integer `[scan: bitwise-truncation]` | Silent wrap above 2^31 (Ariane 5's overflow, Y2038) | `Math.trunc` plus a range assertion, or an integer type that cannot overflow in this product's range |
| `setFullYear(getFullYear() + 1)` and other field arithmetic `[scan: date-field-arithmetic]` | Feb 29 and month-end rollover (Azure 2012 leap-day outage) | A date library's `addYears` / `addMonths`, with tests on Feb 29 and Dec 31 in several time zones |
| Regex with nested quantifiers on user input `[scan: nested-quantifier-regex]` | Catastrophic backtracking (Cloudflare 2019) | Avoid nesting, anchor the pattern, cap input length, or parse without regex |

## 6. Dependencies, config and tooling

| Tape | What it hides | Do instead |
|---|---|---|
| `--legacy-peer-deps`, `npm i --force` `[scan: gate-bypass]` | Incompatible versions that will break at runtime | Resolve the conflict. With Expo, `npx expo install <pkg>` picks SDK-compatible versions |
| `git commit --no-verify`, `HUSKY=0` `[scan: gate-bypass]` | Whatever the hook caught | Fix what the hook reports |
| Turning off a strict compiler flag `[scan: type-config-weakened]` | Every error that flag finds | Fix the code. If migrating, ratchet: keep the flag and baseline the existing errors |
| Turning off a lint rule in config `[scan: lint-rule-turned-off]` | Every instance of that problem | Fix the instances. Disable a rule only with a written reason that applies everywhere |
| `eslint-disable` without a reason `[scan: lint-disable-bare]` | A real problem, one line at a time | Fix it, or `-- <reason>` on that single line |
| `patch-package` patch `[scan: patch-package]` | A dependency bug you now maintain forever | Prefer upgrading or replacing. If you must patch, link the upstream issue in the patch and plan its removal |
| Vendoring or copy-pasting a library's code | Lost security updates, plus a second copy to maintain | Depend on it properly, or write the small part you need and own it with tests |
| Adding a dependency for something the platform already does | Supply-chain risk and bundle size | Check built-ins first, and feature-test them in the target runtime. On React Native 0.88, `AbortSignal.timeout` / `AbortSignal.any` exist, but `structuredClone` is not a global and `crypto.randomUUID` is missing (use `expo-crypto`). In Expo apps, check the SDK's own modules before any third-party package |
| `\|\| true` or `2>/dev/null` in scripts and CI `[scan: shell-error-suppressed]` | A failing step that reports success (GitLab 2017: five backup methods, none working) | Let the step fail, or handle the specific expected failure explicitly |

## 7. React / React Native

| Tape | What it hides | Do instead |
|---|---|---|
| `// eslint-disable-next-line react-hooks/exhaustive-deps` | A stale closure or an effect that should not be an effect | Restructure: move logic into the event handler, use a reducer, or derive state instead of syncing it |
| `useEffect` with no cleanup for subscriptions, timers or listeners | Leaks and updates to unmounted components | Return a cleanup. For async work, abort with an `AbortController` |
| `key={index}` `[scan: index-as-key]` | State attached to the wrong row after reorder or delete | A stable ID from the data |
| `useEffect` to sync derived state | Double renders and out-of-sync values | Compute during render, or `useMemo` if it is measurably expensive |
| `setTimeout` to wait for layout, animation or navigation | Device-speed-dependent bugs | Use the real callback (`onLayout`, animation completion, navigation transition events), or `requestIdleCallback` for deferrable work. `InteractionManager` was removed in React Native 0.87 |
| Ignoring `AppState` / audio interruptions | Undefined behaviour when backgrounded, on a call, or killed | Model the lifecycle states explicitly and test each transition |
| Platform check sprinkled inline (`Platform.OS === 'ios' ? ...`) | Divergent behaviour nobody tests | Isolate it in a `.ios.ts` / `.android.ts` module or one adapter, and test both |

## 8. Process tape

| Tape | What it hides | Do instead |
|---|---|---|
| "Tests pass" without showing the command and output | Whether they ran at all | Paste the command and the summary line every time |
| Fixing the symptom at the crash site | The bad value's origin | Trace the bad value back to where it was created, and fix it there |
| Fixing one instance of a bug | Its siblings elsewhere | Search for the same pattern across the codebase and fix the class, or list where it remains |
| Broad refactor mixed into a fix | What actually changed the behaviour | Separate commits: tidy first, then the behaviour change |
| Changing many things at once until it works | Which change mattered, plus unknown side effects | One hypothesis, one change, one check |
| Disagreeing with a test or requirement and quietly working around it | The real disagreement | Stop. State what looks wrong and why, then let the owner decide |
