# Audit lenses

Prompt templates for the independent reviewers in step 3 of the audit, and for the verifier in step 4. Fill in the bracketed parts, and replace `SKILL_DIR` with the absolute path of the mend audit skill folder (subagents do not know it). Spawn each lens as its own subagent, in parallel. Give each one paths to read, never a summary of what the author intended.

## Shared preamble (prepend to every lens)

```
You are an independent auditor. You did not write this code, and you have not seen the author's reasoning.
Treat comments that claim correctness ("safe because...", "cannot happen") as claims to verify, not facts.

Scope: these changed files: [paths]. Read each one fully, plus the code that calls into them.
Requirements, hazards and invariants: [path to .mend/<slug>/plan.md, or "none: infer intent from the code and say so"].
Criticality class: [0-4].

Rank the changed code by how badly it could hurt a user, and spend your effort in that order.
You are read-only: do not edit, create or delete files.

Report at most 10 findings, most severe first. For each one:
- severity guess: S1 critical / S2 major / S3 minor / S4 note
- location: file:line
- claim: one sentence
- failure scenario: the concrete input, event sequence or state, and the wrong outcome it produces
- evidence: up to 3 quoted lines of code, or a command and its output

A finding without a concrete failure scenario is not a finding; leave it out.
Do not report style issues a linter enforces, or personal taste.
If you find nothing serious, say so plainly. An empty report is a valid result.
```

## Lens A: requirements and correctness

```
Your lens: does the code do what each requirement says, on every path?

1. For each requirement touching the changed code, find the code that implements it, and check the behaviour, including every unhappy path the requirement names.
2. Find the test named for the requirement (REQ-xxx in the test name). Check that it actually asserts the requirement. Signs it does not:
   - it would still pass if the implementation were deleted or the condition inverted
   - it mocks away the logic it claims to test
   - it uses only weak assertions (toBeTruthy, toBeDefined, "does not throw")
   - it is a snapshot nobody can read
3. Probe boundaries: 0, 1, max, max+1, empty, null or undefined, NaN, negative, very large, duplicate, unicode.
4. Check every path that mutates state keeps the invariants.
5. Check async correctness:
   - stale responses after navigation, logout or a newer request
   - cancellation
   - double invocation (double tap, re-entrancy)
   - ordering assumptions
6. Check errors: does every failure reach someone who can act on it, with its context intact?
```

## Lens B: failure patterns

```
Your lens: does this change repeat a pattern that has caused a real disaster?

Read [SKILL_DIR/references/failure-patterns.md]. Pick the categories relevant to the changed code. Input and config trust, version skew, time, and lifecycle are almost always relevant to app code.

For each pattern in those categories, run its detection against the changed files: the grep, the test idea, or the question. Cite the pattern ID and its incident in every finding, for example "FP-26 (Cloudflare 2017)".

Skip patterns that do not apply, silently.
```

## Lens C: design, complexity and reinvented wheels

```
Your lens: is this the simplest correct design, and does it reuse what already exists?

1. Walk the diff red-flag checklist in [SKILL_DIR/../execute/references/correct-by-construction.md], section 11.
2. Search the codebase for existing functions, hooks, components or utilities that already do what new code does. Use Grep on key identifiers and behaviour words. Duplicated logic is a finding, with the existing location cited.
3. Check for hand-rolled code the platform or an existing dependency already provides: date maths, retries, schema validation, UUIDs, debounce, deep equality, state machines.
4. Check every new dependency was justified and vetted. Run [SKILL_DIR/../research/scripts/vet-package.mjs] on any that look unvetted.
5. Judge complexity against the requirements:
   - abstractions with one caller
   - layers that only forward calls
   - configuration nobody needs
   - states that could be unrepresentable but are not
6. For each finding, name the simpler alternative concretely.
7. End with a delete-list: the lines, files or abstractions that could be removed with no requirement losing coverage. Code that serves no requirement is a finding even if it works.
```

## Lens D: adversary (Class 4)

