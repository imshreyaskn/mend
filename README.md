# mend

Four Claude Code skills for building software changes you can trust: research the approach, plan it as checkable promises, build it test-first, and audit it independently.

Rigor scales with risk. Every change gets a criticality class from 0 (spike) to 4 (critical: data loss, money, security). A button colour gets a quick gate; a recording pipeline gets hazard analysis, traced requirements and six independent review lenses. The scheme borrows from NASA NPR 7150.2D, the NASA Software Safety Guidebook and DO-178C, adapted for app and service code.

## Skills

| Command | What it does |
|---|---|
| `/mend:research` | Checks the premise, finds what already exists (codebase, platform, ecosystem), compares options including "do less", vets dependencies against live registry and advisory data. Writes a short decision brief. |
| `/mend:plan` | Turns the goal into a plan: class, numbered "shall" requirements each with a verification method, hazards and invariants for risky work, and risk-ordered phases whose exit criteria are commands. |
| `/mend:execute` | Builds the plan with tests written from the requirements first, bounded everything, no duct tape, and command output for every claim of success. |
| `/mend:audit` | Independent review: deterministic checks first, then parallel reviewer lenses, then verifiers that try to refute each finding. Ends with GO / NO-GO and a findings ledger. |

Work is recorded under `.mend/<slug>/` in your repo: `brief.md`, `plan.md`, `log.md`, `audit.md`.

## Install

In Claude Code:

```
/plugin marketplace add imshreyaskn/mend
/plugin install mend@mend
```

Or copy the four folders from `skills/` into `~/.claude/skills/`, keeping their names: the skills reference each other's scripts by relative path.

The bundled scripts need Node 18 or later:

- `skills/research/scripts/vet-package.mjs`: vets an npm package against the npm registry, OSV and deps.dev (public APIs, no keys)
- `skills/execute/scripts/checkpoint.mjs`: snapshots the working tree under `refs/mend/` so audits can diff against exactly what was reviewed
- `skills/audit/scripts/ducttape-scan.mjs`: flags workarounds in a diff (skipped tests, swallowed errors, `any` casts, and more)
- `skills/audit/scripts/trace-check.mjs`: checks that every requirement in a plan has a test or recorded evidence

## Licence

MIT
