# Failure-pattern library

58 code and process patterns, each taken from a real, documented disaster or outage. A generic checklist ("check error handling") produces generic findings. A pattern tied to an incident tells you exactly what to look for, and why it matters. JPL admitted a rule to its coding standard only if it matched the root cause of a real past anomaly. This library applies the same test.

## How to use it

1. For each changed area, pick the categories that apply. The order below runs from most to least relevant for a mobile app with a backend.
2. For each pattern in those categories, run its detection: a grep, a test idea, or a pointed question.
3. Report a hit as a finding that cites the pattern ID and its incident, for example "FP-26 (Cloudflare 2017 leap second): `elapsed = Date.now() - start` in `upload.ts:88` can go negative after a clock change."
4. A pattern that does not apply is skipped silently. Do not pad the report with non-findings.

Full incident write-ups and sources are in the research notes this library was built from. The one-line incident labels here are for orientation.

## Contents
1. Input and config trust
2. Version skew and rollout
3. Time
4. Lifecycle, idempotency and concurrency
5. Retry, redundancy and failing static
6. Destructive operations
7. Numbers and units
8. Error handling and verification
9. Supply chain
10. Observability

## 1. Input and config trust

The top category for apps. API responses, remote config, OTA update payloads (EAS Update, CodePush), push payloads and deep links are all untrusted input, including your own server's.

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-37 | Internal config trusted like code | Cloudflare, Nov 2025: a bot-management feature file doubled in size and crashed the proxy fleet | Is every config or data file schema-validated at load, with size and count limits? Is there a last-known-good fallback and a per-feature kill switch? |
| FP-38 | A limit breach crashes instead of degrading | Cloudflare, Nov 2025: `unwrap()` on an exceeded limit | Grep `.unwrap()`/`.expect(` (Rust); in TS, `!` and `as T` on parsed data, and config loaders that throw on the launch path |
| FP-39 | Producer and consumer disagree on shape or arity | CrowdStrike 2024: 21 fields supplied, 20 expected | Are the validator and the consumer generated from one schema? Test with one extra and one missing field |
| FP-40 | A privileged parser of hot-pushed content, never tested with non-default field values | CrowdStrike 2024: out-of-bounds read, 8.5M machines down | Bounds-check every index or length derived from data. Test every field with non-default and hostile values |
| FP-56 | Third-party SDK parses remote config on the launch path | Facebook iOS SDK, May and July 2020: a server-side change crashed thousands of apps at launch | Are SDKs initialised lazily, inside try/catch, behind your own kill switch? Fuzz the config with `fc.json()` |
| FP-35 | Super-linear regex | Cloudflare 2019: one WAF regex took CPU to 100% worldwide | `eslint-plugin-regexp` `no-super-linear-backtracking`, or grep `(.*)*`, `(a+)+`, `.*.*`. Cap input length. Use RE2 for user-supplied patterns |
| FP-03 | Error payload sent in the data channel | Ariane 5: a diagnostic bit pattern was read as attitude data | Errors are a distinct type (`{ ok: false, error }`), never a sentinel value inside data |
| FP-15 | Saturated or clamped input treated as truth | Schiaparelli 2016: a saturated IMU reading led to a negative altitude estimate | Are clamped or saturated sensor, GPS and progress values flagged invalid rather than used? |
| FP-16 | No plausibility check, and a timeout that proceeds anyway | Schiaparelli 2016 | Assert physical invariants (duration ≥ 0, progress in 0..1). Review every "check failed for N s, proceed anyway" branch |
| FP-43 | One customer's valid input hits a latent shared bug | Fastly 2021: one valid customer config took down 85% of the network | Property-test over the full space of *valid* configs, not just typical ones. Dead-letter poison messages |
| FP-51 | Trusted length field | Heartbleed 2014 | Compare declared lengths and offsets against the real buffer. Flag `Buffer.allocUnsafe(n)` with `n` from input. Fuzz parsers |
| FP-52 | Data interpreted as code | Log4Shell 2021 | Grep `eval`, `new Function`, `dangerouslySetInnerHTML`, and WebView `injectJavaScript` with interpolated data. Use structured logging only |

## 2. Version skew and rollout

