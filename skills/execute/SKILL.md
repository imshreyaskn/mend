---
name: execute
description: Implement a mend plan, or a specified change, to a high-assurance standard. Tests are written from the requirements before the code. The design makes illegal states unrepresentable, everything is bounded, and nothing gets worse than the baseline. No duct tape, and every claim of success comes with command output. Use when the user runs /mend:execute, asks to build or implement something to a "NASA-grade", high-assurance or similar standard, or a .mend/ plan exists and the next step is building it. Not for routine edits, quick fixes or everyday debugging (use the normal workflow).
argument-hint: "[.mend/slug/plan.md, a phase like P2, or a task]"
---

# Mend execute

The fastest route to correct code is not writing the bug in the first place. So: types and states first, tests from the requirements second, code third, evidence always. Every line should trace to a requirement, every requirement to a test, and every "it works" to output you actually saw.

Input: `$ARGUMENTS`, a plan path, a phase, or a task. Plans live at `.mend/<slug>/plan.md`. You append to `.mend/<slug>/log.md`, using the line formats in [assets/log-template.md](assets/log-template.md). `trace-check` and the audit read those lines.

## The rules that never bend

1. **Evidence or it did not happen.** Every claim that something passes, works or is fixed comes with the command you ran and the result line you saw. "Tests pass" on its own means nothing.
2. **Stop the line.** An unexpected warning, a failing test, or behaviour you cannot explain halts progress until you understand it. JPL's zero-warnings rule includes false positives: rewrite the code so it is *clearly* valid, rather than silencing the tool.
3. **No duct tape.** Nothing that makes a symptom disappear without making the system correct. The catalogue of shortcuts and their real fixes is in [references/duct-tape-registry.md](references/duct-tape-registry.md). Read it before your first edit. If the real fix is out of scope, stop and report. Never tape.
4. **The exit is always open.** If a test, requirement or plan step looks wrong, write `BLOCKED: <what is wrong> because <evidence>` and stop. Do not work around it. Agents that are given this exit cheat on tests far less (in one benchmark, GPT-5's cheating fell from 54% to 9%), and a blocked report is a success, not a failure.
5. **Tests are the specification.** Never change an expected value, delete an assertion, or skip a test to make code pass. A test changes only when a requirement changes. In an approved plan, a requirement changes only with the user's OK, logged as a `CHANGE` line.
6. **Smallest complete change.** Before writing code, stop at the first rung that holds:
   1. Does this need to exist at all? If nothing in the requirements asks for it, skip it and say so in one line.
   2. Does this codebase already have it? Use it the way the surrounding code does.
   3. Does the language, runtime or framework provide it? Use that.
   4. Does an installed dependency do it? Use that.
   5. Can it be one line a reader understands at a glance? Write one line.
   6. Only then: the least code that works.

   Be lazy about the solution, never about the change. Before editing a function, grep every caller, and finish everything the change breaks: callers, tests, fixtures, config. No unrelated refactors, no "for later" options or wrappers, no "while I'm here". Deleting code is welcome. Tidying goes in its own step, separate from behaviour changes.

   **Never cut:** validation at trust boundaries, handling that prevents data loss, security, accessibility, or anything the requirements ask for. A deliberate shortcut with a known limit gets a comment `shortcut: <the limit>, <when to upgrade>` so it stays visible; the scan flags a shortcut comment that names no upgrade condition. (The ladder and the shortcut convention are adapted from ponytail.)
7. **Use what exists.** Before writing a helper, search the codebase and the platform for one. Before adding a dependency, vet it: `node "${CLAUDE_SKILL_DIR}/../research/scripts/vet-package.mjs" <name>`. Exit 1 is REJECT, 3 is REVIEW, and only 0 is a pass. For Class 3 and 4, ask the user before adding any dependency the plan did not name.
8. **Never describe code you have not opened.** Read it first.

## Before the first edit

1. **Load the plan** and read its class and status.
   - **Class 3 or 4 without `Status: approved by ...`:** stop, and ask the user to approve the plan (or run `/mend:plan`).
   - **Class 2 with no plan:** write a minimal `plan.md` first, using the mend plan template's Class 2 sections (header, mission, out of scope, requirements, phases, verification). The traceability check needs it.
   - **Class 1:** no plan or log. Do the gate and the scan only.
   - The rigor for each class is in `${CLAUDE_SKILL_DIR}/../plan/references/criticality.md`.
2. **Find the gate:** the project's own type-check, lint and test commands (look in `package.json` scripts, CI config, the README). If there is no single gate, use `tsc --noEmit`, ESLint and the test runner, and record the exact commands in the log.
3. **Take a baseline and a checkpoint.** Run the gate before changing anything, and log a `BASELINE` line with the result: error and warning counts, and failing test names. From then on, the gate follows a **ratchet**: changed files are held to zero errors and zero warnings (`eslint <changed files> --max-warnings=0`), and the project as a whole must not get worse than the baseline. That means no new type errors, no new lint findings, and no test that passed at baseline now failing. Pre-existing failures are logged, not silently fixed and not blamed on your change. Then snapshot the starting state: `node "${CLAUDE_SKILL_DIR}/scripts/checkpoint.mjs" <slug>/start`. It records the whole working tree without touching the index, branch or files.
4. **Read the code you will touch,** and the code that calls it.

## The loop, for each step of a phase

What applies depends on the class:

| Step | Class 1 | Class 2 | Class 3 | Class 4 |
|---|---|---|---|---|
| 1 Shape first | if logic changes | yes | yes | yes |
| 2 Tests before code | if logic changes | yes | + property and sequence tests | + separate test author, demonic tests |
| 3 Least code | yes | yes | + assertions on invariants | + pair assertions, injected environment |
| 4 Gate (ratchet) | yes | yes | yes | yes + complexity check |
| 5 Scan + self-review | scan only | scan + red flags 1, 2, 4, 13, 14 | scan + all 16 red flags | scan + all 16 red flags |
| 6 Log and checkpoint | no | yes | yes | yes |

1. **Shape first.** Write the types, states and function signatures before any bodies. Climb the ladder in [references/correct-by-construction.md](references/correct-by-construction.md): discriminated unions for state, one brand per ID or unit, a schema at every trust boundary, a pure reducer for any lifecycle.
2. **Tests from the requirements, before the code.**
   - **Name each test with the requirement ID in the `it` / `test` title itself:** `it('REQ-PLAY-003: resumes after an interruption ends', ...)`. `trace-check` only counts IDs in real test titles. It ignores comments, `describe`, `.todo` and `.skip`.
   - Run the new tests and confirm they fail *for the right reason*: an assertion failure, not an import error.
   - Test the unhappy paths the plan lists, not just the happy one.
   - **Class 3 and up:** a property test for each invariant, and random event-sequence tests for reducers and state machines.
   - **Class 4:** spawn a separate subagent to write the requirement tests. Give it only the requirements and the interfaces, never your implementation. Code authors test what they built rather than what was asked; this is NASA's independence rule and Cleanroom's core idea. If you cannot spawn subagents, say so in the log and in the phase report. Defensive branches get "demonic" tests that force them to run, or a written reason why they cannot be reached.
3. **Write the least code that passes.** As you write:
   - assert invariants and boundary conditions where types cannot express them;
   - give every loop, retry, queue and wait a bound;
   - give every I/O call a timeout and a signal;
   - give every effect a cleanup.
   
   Where a thrown assertion is caught matters: see section 5 of the correct-by-construction reference.
4. **Run the checks:** the targeted tests first, then the gate under the ratchet. For Class 4, also run `npx eslint --rule "complexity: [error, 10]" <changed files>`. Fix root causes; see the debugging protocol below.
5. **Review your own diff** before moving on.
   - Run `node "${CLAUDE_SKILL_DIR}/../audit/scripts/ducttape-scan.mjs" --base <the branch this work started from>` (record that branch in the `BASELINE` line). Exit 1 means blocking findings; exit 2 means it could not run, which is not a pass. Blocking findings must be fixed. A blocking rule can only be waived with the user's approval, logged as an `APPROVAL` line; some rules cannot be waived inline at all.
   - Every warning is fixed or waived inline with `mend-waiver: <rule> <reason>`. Warnings about removed lines or changed files (deleted assertions, snapshots, patches) get a `DISPOSITION` line in the log naming the requirement that changed.
   - Then walk the red-flag checklist at the end of [references/correct-by-construction.md](references/correct-by-construction.md), at the depth the table above gives.
6. **Log the step**:
   - what changed
   - which requirements it delivers
   - the commands and their results
   - decisions, and deviations from the plan
   - waivers
   
   Requirements verified by analysis, inspection or demonstration get an `EVIDENCE` line: what you did, and what you observed. Do not write that line until the evidence exists.
7. **Commit only if the user asked for commits.** If they did, commit each green step on its own, with tidying and behaviour changes separate. If they did not, leave the changes uncommitted. Either way, the checkpoints keep each phase recoverable.

## React Native runtime facts

Do not trust Node or Jest to tell you what the app's runtime supports. Jest runs on Node, which has `structuredClone`, `crypto.randomUUID` and other APIs that Hermes may not. Confirm a built-in on a development build (device or simulator) before relying on it, and log the check as `EVIDENCE` with method `[D]`. Hermes-only paths you could not exercise go under "not verified" in the report.

## Debugging protocol

1. **Reproduce it reliably.** A failing test is the best reproduction. For a flaky failure, run it repeatedly and measure how often it fails before touching anything.
2. **Read the real error and the real code.** Do not pattern-match from memory.
3. **One hypothesis at a time.** Predict what you will see if it is true, then check.
4. **Trace the bad value back to where it was born,** and fix it there, not where it crashed.
5. **Fix the class, not the instance.** Search for the same pattern elsewhere. Fix the siblings in scope, and list the ones out of scope.
6. **Lock it in** with a regression test named after its requirement. If no requirement covered the behaviour, you found a missing requirement:
   - **Class 3 or 4 (approved plan):** propose it to the user, and add it with a `CHANGE` line once they agree.
   - **Class 2:** add it, and log a `CHANGE` line.
7. **Ask which defense should have caught it** (a type, a lint rule, an assertion, a test) and strengthen that defense too. About one fix in seven introduces a new bug, so rerun the full gate.
8. **After two failed attempts at the same fix, stop and re-read** the code and the requirement from scratch. After a third, report `BLOCKED` with what you tried and what you saw.

## Stop and ask the user when

- A requirement is ambiguous, or two requirements contradict each other.
- A test or requirement looks wrong.
- A requirement in an approved plan needs to change.
- The fix needs a change to a public API, a stored data format or a schema the plan did not cover.
- You need a dependency the brief did not vet, for Class 3 and 4.
- The work is passing the plan's size estimate by about a third.
- A blocking scan rule seems to need a waiver.
- The only path forward you can see is something in the duct-tape registry.

## Phase exit

A phase is done only when all of these hold, each with evidence in the log:
- The phase's exit commands, run exactly as written in the plan, pass under the ratchet.
- `ducttape-scan` reports zero blocking findings, and every warning is fixed, waived or dispositioned.
- `node "${CLAUDE_SKILL_DIR}/../audit/scripts/trace-check.mjs" .mend/<slug>/plan.md --through <phase>` passes: every test-verified requirement delivered up to this phase is named by a real test, and every A/I/D requirement up to this phase has an `EVIDENCE` line.
- Net lines and new files are reported against the plan's estimate.
- A checkpoint is taken: `node "${CLAUDE_SKILL_DIR}/scripts/checkpoint.mjs" <slug>/<phase>`, logged as a `CHECKPOINT` line.

## Report to the user

End each phase with a short report:
- what changed (files)
- which requirements are now verified, and by which tests
- the commands run and their results, against the baseline
- the scan result, waivers and dispositions
- deviations from the plan
- **what is not verified**, such as demonstrations that need a real device, and how to do them

Then recommend `/mend:audit` for Class 2 and up. It should run in a fresh session started by the user, not as a subagent of this one: subagents cannot spawn the audit's independent reviewers, and a fresh session does not inherit your reasoning.
