---
name: audit
description: Audit code to a high-assurance standard as an independent reviewer. Run the deterministic checks first (gate against baseline, traceability, duct-tape scan). Then sweep for the code patterns behind real disasters, attack the change through independent fresh-context lenses, and try to refute findings before reporting them. Finish with a GO or NO-GO verdict and a findings ledger where every item gets a disposition. Use when the user runs /mend:audit, asks for a mend audit or a "NASA-grade" / high-assurance sign-off, asks whether something is "NASA-ready", or a .mend/ plan exists and the work is ready to verify. Not for routine code review or PR review (use your normal code review). It complements a pre-merge review gate and does not replace one.
argument-hint: "[.mend/slug, a base branch, or paths]"
---

# Mend audit

An audit is worth exactly as much as its independence and its evidence. NASA's IV&V gets its value from reviewers who did not build the system and who pick their own scope. JPL's SCRUB process makes every finding get an answer. And the evidence on AI review is sobering. On realistic changes, AI reviewers catch about a third to half of what careful humans flag, and a reviewer asked to find problems always finds *something*. So this skill runs the non-LLM checks first, makes every finding carry proof, tries to knock findings down before reporting them, and says plainly what it could not check.

Input: `$ARGUMENTS`, a mend slug, a base branch, or paths. Output: `.mend/<slug>/audit.md`, or `.mend/audit-<YYYY-MM-DD>.md` when there is no plan.

## 0. Independence

- **Run in the main session of a fresh conversation** that never saw the code being written. Never run as a subagent: subagents cannot spawn the lenses below.
- **If this session wrote the code, or you cannot spawn subagents:** run the lenses yourself one after another, and mark independence **DEGRADED** at the top of the report. A Class 4 change cannot get GO with degraded independence.
- **Rank the risk yourself before reading the author's log.** The log is evidence to check, not a conclusion to adopt.
- **Do not fix anything during the audit.** An auditor who fixes as they go becomes an author. Fixes come after, and then get re-audited (step 7).
- **Take a checkpoint before anything else:** `node "${CLAUDE_SKILL_DIR}/../execute/scripts/checkpoint.mjs" <slug>/audit-<YYYY-MM-DD>`. It fixes exactly what was audited. Re-audits diff against it, and it is the restore point for the mutation check.

## 1. Scope and risk ranking

1. Find the change: the diff against the merge-base with the branch the work started from. Take that branch from the log's `BASELINE` line, from `$ARGUMENTS`, or ask. Include uncommitted and untracked files. Read the plan at `.mend/<slug>/plan.md` if it exists.
2. Take the class from the plan. If there is none, classify the change yourself using `${CLAUDE_SKILL_DIR}/../plan/references/criticality.md`. When two classes could apply, take the higher. **Audit at the class the code deserves,** not the class it was given; if the plan under-classified it, that is a finding.
3. Check the plan's status. A Class 3 or 4 plan that is not `approved by <user>` is an S2 process finding.
4. Read every changed file and the code that calls it. Rank the changed areas by how badly they could hurt a user. The ranking decides where the depth goes.

## 2. Mechanical evidence first

Run these before any judgement, and record each command and its result. A command that cannot run (exit code 2, a crash, a network failure) is "not verified", never a pass.

1. **The gate, under the baseline ratchet.** Run the project's own type-check, lint and tests. Compare with the log's `BASELINE`:
   - new type errors, new lint findings, or tests that passed at baseline and now fail are **S1**;
   - lint on changed files must be clean (`--max-warnings=0`);
   - failures that already existed at baseline are reported separately as pre-existing, not counted against this change.
   
   Without a baseline, treat failures in changed files or their tests as new, and list the rest as "pre-existing or unrelated, unconfirmed".
2. **Duct tape:** `node "${CLAUDE_SKILL_DIR}/scripts/ducttape-scan.mjs" --base <branch>`.
   - Blocking findings are S2 or worse.
   - Every inline waiver must have a reason a reviewer would accept. A weak reason is a finding.
   - A waiver of a blocking rule needs a matching `APPROVAL` line from the user in the log; without one, it is S2.
   - Removed-line and file-level warnings need a `DISPOSITION` line naming the requirement that changed.
   - List every `shortcut:` comment the change adds in the report as the change's debt ledger: each names its limit and when to upgrade. A shortcut on a trust boundary, data-loss path or security check is S2: those are never shortcuts.