Old app versions live on devices for years. The server meets every version you ever shipped.

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-28 | Reused flag, field or enum value | Knight Capital 2012: a repurposed flag woke dead code and lost $440M in 45 minutes | Never recycle flags, enum values or API fields, because old clients keep the old meaning. Check `git log -S '<name>'` for prior use |
| FP-29 | Dead code left live | Knight Capital 2012 | Remove unused paths (Knip). Dead code is a loaded gun |
| FP-30 | Non-uniform deploy with no verification | Knight Capital 2012: one of eight servers missed the deploy | Does each node or app report and assert its version? Is there a minimum-supported-version gate? |
| FP-36 | Rule or data pushes bypass staged rollout | Cloudflare 2019; CrowdStrike 2024 | Do config, content and OTA updates go through the same canary and phased rollout as code? |
| FP-46 | New code path with no feature flag | Google Cloud Service Control, June 2025: an unflagged path hit a null field in replicated policy data | Is new behaviour behind an off-by-default flag? Null-check replicated or synced data |
| FP-25 | An untested emergency fix pushed everywhere at once | Azure leap day 2012 | Do hotfixes still go through a canary? |
| FP-12 | A partial fix across call sites | Patriot, Dhahran 1991: a time conversion was improved in some places but not others | When a conversion or check is fixed, grep every sibling call site |

## 3. Time

The device clock is user-controlled and can jump in either direction.

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-26 | Wall-clock durations | Cloudflare 2017: a leap second produced a negative duration and crashed DNS | Grep `Date.now() - start`. Use `performance.now()` for elapsed time, clamp `Math.max(0, dt)`, and make expiry server-authoritative |
| FP-23 | Date math by field increment | Azure 2012: "today + 1 year" from Feb 29 produced an invalid certificate date | Grep `setFullYear(` and `getFullYear() + 1`; JS silently rolls Feb 29 over. Use a date library. Test Feb 29, Dec 31 and DST changes across several time zones |
| FP-22 | Non-terminating loop at a boundary | Zune 30GB, Dec 31 2008: day 366 of a leap year looped forever | Every `while` needs a variable that strictly decreases. Property-test date code |
| FP-21 | Uptime counter overflow | Boeing 787, 2015: generator control units shut down after 248 days of power | Work out counter width × rate against the longest possible uptime. JS `setTimeout` delays above 2^31−1 ms fire *immediately*, so clamp them |
| FP-27 | Wrapping counter with an implicit epoch | GPS week rollover; Y2038 | Grep 32-bit time storage: `INT` columns, protobuf `int32`, `(Date.now()/1000)\|0`. Test 2038 and 2106 |
| FP-11 | Float time error that grows with uptime | Patriot, Dhahran 1991: 0.1 s in binary drifted 0.34 s over 100 hours, and 28 soldiers died | Grep `+= 0.1` and `t += dt`. Test with a fake clock advanced 30 days or more |
| FP-13 | State initialised at the wrong lifecycle point | Starliner OFT 2019: the mission timer read the wrong clock at the wrong time | When are external values (server time, config) read? Are they re-checked after background, resume and network changes? |

## 4. Lifecycle, idempotency and concurrency

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-05 | Stale latched event consumed after a mode change | Mars Polar Lander 1999: a leg-deployment jolt was latched as touchdown and the engines cut at 40 m | Are flags and pending results cleared on every mode change? Async results after navigation or logout must be dropped (AbortController or generation token) |
| FP-57 | Non-idempotent OS registration on every launch | Teams and Android, 2021: duplicate phone-account registrations blocked a 911 call | Key registrations (push tokens, listeners, background tasks, notification channels) by a stable ID. Cold-start 20 times and count them. Test the logged-out path |
| FP-48 | Stale check-then-act (TOCTOU) | AWS DynamoDB DNS, Oct 2025: a delayed worker applied a stale plan and cleanup deleted the live one | Compare versions atomically at write: CAS, `WHERE version = ?`, `If-Match`, `ConditionExpression` |
| FP-07 | Unbounded growth by high-water mark | Spirit rover 2004: files accumulated until flash memory management failed | What is the maximum for each cache, storage key set, file directory and listener list? Soak-test 10,000 create/delete cycles |
| FP-06 | A lock held across priority or latency domains | Mars Pathfinder 1997: priority inversion caused repeated resets | Look for async mutexes held across network calls, and long synchronous work on the JS thread |
| FP-09 | A safety interlock moved into unsynchronised software | Therac-25: hardware interlocks removed, and a race caused fatal overdoses | Every safety, payment or consent guard has an independent server-side check |
| FP-20 | Pervasive globals and unbounded stack | Toyota unintended acceleration (Barr testimony, 2013) | Count module-level mutable state. Grep recursion over untrusted depth; Hermes has a smaller stack than V8 |