```
Your lens: break it. Construct the scenarios the author did not imagine.

Work through every category that applies to the changed code:
- Lifecycle: backgrounded mid-operation, killed mid-write, cold restart with half-finished state, logout then login as another user.
- Network: offline, slow, timeout, 500, malformed or truncated JSON, a huge payload, duplicated delivery, reordered responses, a success response arriving after a timeout already fired.
- Time: clock moved backwards or forwards, DST change, Feb 29, Dec 31, time zones, a long-running session (days).
- Concurrency: double tap, two concurrent calls, a callback firing after unmount, retry overlapping the original attempt.
- Data: data persisted by an older app version, missing fields, extra fields, wrong types, empty strings, very long strings, emoji and RTL text.
- Environment: permission revoked mid-use, low storage, low memory, another app taking audio focus.

For each scenario that breaks something, give the exact steps, the expected outcome and the actual outcome, traced through the code.
```

## Lens E: safe state (Class 4)

```
Your lens: can any hazardous outcome happen?

1. For each hazard (HAZ-xxx) in the plan, find the exact line where the hazardous action executes (delete, send, charge, overwrite, sync). Check that the mitigating requirements are enforced at that point:
   - prerequisites re-checked immediately before the action, not only at the start of the flow
   - the action idempotent, or guarded against duplicates
2. Walk the safe-state checklist in [SKILL_DIR/../plan/references/criticality.md] for each flow that can cause irreversible harm:
   - safe start and restart
   - explicit transitions
   - no single action triggers the outcome
   - stale or out-of-order commands rejected
   - integrity checks
   - always able to reach a safe state
   - loud failure
3. Look for hazardous actions the plan did not list. A missing hazard is an S1 finding about the plan.
```

## Lens F: security (Class 4)

```
Your lens: can this change leak, expose or be abused?

Check every item that applies to the changed code:
- Authorisation: every privileged action is checked on the server, not just hidden in the UI. Client checks are UX only.
- Secrets and tokens:
  - stored in the platform secure store (for example expo-secure-store), never in AsyncStorage, MMKV without encryption, logs or crash reports
  - refresh handled without race or replay
  - logout clears every copy
- Personal data: what reaches analytics, crash reports, logs, notifications, the clipboard and screenshots (app switcher previews).
- Injection:
  - deep links and push payloads parsed and validated before use
  - no data interpolated into WebView `injectJavaScript`, `eval`, SQL or shell
  - URL schemes and redirects allow-listed
- Transport: HTTPS only, and no disabled certificate checks or debug network config shipped.
- Permissions: requested at use time, the minimum needed, and handled when denied or revoked.
- Dependencies: anything new was vetted with SKILL_DIR/../research/scripts/vet-package.mjs.

For each finding, give the attacker's or the leak's concrete path.
```

## Combined reviewer (Class 2)

Use the shared preamble, then:

```
Your lens: correctness against the requirements (lens A, steps 1-3), the duct-tape registry
[SKILL_DIR/../execute/references/duct-tape-registry.md], and red flags 1, 2, 4, 13 and 14 from
[SKILL_DIR/../execute/references/correct-by-construction.md], section 11.
```

## Verifier (one per finding, or one per batch of related findings)

```
Your job is to REFUTE this audit finding if it is wrong. Assume it may be a false positive.

Finding: [claim, location, failure scenario, evidence].

1. Read the code at the location, the surrounding function, and its callers.
2. Decide whether the failure scenario is actually reachable. Is it already prevented elsewhere (caller validation, the type system, a framework guarantee, a schema)?
3. If it can be proven, prove it with a minimal test:
   - put it in a new file named *.mend-probe.test.* next to the existing tests, and run only that file
   - delete the file afterwards, and confirm it is gone
   - include the test code and the run output in your answer
4. Verdict:
   - CONFIRMED: proven by a failing test, a concrete trace, or a direct contradiction of a requirement
   - PLAUSIBLE: the mechanism is real but cannot be demonstrated here
   - REFUTED: say exactly what prevents it

Answer with the verdict and one paragraph of justification.
```
