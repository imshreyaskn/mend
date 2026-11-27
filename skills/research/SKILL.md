---
name: research
description: Research the cleanest proven way to build a stated software goal before any code is written. Check the premise, then find what already exists in the codebase, the platform and the ecosystem. Compare options including "build it" and "do less", vet every candidate dependency against live registry and advisory data, and learn how the approach has failed for others. The output is a short decision brief. Use when the user runs /mend:research, asks for mend research, wants the best proven way to build something to a "NASA-grade", high-assurance or similar standard, or wants a library choice vetted before adding it. Not for open-ended research reports , brainstorming or quick "is there a library for X" questions.
argument-hint: "[goal]"
---

# Mend research

Much of the worst code is invented, not just written badly: a solved problem solved again, worse. Its twin is the dependency added on a hunch. In one study, about one in five packages recommended by LLMs did not exist, and attackers register those names. This skill finds the boring, proven answer, and proves it with evidence rather than memory.

Input: `$ARGUMENTS`, the goal. Output: `.mend/<slug>/brief.md` (slug: two to four words, kebab-case), built from [assets/brief-template.md](assets/brief-template.md).

## 0. Restate the goal and check the premise

- **Restate the goal in observable terms:** what will the user see or be able to do when it is done?
- **Check the premise before researching a solution.** Read the code involved: is the problem real, and is the requested fix the right one? Ask "why" once to find the underlying need. If the user's proposed approach is worse than an alternative, say so, with reasons. Agreeing with a weak plan is the most expensive kind of politeness.
- **Collect the real constraints from the project,** not from assumptions. These include versions (read `package.json`: React Native, Expo SDK, TypeScript), existing dependencies and conventions, `CLAUDE.md` / `AGENTS.md`, performance and offline needs, and licences. Note where each constraint came from.
- **Classify the work** with `${CLAUDE_SKILL_DIR}/../plan/references/criticality.md`. The class decides how deep to go: Class 1 needs only a codebase check, Class 4 needs everything below.
- **If an ambiguity would send the research in different directions,** ask one question now, with options. Otherwise state your assumption and continue.

## 1. Search in order of cost and trust

Stop at the first level that fully solves the goal. Record what you found at each level you checked.

1. **This codebase.** Grep for existing implementations, utilities, hooks, half-finished attempts, and past decisions (docs, ADRs, `git log -S '<term>'`). Code that is already there, tested and understood beats any library.
2. **The platform.** Language and runtime built-ins, and the framework's own SDK. For Expo apps, the SDK's bundled modules come first. **Feature-test built-ins in the target runtime instead of trusting memory.** React Native 0.88, for example, has `AbortSignal.timeout` but no global `structuredClone` and no `crypto.randomUUID`. `node -e` and Jest run on Node, not Hermes, so they will say "yes" for APIs the app does not have. Check the React Native source for the installed version, or log `typeof <api>` in a development build on a device or simulator. If neither is possible now, record it as an assumption the plan must verify.
3. **Dependencies already installed** that can do it.
4. **The ecosystem.** Look in this order:
   - the framework's official docs and recommended approach
   - well-adopted libraries
   - published patterns
   
   Read primary sources: documentation, changelogs, issue trackers and source code, not listicles. Use whatever search tools this session has (web search, Exa, Firecrawl, library-docs tools such as Context7). For React Native libraries, check React Native Directory. For sites that block fetching, use a real browser tool if one is available.
5. **How it fails (Class 3 and 4).** Search issue trackers and postmortems for the approach and each candidate: "<library> memory leak", "<library> crash android", "why we moved away from <library>", and breaking changes in the last few releases. The failure modes the docs leave out are the ones that will reach production.

## 2. Compare the options

Always put these on the table, even if only to rule them out:
- reuse existing code
- a platform built-in
- the best library
- write it ourselves
- **do less**: a smaller requirement that solves most of the need

Compare them on fit with the constraints, cost to adopt, cost to own (maintenance, upgrades, bundle size, native build impact), reversibility, and the quality of the evidence behind each.

Decision rules, in order:
1. **A feature-tested platform built-in wins.** Then existing code. Then existing dependencies.
2. **Write it yourself** if it is around 30 lines or fewer, and not in a subtle domain. Subtle domains are cryptography, dates and time zones, Unicode and internationalisation, parsing untrusted input, security, and concurrency primitives. For those, use a proven library even when the code looks small.
3. **Boring beats novel.** A library that brings a new paradigm (state management, data layer, navigation, styling system) spends one of the team's few "innovation tokens", and needs the user's explicit approval.
4. **Prefer the framework's officially recommended solution** when it meets the requirements.
5. **A library that does ten times what you need is a cost, not a bonus.**

## 3. Vet every candidate dependency with live data

From the project root, run:

```
node "${CLAUDE_SKILL_DIR}/scripts/vet-package.mjs" <package> [more packages...]
```

It checks:
- that the package and version exist
- deprecation
- known vulnerabilities and malware (OSV)
- install scripts
- age, adoption and maintainers
- provenance, and trust downgrades between versions
- the source repository (archived, last push, OpenSSF Scorecard)
- similarly named, more popular packages (typo-squats)

In React Native and Expo projects, including monorepos with the app under `apps/` or `packages/`, it also checks New Architecture support, Expo Go compatibility, and whether the Expo SDK already bundles the package. Its first line says whether those checks ran. A failed check counts as unknown, never as a pass. Exit codes: 0 all OK, 1 at least one REJECT, 3 at least one REVIEW.

- **REJECT:** out. If a name does not exist, never install a similar-sounding one. Search again by what it should do.
- **REVIEW:** resolve each item explicitly in the brief, or drop the package.
- **OK:** also skim the README, the last few releases, and the open critical issues. If you will use only a small part of the package, read that part's source.

In Expo apps, the brief should say to install with `npx expo install <package>` so the version matches the SDK.

## 4. Verify the claims that carry the decision

- Mark every claim in the brief **[read]** (from a source you read this session) or **[recalled]** (from memory). A recalled claim that the recommendation depends on must be verified, or flagged as a risk.
- Check API facts against the docs for the **installed** version, not the latest.
- When a critical assumption is cheap to test, test it with a throwaway spike (Class 0): feature-test the built-in, call the API, run the library's minimal example. Then delete the spike.

## 5. Write the brief

Use the template, and keep it short, about one to two pages. The recommendation is two sentences: what to use and why it beats the runner-up. Name what evidence would change your mind. Open questions are only the ones whose answer changes the plan.

## 6. Hand over

Tell the user:
- the recommendation and the runner-up
- each dependency and its vet verdict
- anything you pushed back on in the original ask
- the open questions

For Class 2 and up, suggest `/mend:plan` next.

## Research smells

Stop and fix the research if you catch any of these:
- Recommending the first library found, or the one with the most stars, without comparing.
- A package name from memory with no vet output.
- No "write it ourselves" or "do less" option considered.
- Citing blog listicles instead of documentation, issues and source code.
- Claims about versions without checking which version is installed.
- Ignoring code already in the repository.
- A brief that lists pros and cons but never decides.
