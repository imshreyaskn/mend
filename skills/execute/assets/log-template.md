# Mend log: <slug>

Free-form notes are fine anywhere. The lines below have fixed formats because `trace-check` and `/mend:audit` read them. Write each one only when the thing it records is true.

```
BASELINE <date> base=<branch this work started from> <gate command>: <errors> type errors, <warnings> lint warnings, failing tests: <names or none>
CHECKPOINT <label> <sha>
EVIDENCE REQ-<KEY>-007 [D]: <what you did, e.g. steps on a Pixel 7 dev build> -> <what you observed>
APPROVAL <what was approved>: "<the user's words>" (<date>)
CHANGE REQ-<KEY>-007: <old wording> -> <new wording>; approved: "<the user's words>" (<date>)
DISPOSITION <rule> <file>: <why the warning is correct, naming the requirement that changed>
BLOCKED <what is wrong> because <evidence>
```

`EVIDENCE` needs both halves: the method after the colon and the observation after `->`. `trace-check` rejects an observation that says "pending", "not yet", "TODO" or "TBD".

## P1: <name>

### Step 1: <what>
- Changed: <files>
- Delivers: REQ-<KEY>-...
- Commands: `<command>` -> <result line>
- Decisions / deviations:
