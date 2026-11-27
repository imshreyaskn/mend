// trace-check: only real, running tests and real evidence count.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SCRIPTS, makeRepo, run } from './helpers.mjs';

const PLAN = `# Plan
Slug: \`seek\` · Key: \`SEEK\` · Class: **2** (seek bar)

| ID | Requirement | Verify | Phase |
|---|---|---|---|
| REQ-SEEK-001 | Seek shall clamp to [0, duration]. | T | P1 |
| REQ-SEEK-002 | State shall be \`'idle' \\| 'paused'\`. | T | P1 |
| REQ-SEEK-003 | Seek bar shall track the finger on device. | D | P2 |
`;

function setup(testSource, log = '') {
  const repo = makeRepo();
  repo.write('.mend/seek/plan.md', PLAN);
  repo.write('.mend/seek/log.md', log);
  repo.write('src/__tests__/seek.test.ts', testSource);
  return repo;
}

const trace = (repo, ...args) => run(SCRIPTS.trace, ['.mend/seek/plan.md', '--root', '.', ...args], { cwd: repo.dir });

describe('trace-check', () => {
  test('a real test title traces its requirement; an escaped pipe does not break the table', () => {
    const repo = setup("it('REQ-SEEK-001: clamps', () => {});\nit('REQ-SEEK-002: states', () => {});\n");
    try {
      const r = trace(repo, '--through', 'P1');
      assert.equal(r.status, 0, r.stdout);
    } finally { repo.cleanup(); }
  });

  test('comments, describe titles, .todo, .skip and xit do not count', () => {
    const repo = setup([
      '// REQ-SEEK-001 covered here',
      "describe('REQ-SEEK-001 suite', () => {",
      "  it.todo('REQ-SEEK-001: todo');",
      "  it.skip('REQ-SEEK-001: skipped');",
      "  xit('REQ-SEEK-001: x');",
      '});',
      "it('REQ-SEEK-002: states', () => {});",
    ].join('\n'));
    try {
      const r = trace(repo, '--through', 'P1');
      assert.equal(r.status, 1);
      assert.match(r.stdout, /REQ-SEEK-001 is verified by test/);
    } finally { repo.cleanup(); }
  });

  test('regression: tests inside describe.skip and xdescribe do not count', () => {
    const repo = setup([
      "describe.skip('skipped block', () => {",
      "  it('REQ-SEEK-001: clamps (skipped)', () => { expect(f('a (b')).toBe(1); });",
      '});',
      "xdescribe('also skipped', () => { it('REQ-SEEK-002: states', () => {}); });",
    ].join('\n'));
    try {
      const r = trace(repo, '--through', 'P1');
      assert.match(r.stdout, /REQ-SEEK-001 is verified by test/);
      assert.match(r.stdout, /REQ-SEEK-002 is verified by test/);
    } finally { repo.cleanup(); }
  });

  test('a test after a skipped block still counts', () => {
    const repo = setup("describe.skip('s', () => { it('x', () => {}); });\nit('REQ-SEEK-001: clamps', () => {});\nit('REQ-SEEK-002: s', () => {});\n");
    try { assert.equal(trace(repo, '--through', 'P1').status, 0); } finally { repo.cleanup(); }
  });

  test('regression: evidence that mentions "later" or "todo" in passing is accepted', () => {
    const repo = setup("it('REQ-SEEK-001: c', () => {});\nit('REQ-SEEK-002: s', () => {});\n",
      'EVIDENCE REQ-SEEK-003 [D]: dragged on a Pixel 7 dev build -> audio resumed 2 s later, no todo items left on screen\n');
    try { assert.equal(trace(repo).status, 0, trace(repo).stdout); } finally { repo.cleanup(); }
  });

  test('evidence whose observation starts with a not-done word is rejected', () => {
    for (const observation of ['pending device run', 'Not yet demonstrated', 'TODO', 'TBD']) {
      const repo = setup("it('REQ-SEEK-001: c', () => {});\nit('REQ-SEEK-002: s', () => {});\n",
        `EVIDENCE REQ-SEEK-003 [D]: Pixel 7 -> ${observation}\n`);
      try {
        const r = trace(repo);
        assert.equal(r.status, 1, observation);
        assert.match(r.stdout, /REQ-SEEK-003 needs an EVIDENCE line/);
      } finally { repo.cleanup(); }
    }
  });

  test('--report counts only tests that passed', () => {
    const repo = setup('');
    try {
      repo.write('jest.json', JSON.stringify({ testResults: [{ name: `${repo.dir}/src/__tests__/seek.test.ts`, assertionResults: [
        { title: 'REQ-SEEK-001: clamps', fullName: 'seek REQ-SEEK-001: clamps', status: 'passed' },
        { title: 'REQ-SEEK-002: states', fullName: 'seek REQ-SEEK-002: states', status: 'pending' },
      ] }] }));
      const r = trace(repo, '--through', 'P1', '--report', 'jest.json');
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /REQ-SEEK-001 is verified by test/);
      assert.match(r.stdout, /REQ-SEEK-002 is verified by test/);
    } finally { repo.cleanup(); }
  });

  test('--report rejects a file that is not a test report', () => {
    const repo = setup('');
    try {
      repo.write('bad.json', '{"hello": 1}');
      assert.equal(trace(repo, '--report', 'bad.json').status, 2);
    } finally { repo.cleanup(); }
  });

  test('IDs from another plan key never satisfy this plan', () => {
    const repo = setup("it('REQ-AUTH-001: lockout', () => {});\n");
    try { assert.match(trace(repo, '--through', 'P1').stdout, /REQ-SEEK-001 is verified by test/); } finally { repo.cleanup(); }
  });

  test('structure check catches bad methods, undefined IDs and unmitigated hazards', () => {
    const repo = makeRepo();
    try {
      repo.write('plan.md', `Class: **3**\n\n| ID | Requirement | Verify | Phase |\n|---|---|---|---|\n| REQ-XX-001 | a | Inspection | P1 |\n\n| ID | Hazard | Cause | Mitigated by |\n|---|---|---|---|\n| HAZ-XX-001 | b | c | TBD |\n\nSee REQ-XX-009.\n`);
      const r = run(SCRIPTS.trace, ['plan.md', '--structure-only'], { cwd: repo.dir });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /verification method "INSPECTION"/);
      assert.match(r.stdout, /REQ-XX-009 is mentioned but no table row defines it/);
      assert.match(r.stdout, /HAZ-XX-001 has no mitigating requirement/);
    } finally { repo.cleanup(); }
  });
});
