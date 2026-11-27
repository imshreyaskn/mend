# Mend plan: <title>

Slug: `<slug>` · Key: `<KEY>` · Class: **<0-4>** (<one-line reason>)
Estimate: ~<N> net lines, <M> new files, <D> new dependencies
Status: draft
Brief: `.mend/<slug>/brief.md` · Log: `.mend/<slug>/log.md`

<!--
Key: 2-8 capital letters or digits, unique to this plan (e.g. PLAY, SYNC2). Every ID below carries it
(REQ-PLAY-001), so a second plan in the same repo never collides with this one.
Status: draft -> "approved by <user> on <YYYY-MM-DD>" (required before /mend:execute for Class 3 and 4)
-> in progress -> done. Only the user approves.
trace-check.mjs reads the Class line, the REQ and HAZ tables and the INV table: keep the ID in the first
column, the verification method in the third and the phase in the fourth.
-->

## 1. Mission
One paragraph: what changes for the user, and the observable signal that it worked.

## 2. Out of scope
What this plan deliberately does not do, so nobody builds it by accident.

## 3. Assumptions
Each one falsifiable. If an assumption is wrong, the plan changes.

| ID | Assumption | If wrong | How we check |
|---|---|---|---|
| ASM-<KEY>-001 | | | |

## 4. Requirements
One testable behaviour per row, written with "shall". Verify is any of **T**est, **A**nalysis, **I**nspection, **D**emonstration. Prefer T. Phase is where it is first delivered (P1, P2, ...).

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| REQ-<KEY>-001 | | T | P1 |

## 5. Hazards
Required for Class 3 and 4. Class 3: failure modes of each dependency and each state. Class 4: one row per "yes" in the control-action table (criticality.md). Each hazard names the requirements that prevent it.

| ID | Hazard (unsafe outcome) | Cause / control action | Mitigated by |
|---|---|---|---|
| HAZ-<KEY>-001 | | | REQ-<KEY>-00x |

## 6. Invariants
Facts that must hold at all times. Each becomes a type, an assertion, or a property test.

| ID | Invariant | Enforced by (type / assertion / property test) |
|---|---|---|
| INV-<KEY>-001 | | |

## 7. Design
- **Shape:** the modules, types and states, as a sketch. If there is a lifecycle, list its states and legal transitions.
- **Trust boundaries:** where untrusted data enters (network, storage, deep links, user input, native modules, remote config) and which schema parses it. What happens when the input is over a limit.
- **Limits:** every queue, retry, loop, cache, payload and timeout, with its bound and where the number came from.
- **Field disable (Class 4):** the flag, kill switch, server guard or OTA path that turns this off in shipped apps.
- **Decisions:**

| Decision | Alternatives rejected | Why | Reversible? |
|---|---|---|---|

## 8. Phases
Order by risk: the riskiest unknown goes first, and the first phase is a thin end-to-end slice (tracer bullet).

### P1: <name>
- **Goal:**
- **Requirements delivered:** REQ-<KEY>-...
- **Tests written first:** the REQ tests this phase writes before code
- **Steps:** small, each ending in a check
- **Exit criteria:** exact commands that must pass, plus `trace-check --through P1`
- **Rollback:** back to the phase-start checkpoint (`checkpoint.mjs --diff <slug>/<previous label>` shows what to undo)

## 9. Verification plan
How each method runs: the gate command (for example `npm run gate`), the test commands, the device or demo steps for every D requirement, and what gets inspected for every I requirement.

## 10. Risks and open questions

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
