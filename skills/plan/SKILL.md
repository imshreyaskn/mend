---
name: plan
description: Turn a goal or a mend research brief into a mend plan, a set of checkable promises. It covers a criticality class, numbered "shall" requirements each with a verification method, hazards and invariants for risky work, the least design that meets them, and risk-ordered phases whose exit criteria are commands. Use when the user runs /mend:plan, asks for a mend plan, asks to plan something to a "NASA-grade", high-assurance or similar standard, or a .mend/ brief exists and the next step is planning. Not for everyday task breakdowns or ordinary implementation plans (use the normal planning workflow), and not for one-line fixes or styling.
argument-hint: "[goal or .mend/slug/brief.md]"
---

# Mend plan

A plan is worth only the promises in it that someone can check. The evidence on agent planning is blunt. Heavy spec documents do not reduce defects. A spec used as a test oracle does: one study measured +38 points of correct code when the tester got the spec as a checklist. So this skill writes as little prose as possible, and makes every line something a test, a command or a reviewer can verify. A plan longer than the code it describes is a red flag.

Input: `$ARGUMENTS`, either a goal or a brief at `.mend/<slug>/brief.md`. Output: `.mend/<slug>/plan.md`, built from [assets/plan-template.md](assets/plan-template.md).

## 0. Ground and classify

Read the code this change touches before planning it. A plan for code you have not opened is fiction. If there is no brief and the work looks like Class 3 or 4, run `/mend:research` first, or at least check the codebase, the platform built-ins and the obvious libraries yourself.

Classify the work using [references/criticality.md](references/criticality.md), and write the one-line reason. Pick a **Key** for this plan: 2 to 8 capital letters or digits, not used by another plan under `.mend/`. Every ID carries it (`REQ-PLAY-001`), so flights in the same repo never collide.

The class decides which template sections you fill:
- **Class 0 (spike):** write down the question the spike answers and its timebox. No plan file.
- **Class 1 (cosmetic):** no plan file. State the intent and the gate command, then go.
- **Class 2:** the header (with the size estimate) plus sections 1, 2, 4, 8 and 9.
- **Class 3:** all sections. Hazard rows come from the failure modes of each dependency and each state. Needs the user's approval.
- **Class 4:** all sections. Hazard rows come from the control-action table. Add the safe-state checklist and a field-disable path. Needs the user's approval.

If the goal itself looks wrong, misread, or much bigger than it needs to be, say so now, before planning a solution to the wrong problem.

## 1. Requirements

Requirements say what the system does, never how. Each row is one observable behaviour written as "shall", with numbers wherever a number exists (timeouts, sizes, counts, latencies). Each row gets a verification method: **T**est, **A**nalysis, **I**nspection or **D**emonstration. Prefer T. Use D only for what can only be seen on a device, and write the demo steps in section 9. Each row also names the phase that first delivers it.

Write the unhappy paths. They are where agent code fails and where the original request is usually silent:
- For every external dependency (network, storage, native module, permission, third-party SDK): what happens when it is slow, fails, or returns garbage.
- For every input: empty, huge, malformed, duplicated, out of order, over its limit.
- For every lifecycle event that applies: backgrounded, killed, restarted, offline, low memory, interrupted (calls, other audio), permissions revoked.
- "Shall not" requirements are allowed and valuable: "The app shall not delete a local recording before the server confirms its checksum."

Check coverage both ways. Every behaviour in the mission maps to a requirement, and every requirement maps back to the mission. A requirement that serves nothing in the mission is gold-plating, so cut it.

Bad: "Handle errors gracefully." "Implement the sync service." "Use Zustand."
Good: "REQ-SYNC-007: When an upload fails with a network error, the app shall retry at most 5 times with full-jitter backoff (1 s base, 30 s cap) and then show a retry action. | T | P2"

## 2. Hazards and invariants (Class 3 and 4)

**Hazards** are unsafe outcomes, not bugs. Every hazard becomes a `HAZ-<KEY>-nnn` row naming the requirements that prevent it; `trace-check` fails a Class 3 or 4 plan with no hazard rows.
- **Class 3:** list what goes wrong when each dependency fails, and in each state.
- **Class 4:** fill in the control-action table in [references/criticality.md](references/criticality.md). Ask of every action the software controls (delete, send, charge, overwrite, sync) whether it is unsafe when not done, done at the wrong time, done in the wrong order, or stopped too soon. Each "yes" is its own hazard row. Then answer the safe-state checklist item by item, including how the feature is switched off in shipped apps.

If no requirement can prevent a hazard, that is a design problem; fix it now.

**Invariants** are facts that must always hold ("queue length ≤ 100", "a track is never playing and loading at once"). Each says how it is enforced. Prefer a type that makes the violation unrepresentable, then an assertion, then a property test.

