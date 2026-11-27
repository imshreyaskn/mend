# Research brief: <title>

Slug: `<slug>` · Date: <YYYY-MM-DD> · Proposed class: <0-4> (<one-line reason>)

## 1. Goal, restated
What the user wants, in observable terms. If the goal as stated is the wrong goal, say so here and name the better one.

## 2. Premise check
Assumptions inside the request that turned out to be false or unproven, and what that changes.

## 3. Constraints
Platform, versions, performance budgets, offline, privacy, licences, team skills. Each one with where it came from (code, docs, user).

## 4. What already exists
- **In this codebase:** modules, patterns or utilities that already do part of this (file:line).
- **In the platform:** built-ins that cover it (language, runtime, framework SDK).
- **Off the shelf:** libraries and services, each vetted below.

## 5. Options

| Option | What it is | Fits constraints? | Cost to adopt | Cost to own | Reversibility | Evidence |
|---|---|---|---|---|---|---|

Include "write it ourselves" and "do nothing / smaller scope" as options. They win more often than people expect.

## 6. Dependency vetting
Paste `vet-package` output for every package still in the running. One line of judgement per package.

## 7. Recommendation
The option, in two sentences. Why it beats the runner-up. What would make you change your mind.

## 8. Known failure modes
How this approach has failed for other people (issues, postmortems, changelogs), and what that means for the plan.

## 9. Open questions
Only questions whose answer changes the plan. Who can answer each.

## Sources
Every claim above traces to one of these. Mark each [read] if you read it this session, or [recalled] if from memory.
