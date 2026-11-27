# Criticality classes

Rigor costs time. Spend it where failure hurts. This scheme adapts NASA NPR 7150.2D software classes, the NASA Software Safety Guidebook's risk index, and DO-178C design assurance levels to app and service code. All four mend skills read the class from the plan and scale their work to it. Applying Class 4 ceremony to a button colour is its own kind of slop.

## Assigning a class

1. **List what can go wrong** for the user if this code misbehaves: data lost or corrupted, money moved wrongly, privacy leaked, locked out, app unusable, wrong output shown, cosmetic glitch.
2. **Take the worst credible outcome** and read off the class below.
3. **If two classes seem to apply, take the higher.** (NPR 7150.2D, rule D.2.)
4. **Class follows the hazard trace, not the folder.** A small helper that decides whether to delete a file is Class 4 even if it lives in `utils/`. Code that causes, controls, mitigates or detects a hazard takes that hazard's class.
5. **Write the one-line reason** next to the class in the plan. "Class 3: playback state machine; a bug strands the user mid-track but nothing is persisted."
6. **Re-classify when scope changes.** Discovering mid-build that a feature touches persisted data moves it up.

## The classes

| Class | Worst credible outcome | Typical examples |
|---|---|---|
| **4 Critical** | Irreversible harm: data loss or corruption, money, security or privacy breach, account lockout, legal exposure, a crash at app start for everyone | Auth and sessions, payments, permissions, recording or editing anything the user would lose (takes, notes, drafts), migrations and destructive scripts, sync and conflict resolution, encryption, anything that executes remote config or content, background jobs that can drain battery or data |
| **3 Core** | A core flow breaks or misbehaves. The user notices and can recover, and no data is lost | Playback (nothing persisted), navigation shell, read-only offline cache, lifecycle and state machines that persist nothing, shared libraries many screens depend on |
| **2 Standard** | A feature is wrong or crashes, with a contained blast radius | Ordinary screens with logic, forms, list and detail views, API client calls for non-critical data |
| **1 Cosmetic** | Visual or copy defect only | Styles, layout, text, icons, docs |
| **0 Spike** | Nothing. Throwaway | Experiments and prototypes. Never merged into main, never imported by Class 2+ code |

## What each class requires

| Skill | 0 Spike | 1 Cosmetic | 2 Standard | 3 Core | 4 Critical |
|---|---|---|---|---|---|
| **Research** | none | check the codebase for existing pieces | brief: existing code, platform built-ins, options, vetted deps | full brief | full brief + how this approach has failed elsewhere (issues, postmortems) |
| **Plan** | timebox and question only | none; one-line intent | requirements with IDs, phases with exit criteria, size estimate | + assumptions, hazard rows (failure modes of each dependency and state), invariants, state/lifecycle design, limits, risks, user approval | + hazards derived from the control-action table below, the safe-state checklist, a field-disable path |
| **Execute** | no gates; label it a spike | gate + ducttape-scan on changed files | + tests written from requirements before code, REQ IDs in test titles, phase checkpoints, log | + property tests on logic, assertions at boundaries and on invariants, explicit state machine for any lifecycle | + pair assertions on contracts, demonic tests that force every defensive path, injected clock/random/network/storage, requirement tests written by a separate agent, cyclomatic complexity ≤ 10 per function |
| **Audit** | none | the gate | + trace-check, ducttape-scan, one combined reviewer; verify S1/S2 findings | + three independent lenses; verifiers batched by file | + adversary, safe-state and security lenses, mutation spot-check, optionally a reviewer from another model family (only with the user's explicit approval) |

**Approvals.** The user, never the agent, approves Class 3 and 4 plans, any waiver of a blocking scan rule (at every class), and any accepted risk in an audit. Record each approval in the log with the user's words and the date.

**Complexity, measured.** For Class 4, check cyclomatic complexity with ESLint's core rule on the changed files: `npx eslint --rule "complexity: [error, 10]" <files>`. If the project uses `eslint-plugin-sonarjs`, also keep `sonarjs/cognitive-complexity` at 15 or below. Below Class 4, treat complexity as a review heuristic, not a gate.

## Safe-state checklist (Class 4, from NASA SWE-134)

For any flow that can cause irreversible harm, the plan answers each line, or says why it does not apply:

- The system starts and restarts in a known safe state (no half-finished operation resumes blindly).
- Every transition between states is explicit, and illegal transitions are rejected.
- No single event or action can trigger the irreversible outcome. Destructive actions need two independent steps (for example confirm plus undo window, or a typed confirmation).
- Commands that arrive out of order, duplicated or stale are rejected or made harmless (idempotency keys, version checks).
- Inputs and outputs are integrity-checked at the boundary (schema, checksum, size limits taken from documented upstream limits).
- Prerequisites are checked immediately before the hazardous step, not only at the start.
- The system can always reach a safe state, including when the network, storage or a dependency fails partway.
- Failure is loud: the user and the logs both learn something went wrong.
- **It can be switched off in the field.** A shipped mobile binary cannot be recalled, so name the mechanism (remote feature flag, kill switch, server-side guard, OTA update) and test that switching it off leaves the app in a safe state.

## Hazard analysis (Class 4, light STPA)

For each thing the software controls (deletes, sends, charges, syncs, overwrites), ask the four STPA questions. **Every "yes, this could be unsafe" becomes its own `HAZ-` row in the plan's hazard table, mitigated by a requirement.** The control-action table is the working; the hazard rows are the result that tests and audits trace.

| Control action | Not provided causes harm? | Provided when unsafe causes harm? | Wrong timing or order causes harm? | Stopped too soon / applied too long causes harm? |
|---|---|---|---|---|
| e.g. delete local recording after upload | recordings pile up (minor) | upload not yet confirmed by server: data loss → HAZ | delete before checksum verified: data loss → HAZ | partial delete leaves orphan metadata → HAZ |
