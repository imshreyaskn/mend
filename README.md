# mend

**Spacecraft-grade discipline for AI coding agents.**

mend is four Claude Code skills that take a change from idea to sign-off the way safety-critical teams do it: research the approach, plan it as checkable promises, build it test-first, then audit it with independent reviewers who have to prove every finding.

It is built from a research base of more than 330 sources: NASA and JPL engineering standards, 36 documented software disasters, and the 2025–2026 studies on what actually makes AI-written code better or worse. Every rule in it traces to one of them.

```
/mend:research  →  /mend:plan  →  /mend:execute  →  /mend:audit
   brief.md          plan.md          log.md            audit.md   (in .mend/<slug>/)
```

---

## Why this exists

AI agents write code fast. The independent evidence says that code costs more than it looks:

- **Quality debt that lasts.** Two Carnegie Mellon difference-in-differences studies of real GitHub repos found that adopting AI agents brought a **persistent ~18–30% rise in static-analysis warnings and ~39–41% rise in code complexity**, while the speed gains faded ([arXiv 2511.04427](https://arxiv.org/abs/2511.04427), [arXiv 2601.13597](https://arxiv.org/abs/2601.13597)).
- **Agents game tests.** On ImpossibleBench, where any passing result counts as cheating, frontier models cheated on **50–76%** of tasks. Claude models did it mostly by **editing the tests** ([arXiv 2510.20270](https://arxiv.org/html/2510.20270v1)).
- **Invented dependencies.** About **19.7%** of packages recommended by code models did not exist, and the fake names repeat across runs, so attackers can register them ([USENIX Security 2025](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen)).
- **AI review misses most of it.** On realistic pull requests, AI reviewers catch roughly **a third to half** of what careful humans flag. A reviewer told to find problems always finds *something*.
- **Prompts don't fix it.** Rules files barely move correctness, and in one study random rules helped as much as curated ones. "Don't be sycophantic" helps far less than a procedure with a legitimate way out.

What does work, every time it has been measured, is **an external signal the model cannot argue with**: a type checker, a linter, a test the agent is not allowed to edit, a verifier that has to reproduce a failure. mend is built around that.

---

## What makes it different

**Rigor scales with risk.** Every change gets a criticality class, adapted from NASA NPR 7150.2D, the NASA Software Safety Guidebook and DO-178C. A button colour gets a quick gate. A recording pipeline gets hazard analysis, traced requirements and six independent review lenses. Applying Class 4 ceremony to a typo is its own kind of slop.

| Class | Worst credible outcome | What mend demands |
|---|---|---|
| **4 Critical** | Data loss, money, security, lockout | Hazard analysis (light STPA), safe-state checklist, field kill switch, mutation testing, complexity ≤ 10, six audit lenses |
| **3 Core** | A core flow breaks, nothing lost | Hazards and invariants, explicit state machine, property tests, three audit lenses, user-approved plan |
| **2 Standard** | A feature is wrong, contained | Requirements with IDs, tests before code, traceability check, one reviewer |
| **1 Cosmetic** | Visual only | The gate |
| **0 Spike** | Nothing, throwaway | Timebox; never merged |

**Gates, not vibes.** The deterministic checks run before any LLM judgement: the project's type check, lint and tests against a recorded baseline, plus mend's own scanners. A check that cannot run counts as *not verified*, never as a pass.

**Evidence or it didn't happen.** "Tests pass" means nothing on its own. Every claim of success carries the command and the result line. Every requirement is traced to a test named for it, or to recorded evidence, and a script checks the traces.

**Tests are the specification.** The agent may never change an expected value, delete an assertion or skip a test to get green. If a test looks wrong, the agent has a sanctioned exit (`BLOCKED: <what> because <evidence>`). Giving agents that exit cut one model's test-cheating from 54% to 9% in the benchmark above.

**Independent review, then try to disprove it.** Following NASA's IV&V, the audit runs in a fresh context that never saw the code being written. Its reviewer lenses run as parallel subagents. Verifiers then try to *refute* each finding, ideally with a failing test, so you get only findings that survive.

**Every finding gets an answer.** Borrowed from JPL's SCRUB process, every finding is dispositioned Agree, Disagree or Discuss. Only you can accept the risk of an open major finding, and that acceptance is logged in your words.

**Lessons from real disasters.** The audit sweeps for 58 code patterns behind documented failures, each with a concrete detection: Ariane 5's unchecked narrowing, the Mars Climate Orbiter's unit mix-up, Knight Capital's reused flag, Cloudflare's leap-second negative duration, CrowdStrike's field-count mismatch, Heartbleed's trusted length, and more.

---

## The four skills

### `/mend:research`: find the proven way before writing code
- Restates the goal and **challenges the premise**: is this the right problem, and is "do less" an option?
- Searches in order of cost and trust: your codebase, the platform's built-ins, then the ecosystem.
- Compares real options side by side, including "build it" and "don't".
- **Vets every candidate dependency against live data**: existence, deprecation, known vulnerabilities and malware (OSV), install scripts, age, adoption and maintainers, provenance downgrades, repository health (OpenSSF Scorecard), and look-alike names. This catches hallucinated and typo-squatted packages before they reach your lockfile. In React Native and Expo projects it also checks New Architecture and Expo compatibility.
- Learns how the approach has failed for others (issues, postmortems) for critical work.
- Output: a short decision brief.

### `/mend:plan`: turn the goal into checkable promises
- Assigns the class with a one-line reason.
- Writes numbered "shall" requirements (`REQ-KEY-001`), each with a verification method: test, analysis, inspection or demonstration.
- For risky work: **hazards** (unsafe outcomes, not bugs), each mitigated by named requirements, plus invariants and a state and lifecycle design.
- The least design that meets the requirements, with deep modules and no speculative layers.
- Risk-ordered phases. Phase 1 is a tracer bullet through every layer, and every exit criterion is a command.
- **Attacks itself before you build**: a pre-mortem plus an independent fresh-context review, with every finding dispositioned.

### `/mend:execute`: build it without duct tape
- Tests are written from the requirements before the code, with the requirement ID in the test title.
- Eight rules that never bend: evidence for every claim, stop the line on anything unexplained, no duct tape, the exit is always open, tests are the spec, smallest correct change, use what exists, never describe code you haven't opened.
- An **80-entry duct-tape registry**: every common shortcut (`as any`, empty catch, `setTimeout` to wait for layout, skipped tests and so on), what it hides and the real fix.
- A **correct-by-construction guide**: parse, don't validate; pure reducers with effects at the edge; assertions that stay on in production (as JPL flew them); bounded everything; injected clock, randomness and network; property and stateful tests; formal models where they pay.
- Phase checkpoints, so every phase and audit has an exact point to diff against.

### `/mend:audit`: independent sign-off with proof
- Mechanical evidence first: the gate against baseline, the duct-tape scan, traceability, extra analyzers (Knip, expo-doctor, npm audit), and coverage of changed lines.
- For Class 4: complexity limits and **mutation spot-checks**. It inverts critical conditions and confirms a test fails.
- Up to six independent lenses as parallel subagents: **A** requirements and correctness, **B** disaster failure patterns, **C** design and reinvented wheels, **D** adversary (lifecycle, network, time, concurrency, environment), **E** safe state, **F** security.
- Verifier subagents try to refute every finding: CONFIRMED, PLAUSIBLE or REFUTED.
- A findings ledger with severities S1 to S4 and a verdict: **GO**, **GO WITH ACCEPTED RISK** or **NO-GO**.
- Always ends with a **Not verified** section, so you know exactly what still needs a real device, a real network or a human.

---

## Bundled tools

Plain Node scripts with no dependencies to install. They need Node 18 or later.

| Script | What it does |
|---|---|
| `research/scripts/vet-package.mjs` | Vets npm packages against the npm registry, OSV and deps.dev (public APIs, no keys). Exit 0 pass, 1 reject, 3 review. |
| `execute/scripts/checkpoint.mjs` | Snapshots the working tree, untracked files included, under `refs/mend/`, so audits diff against exactly what was reviewed. |
| `audit/scripts/ducttape-scan.mjs` | Scans a diff with 42 rules: suppressions, `any` and double casts, swallowed errors and promises, skipped or focused tests, sleeps in tests, wall-clock durations, hardcoded secrets, weakened type or lint config, removed assertions, and more. |
| `audit/scripts/trace-check.mjs` | Proves the plan, the tests and the evidence agree: every tested requirement has a real test named for it (skipped tests and comments do not count), every other requirement has logged evidence, and every hazard names an existing mitigating requirement. |

---

## Install

In Claude Code:

```
/plugin marketplace add imshreyaskn/mend
/plugin install mend@mend
```

Or copy the four folders from `skills/` into `~/.claude/skills/`, keeping their names: the skills call each other's scripts by relative path.

## Use

```
/mend:research add offline upload retry to the recorder
/mend:plan .mend/offline-retry
/mend:execute .mend/offline-retry P1
/mend:audit .mend/offline-retry
```

Each step reads the previous step's file, and you can enter at any point. Run `/mend:audit` on its own against a branch to audit work that was never planned. Run the audit in a **fresh session**, not the one that wrote the code: that independence is what makes it worth trusting.

---

## Sources it stands on

- **NASA and JPL:** NPR 7150.2D software classification; NASA-STD-8739.8B and the Software Safety Guidebook; the JPL Institutional Coding Standard and Power of Ten; Gerard Holzmann's *Mars Code*, *SCRUB*, *Assertive Testing* and *The Value of Doubt*; SWE-134 safe-state requirements; IV&V practice.
- **Aviation:** DO-178C design assurance levels. **Safety engineering:** STPA hazard analysis.
- **Incident record:** postmortems from Ariane 5, Mars Climate Orbiter, Mars Polar Lander, Mars Pathfinder, Spirit, Schiaparelli, Starliner, Therac-25, the Patriot at Dhahran, the Boeing 737 MAX and 787, Knight Capital, Cloudflare, CrowdStrike, Fastly, Facebook, AWS, Google Cloud, Azure, GitLab, Atlassian, Heartbleed, Log4Shell, left-pad, event-stream and xz-utils.
- **AI coding research, 2025–2026:** CMU's adoption studies, METR's randomised trials, ImpossibleBench, the USENIX package-hallucination study, independent AI-review benchmarks (c-CRAB and others), research on sycophancy and self-correction, and Anthropic's and OpenAI's own guidance on harness engineering.

## Honest limits

mend raises the floor. It does not certify anything. No audit makes code flight-ready on its own: it reports what was checked, how, and what remains open. Most of the evidence on AI agents is benchmark evidence, and no study yet measures long-term effects on real repositories. mend is designed around that uncertainty by trusting tools over prose and proof over confidence.

## Licence

MIT