## 3. Design: the least design that meets the requirements

Start from the brief's recommendation and the patterns already in the codebase. Reuse beats invention. Then work through:

- **States first.** If anything has a lifecycle (player, upload, auth session, form), list its states and legal transitions before anything else. Model it as a discriminated union or explicit state machine so illegal states cannot be represented. Most "edge case" bugs are unmodelled states.
- **Trust boundaries.** Name every place untrusted data enters: network responses, storage, deep links, push payloads, user input, native modules, remote config. Each one gets a schema that parses the data there, plus a decision about what happens when input is malformed or over a limit (reject the item, keep the last good value, or degrade). Inside the boundary, trust the types.
- **Limits.** Every loop, retry, queue, cache, payload and timeout gets a number in the plan. Take each one from a documented upstream limit or a measurement, with headroom, and say where it came from. Unbounded anything is a requirement nobody wrote down, and an invented limit that rejects real data is an outage waiting to happen.
- **Deep modules.** Prefer few modules with small interfaces that hide real complexity over many thin pass-through layers. Every new concept, file, abstraction or dependency must justify itself against the requirements.
- **Size estimate.** Record net lines, new files and new dependencies in the header. Execution checks scope creep against it. If the estimate is large for the mission, look for the smaller design first.
- **Decisions.** Record each real decision: the alternatives rejected, why, and whether it is reversible. Spend care on the irreversible ones (data formats, public APIs, storage schemas).

The design patterns and their TypeScript idioms are in `${CLAUDE_SKILL_DIR}/../execute/references/correct-by-construction.md`. Read the sections that apply.

## 4. Phases

- **P1 is a tracer bullet:** the thinnest end-to-end slice through every layer, proving the riskiest integration works. Not "all the types first".
- **Then order by risk:** unknowns and irreversible parts early, polish late. Slice vertically by behaviour, never by layer (not "all DB, then all API, then all UI").
- **Make the change easy, then make the easy change.** If existing code must be reshaped first, that is its own behaviour-preserving phase, verified by the existing tests, separate from behaviour changes.
- **Each phase lists:** its goal, the requirements it delivers, the tests to write *before* the code, small steps that each end in a check, **exit criteria as exact commands** (including `trace-check ... --through Pn`), and rollback to the phase-start checkpoint.
- **Keep phases small** enough that one session can finish one, and a reviewer can read its diff in one sitting. Agent reliability drops sharply with task length.

## 5. Attack the plan before building it (Class 3 and 4)

1. **Pre-mortem.** Assume it is three months later and this shipped and failed. Write the three most likely reasons. Each must already be covered by a requirement or hazard, or be an accepted risk in section 10.
2. **Independent review.** Spawn one fresh-context subagent. Give it only the paths to the brief and the plan, not your reasoning or this conversation, and ask it to find: untestable or vague requirements, missing unhappy paths, missing or invented limits, over-design, and phases out of risk order. Ask for at most 10 problems it can point to, most severe first. If you cannot spawn subagents (for example, you are running as one), do this review yourself as a separate pass, and say in the summary that it was not independent.
3. **Disposition every finding** as Agree (fix the plan), Disagree (give the evidence), or Discuss (needs the user). A finding with no disposition counts as Agree. This is JPL's SCRUB rule, and it stops review comments from evaporating.

## 6. Validate and hand over

Run the structural check. It fails on duplicate IDs, missing verification methods or phases, mixed keys, hazards with no mitigating requirement, and Class 3 or 4 plans with no hazards:

```
node "${CLAUDE_SKILL_DIR}/../audit/scripts/trace-check.mjs" .mend/<slug>/plan.md --structure-only
```

Then show the user a short summary: class and reason, the size estimate, counts of requirements, hazards and phases, the decisions marked irreversible, and every Discuss item.

For Class 3 and 4, ask for approval. When the user approves, set the header to `Status: approved by <user> on <YYYY-MM-DD>`, and quote their approval in the log. Their answers to the Discuss items are part of the plan, so write them in. After approval, any change to a requirement needs the user's OK again. `/mend:execute` refuses an unapproved Class 3 or 4 plan.

## Plan smells

Stop and fix the plan if you see any of these:
- Requirements that are tasks ("implement X") or designs ("use library Y").
- Any requirement without a number where a number exists.
- "Gracefully", "robust", "seamless", "properly", "as needed". These words hide missing requirements.
- Phases by layer instead of by behaviour.
- Exit criteria that are not commands.
- A design with more new abstractions than requirements need.
- No unhappy-path requirements at all.
- A limit with no source.
- A plan that restates the request without adding a single number, limit or failure case.