3. **Traceability** (when a plan exists): `node "${CLAUDE_SKILL_DIR}/scripts/trace-check.mjs" .mend/<slug>/plan.md --strict`. With Jest or Vitest, first write a JSON report (`jest --json --outputFile=.mend/<slug>/tests.json`, or Vitest's `json` reporter) and add `--report .mend/<slug>/tests.json`, so only tests that actually ran and passed count. For Class 2 and up, an untraced test-verified requirement, or missing `EVIDENCE` for an A/I/D requirement, is **S2**. Structural errors in the plan are S3, or S2 if they hide a requirement.
4. **Extra analyzers, if the project has them or they run with `npx` in under a minute:** Knip (unused files, exports, dependencies), `npx expo install --check` and `npx expo-doctor` for Expo apps, `npm audit --omit=dev` or osv-scanner, circular-import checks. JPL ran four analyzers nightly and found surprisingly little overlap between them; every independent tool adds signal. For any new dependency, run `node "${CLAUDE_SKILL_DIR}/../research/scripts/vet-package.mjs" <name>`; exit 1 is REJECT, 3 is REVIEW.
5. **Changed-line coverage,** if the project produces coverage. Classify every uncovered changed line as a missing test, a missing requirement, dead code (delete it), or a defensive path (needs a test that forces it, or a written reason). Never accept "add a test to hit the line": tests come from requirements.
6. **Class 4: complexity and mutation.**
   - Run `npx eslint --rule "complexity: [error, 10]" <changed files>`.
   - For three to five critical conditions (permission checks, validation, state guards), invert the condition and run the targeted tests. Then restore the file: `git restore --source <audit checkpoint sha> --worktree -- <file>`. Confirm with `checkpoint.mjs --diff <audit label>` that nothing remains.
   - A mutant that survives means a missing test, which is S2.
   - If the project has Stryker configured, run it on the changed decision logic instead.

## 3. Independent lenses

Spawn the lenses as parallel subagents. Each gets only: the list of changed files (or the diff), the plan's requirements, hazards and invariants, and the reference it needs. The prompts are in [references/lenses.md](references/lenses.md). Each lens returns at most ten findings, each with a location and concrete evidence.

| Class | Lenses |
|---|---|
| 2 | One combined reviewer: requirements and correctness, duct tape, design red flags |
| 3 | **A** Requirements and correctness · **B** Failure patterns ([references/failure-patterns.md](references/failure-patterns.md)) · **C** Design, complexity and reinvented wheels |
| 4 | A, B and C, plus **D** Adversary · **E** Safe state · **F** Security |

**A reviewer from another model family** catches what copies of the same model miss. Use one only if the user explicitly approves it in this session, naming the provider. Sending code to an outside service is the user's decision, never inferred from a key found in the environment.

## 4. Try to refute findings before reporting them

A verifier's job is to *disprove* a finding. It reads the code, checks the claim, and tries to build the failing case. Scale the effort to the class:
- **Class 2:** verify only S1 and S2 findings, yourself, in this session.
- **Class 3 and 4:** spawn verifier subagents, batching findings by file, at most five verifiers.

Verdicts:
- **CONFIRMED:** a failing test, a concrete input or event sequence, or a direct contradiction of a requirement. Best of all, a test that fails now.
- **PLAUSIBLE:** the mechanism is real but it could not be demonstrated. Keep it, labelled as such.
- **REFUTED:** drop it, with a one-line reason.

A finding with no failure scenario ("consider adding error handling") is not a finding. Drop it, or turn it into a concrete claim and verify that.

## 5. Severity

| Severity | Meaning |
|---|---|
| **S1 Critical** | Violates a hazard mitigation or a Class 4 requirement; data loss or corruption; security or privacy breach; crash on a common path; a gate failure the change introduced |
| **S2 Major** | A requirement not met, untested, or without evidence; an unbounded resource; a swallowed error on a core path; a blocking duct-tape finding or an unapproved waiver of one; a surviving mutant in critical logic; an unapproved Class 3 or 4 plan |
| **S3 Minor** | Maintainability, complexity over threshold, a missing assertion, an unclear name, a plan structure error that hides nothing |
| **S4 Note** | Optional improvement. At most five. Do not pad |

Do not report what lint already enforces, taste without a failure scenario, or anything outside the change unless the change makes it worse.

## 6. Ledger and dispositions

Write the ledger to the audit file:

| ID | Sev | Source (tool or lens) | Location | Finding | Evidence | Verdict | Disposition | Resolution |
|---|---|---|---|---|---|---|---|---|

Dispositions belong to the author or the user, not the auditor: **Agree** (will fix), **Disagree** (with evidence), **Discuss**. Following SCRUB, a finding with no disposition counts as Agree. A Disagree on an S1 or S2 goes to the user to arbitrate; the author cannot close it. Only the user can **accept the risk** of an open S2. Record that as `APPROVAL` in the log, with their words.

## 7. Verdict

Every outcome is exactly one of these:
- **NO-GO:** any open S1; or any open S2 the user has not accepted; or independence DEGRADED on a Class 4 change; or a mechanical check in step 2 could not run.
- **GO WITH ACCEPTED RISK:** no open S1, and every open S2 is accepted by the user (each listed with their reason).
- **GO:** no open S1 or S2.

**Re-audit after fixes.** Run `node "${CLAUDE_SKILL_DIR}/../execute/scripts/checkpoint.mjs" --diff <slug>/audit-<date>` to see exactly what changed since the audit, untracked files included. Check that every agreed finding was fixed *and that nothing else changed*. Treat any unrequested change as new code to review. Then rerun step 2, and report only new findings.

## Report to the user

Lead with the verdict, the class, and the independence status, then:
- the counts by severity
- every S1 and S2 in one line each, with evidence
- the commands run and their results, against the baseline
- the waivers and accepted risks
- a **Not verified** section: what this audit could not check (behaviour on a real device, Hermes-only paths, real network conditions, performance under load, platform-specific code it could not run) and how to check each one

No audit certifies code as ready on its own. It reports what was checked, how, and what remains open.