## 5. Retry, redundancy and failing static

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-47 | Restart or retry herd without jitter | Google Cloud, June 2025: synchronised restarts overloaded the recovering service | Grep `retry` and `while (true)`. Require exponential backoff with full jitter, a cap and a budget |
| FP-41 | Correlated self-removing health checks | Facebook, Oct 2021: DNS servers withdrew themselves when the backbone dropped, all at once | What happens if every instance fails at once? Keep a minimum-healthy floor and fail static: serve the offline cache, and never force a logout on a 5xx |
| FP-42 | Recovery tools depend on the failed system | Facebook, Oct 2021: engineers could not reach the tools or the buildings | Is there a break-glass path that works with the primary down, and has anyone tested it? |
| FP-02 | Identical-software redundancy | Ariane 5: the backup ran the same code and failed first | Does the fallback run the same code or config as the primary, and so fail the same way? |
| FP-17 | A single-source input drives a repeated authoritative action | Boeing 737 MAX MCAS: one angle-of-attack sensor | Count the independent inputs. Define what happens when they disagree |
| FP-18 | Unbounded cumulative authority | Boeing 737 MAX MCAS: repeated activations with no limit | Cap automatic retries, charges, sends and deletes per time window. A human override must stop it durably |

## 6. Destructive operations

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-44 | Untyped polymorphic destructive API | Atlassian, April 2022: a delete call given site IDs instead of app IDs removed 775 customers' sites | Branded or prefixed IDs (`site_`, `app_`), validated server-side |
| FP-45 | Permanent delete with no soft-delete stage | Atlassian, April 2022: restoring took up to two weeks | Dry-run by default, an explicit `--execute`, batch caps, soft delete, and a *tested* bulk restore |
| FP-33 | Destructive command on an ambiguous target | GitLab 2017: `rm -rf` on the primary database instead of the replica | Print the resolved host and environment, and require the target name to be typed back |
| FP-31 | Ops tool with no blast-radius limit | AWS S3, 2017: a typo removed far more servers than intended | Enforce minimum capacity or a maximum count, and show the resolved targets before acting |
| FP-34 | Untested backups and dead alerts | GitLab 2017: five backup methods, none working | Automated restore tests and a dead-man's-switch alert. Grep `\|\| true` and `2>/dev/null` in scripts and CI |

## 7. Numbers and units

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-04 | Unit-less number across an interface | Mars Climate Orbiter 1999: pound-force seconds read as newton-seconds | Numeric fields with no unit suffix or brand (`timeout`, `duration`, `amount`). JWT `exp` is in seconds while `Date.now()` is in ms: grep `*1000` and `/1000` near `exp` |
| FP-01 | Unchecked narrowing of a reused value | Ariane 5: a 64-bit float converted to int16 overflowed | Grep `\|0`, `>>>0`, `~~`, typed-array writes (silent wrap), `Number(bigint)`. What is the maximum in *this* product, and where is it asserted? Test at max+1 |
| FP-10 | A counter used as a boolean | Therac-25: a one-byte flag incremented to 256 wrapped to 0 and skipped a safety check | Grep `flag++` later tested for truthiness |
| FP-58 | Comparator by subtraction | Teams and Android, 2021: an overflowing comparator corrupted ordering | Use explicit `<` / `>` comparisons. In JS, a NaN in a sort key corrupts the whole order |
| — | Large integers and money | General | int64 IDs above 2^53 travel as strings. Money is integer minor units |

## 8. Error handling and verification

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-50 | Unreachable security check that defaults to success | Apple "goto fail" 2014 | ESLint `curly: all` and `no-unreachable`. Initialise to deny. Write negative tests |
| FP-08 | Allocation failure becomes a silent suspend | Spirit rover 2004 | Resource exhaustion must return an error, not hang or suspend |
| FP-24 | A software error misclassified, so remediation spreads it | Azure 2012: hosts marked as hardware failures, and healing moved the bug everywhere | Automatic healing stops after N fleet-wide failures of the same kind |
| FP-14 | Segmented testing hides the seams | Starliner OFT 2019: phases tested separately, never end to end | At least one end-to-end run on a real build: install, log in, background, resume, upgrade, log out |

## 9. Supply chain

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-53 | Build depends on mutable registry state | left-pad 2016 | Lockfiles committed and used (`npm ci`, `Podfile.lock`, Gradle locking) |
| FP-54 | Maintainer takeover | event-stream 2018 | Review new packages in lockfile diffs. Alert on publisher changes. Prefer `--ignore-scripts`. Run `vet-package.mjs` on anything new |
| FP-55 | Released artifact differs from its source | xz-utils 2024 | Compare the published tarball with the repository. Binary blobs in a dependency's test directories are findings |

## 10. Observability

| ID | Pattern | Incident | Detect |
|---|---|---|---|
| FP-19 | Watchdog proves liveness, not progress | Toyota (Barr testimony) | Health checks assert per-worker last-progress timestamps, not just "process is up" |
| FP-32 | Recovery never exercised, and monitoring that depends on the monitored system | AWS S3, 2017: subsystems not restarted in years, and the status page itself depended on S3 | Cold-start drills. The status page and the app's outage banner live off-platform |
| FP-49 | Missing metric treated as zero | Google auth, Dec 2020: usage reported as zero led quota to shrink to nothing | Grep `?? 0` and `\|\| 0` feeding automated decisions. Keep null and 0 distinct |
