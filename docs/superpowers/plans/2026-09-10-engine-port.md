# Endless Memory Engine Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the listener-approved Endless Memory composition engine from an unversioned prototype directory into this git repo, publish it as `schmug/endless-memory` behind a required-check gate, and lock the approved sound behind a golden-output test.

**Architecture:** The engine is copied verbatim — no musical logic changes at all. A golden-output characterization test then pins the exact bytes that `station.mjs export` produces at two fixed anchor timestamps, so any later slice that disturbs the sound fails CI. The test spawns the real CLI inside a throwaway temp directory, so it exercises the true export path and never writes to the repo.

**Tech Stack:** Node 22 (ESM, `node:test`), Strudel 1.2.5 (test harness only), GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-10-engine-port-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Two shell variables are used throughout.** `$REPO` is this repository's root;
  `$PROTOTYPE` is the local, unversioned prototype directory the engine is copied
  from. Set both before running any command block:
  `REPO=$(git rev-parse --show-toplevel)` and `PROTOTYPE=<path to the prototype>`.
- **Node 22.** Verified working on v22.22.3. CI pins `node-version: '22'`.
- **`@strudel/core` is pinned to exactly `1.2.5`.** Version 1.2.6's published browser dependency fails to import under Node. Never relax this pin or the `overrides` block that enforces it.
- **`composer.mjs` must stay byte-identical to the prototype's.** No musical logic changes in this slice. This is the whole point of the port.
- **Source of truth for the copy:** `$PROTOTYPE/`. It is read-only for this work. Copy, never move — it is the only existing copy and remains a frozen reference.
- **Repo:** `schmug/endless-memory`, public.
- **License:** MIT, `Copyright (c) 2026 schmug`. Never a personal legal name.
- **Commit prefixes:** conventional — `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- **Every commit ends with:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Never** add `Signed-off-by`, and never set the commit author to Cory.
- **Gitignored derived artifacts:** `endless-memory.strudel`, `score-45min.json`, `listen.url`. All three embed the anchor timestamp they were generated with and churn on every run.
- **Report test results as counts** ("5 passing, 0 failing"), never as "tests pass".

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `composer.mjs` | Pure deterministic score model. Copied verbatim, never edited. | 1 |
| `station.mjs` | CLI: `export` / `weather` / `remember`. Copied verbatim, never edited. | 1 |
| `composer.test.mjs` | The 5 existing engine tests. Copied verbatim. | 1 |
| `journal.json` | The station's event log. Copied verbatim (empty). | 1 |
| `baselines/` | Earlier listener-approved scores, kept for comparison. | 1 |
| `research/` | Raw NWS + NOAA CO-OPS pulls. Evidence base for slice B. | 1 |
| `.github/workflows/ci.yml` | Runs `npm ci && npm test` on push and PR. Must land in task 1 so the check exists to be required in task 2. | 1 |
| `package.json` (`pretest`) | Generates the derived `.strudel` artifact that `composer.test.mjs:26` reads. Without it the suite cannot pass from a clean checkout. | 1 |
| `test/update-fixtures.mjs` | Fixture definitions + the temp-dir export helper. Exports `FIXTURES` and `exportFixture`. Also the `npm run fixtures` entry point. | 3 |
| `test/fixtures/*.strudel` | The pinned golden output. | 3 |
| `export.test.mjs` | Asserts export output matches the fixtures byte-for-byte. | 3 |
| `LICENSE` | MIT. | 4 |
| `README.md` | Copied verbatim in task 1, minimally edited in task 4. | 1, 4 |

---

### Task 1: Verbatim engine import and CI workflow

Lands directly on `main`. The repo has one commit (the spec) and no remote yet, so there is nothing to branch from and no gate to pass. The CI workflow must land here, not later, because a status check cannot be marked required until it has run at least once.

**Files:**
- Create (copied): `composer.mjs`, `station.mjs`, `composer.test.mjs`, `journal.json`, `package.json`, `package-lock.json`, `README.md`, `baselines/listener-approved-v1.strudel`, `baselines/listener-approved-v2.strudel`, `research/` (20 files)
- Create (new): `.github/workflows/ci.yml`
- Modify: `.gitignore` (copied, then extended)

**Interfaces:**
- Consumes: nothing.
- Produces: `composer.mjs` exporting `BPM`, `BARS`, `BAR_MS`, `EPOCH`, `hash(value)`, `pick(key, values)`, `atmosphere(bar, journal)`, `validate(journal)`, `identity(index, journal)`, `scene(index, journal)`, `patternSource(s)`. `station.mjs` is a CLI with no exports. A GitHub Actions job whose check context is `test`.

- [ ] **Step 1: Confirm the worktree before touching anything**

```bash
cd "$REPO" && pwd && git symbolic-ref --short HEAD && git log --oneline
```

Expected: the repository root, branch `main`, and exactly two commits — the spec (`docs: engine port design (slice 1)`) and this plan (`docs: engine port implementation plan`). Stop if anything differs — multi-clauding is common here and a stomped branch is expensive.

- [ ] **Step 2: Copy the engine files verbatim**

```bash
cd "$REPO"
SRC="$PROTOTYPE"
cp "$SRC/composer.mjs" "$SRC/station.mjs" "$SRC/composer.test.mjs" \
   "$SRC/journal.json" "$SRC/package.json" "$SRC/package-lock.json" \
   "$SRC/README.md" "$SRC/.gitignore" .
cp -R "$SRC/baselines" "$SRC/research" .
```

- [ ] **Step 3: Verify the copy is byte-identical**

```bash
cd "$REPO"
SRC="$PROTOTYPE"
for f in composer.mjs station.mjs composer.test.mjs journal.json package.json package-lock.json README.md .gitignore; do
  diff -q "$SRC/$f" "$f" || echo "DRIFT: $f"
done
diff -r "$SRC/baselines" baselines && diff -r "$SRC/research" research && echo "copy verified"
```

Expected: no `DRIFT:` lines and `copy verified`. Any output from `diff -q` is a failure — stop and investigate.

- [ ] **Step 4: Extend `.gitignore` with the derived artifacts**

Append to `.gitignore` (it currently contains only `node_modules/`):

```gitignore
# Derived from `node station.mjs export`. Each embeds the anchor timestamp it
# was generated with, so committing them means churn on every run. The README's
# "Try it" section regenerates them.
endless-memory.strudel
score-45min.json
listen.url
```

- [ ] **Step 5: Create the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm test
```

The job id `test` has no `name:`, so the status check context is exactly `test`. Task 2's ruleset references that string.

- [ ] **Step 6: Add the `pretest` script**

`composer.test.mjs:26` reads the generated artifact from disk and never creates it:

```javascript
const source=readFileSync(new URL('./endless-memory.strudel',import.meta.url),'utf8');
```

The prototype's suite only passed because an untracked `endless-memory.strudel` was sitting in that directory from a manual export. A clean checkout — which is exactly what CI does — fails test 3 with `ENOENT`. Task 1 must not end on a suite that cannot run from a clean tree.

Fix it in `package.json` only, so `composer.mjs`, `station.mjs` and `composer.test.mjs` stay byte-identical. Add `pretest` above `test`:

```json
  "scripts": {
    "pretest": "node station.mjs export 2026-09-11T14:00:00Z",
    "test": "node --test composer.test.mjs",
    "export": "node station.mjs export"
  },
```

The anchor is fixed rather than wall-clock so CI is reproducible run to run. It is the same anchor the `quiet-afternoon` fixture uses in task 3.

- [ ] **Step 7: Install and run the existing suite**

```bash
cd "$REPO" && npm ci && npm test 2>&1 | tail -15
```

Expected: `# pass 5`, `# fail 0`. Report the counts. If the count is not 5, stop — the copy is wrong.

- [ ] **Step 8: Confirm the derived artifacts are ignored**

```bash
cd "$REPO" && node station.mjs export 2026-09-11T14:00:00Z && git status --porcelain
```

Expected: the export prints a motif id, and `git status --porcelain` shows no entry for `endless-memory.strudel`, `score-45min.json` or `listen.url`. If any appears, `.gitignore` is wrong.

Then prove the suite survives a clean checkout, which is what CI will do:

```bash
cd "$REPO"
rm -f endless-memory.strudel score-45min.json listen.url
npm test 2>&1 | tail -8
```

Expected: `# pass 5`, `# fail 0`. `pretest` regenerates the artifact. If this fails, step 6 did not take.

- [ ] **Step 9: Commit**

```bash
cd "$REPO"
git add composer.mjs station.mjs composer.test.mjs journal.json package.json \
        package-lock.json README.md .gitignore baselines research .github
git commit -F - <<'MSG'
feat: import listener-approved composition engine and CI

Verbatim copy of the Endless Memory engine from the unversioned local
prototype directory. No musical logic changes: composer.mjs,
station.mjs and composer.test.mjs are byte-identical to the source.

Includes research/ — raw NWS and NOAA CO-OPS pulls for Boston, Winthrop and
Marblehead. KBOS-observations.json and KBVY-observations.json are point-in-time
snapshots that re-running the same call does not reproduce, and they are the
evidence base for the location decision in slice B.

The CI workflow lands here rather than with the tests it will gate, because a
status check cannot be marked required until it has run at least once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
git log --oneline -2
```

---

### Task 2: Publish the repo and establish the gate

**Files:** none in the repo. This task operates on GitHub.

**Interfaces:**
- Consumes: the `test` check context produced by task 1's workflow.
- Produces: a public `schmug/endless-memory` with `origin` wired up, and an active ruleset on `main` requiring a pull request and the `test` check.

- [ ] **Step 1: Scan for secrets before anything is published**

```bash
cd "$REPO"
grep -rIn -E '(api[_-]?key|secret|passwd|password|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|gh[pousr]_[A-Za-z0-9]{20,})' \
  --exclude-dir=node_modules --exclude-dir=.git . | head -20
echo "--- exit: $? (1 = no matches, which is what we want) ---"
```

Expected: no matches. NWS and NOAA CO-OPS need no API key, and `journal.json` is empty. Look rather than assume — publishing is not reversible.

- [ ] **Step 2: Confirm with the user before creating the public repo**

Creating a public repo publishes this code. The user explicitly chose "Public repo + CI gates" during brainstorming, which authorizes it — but state plainly what is about to become public (the engine, `research/`, the spec and plan) and get a yes before running step 3.

- [ ] **Step 3: Create the repo and push**

```bash
cd "$REPO"
gh repo create schmug/endless-memory --public --source=. --remote=origin --push \
  --description "An endless generative lo-fi composition with memory. Time-derived, weather-aware, and it remembers its own motifs."
git remote -v
```

- [ ] **Step 4: Watch the first CI run finish**

```bash
cd "$REPO" && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh run list --limit 1
```

Expected: conclusion `success`. The check context `test` now exists and can be required. If CI fails, fix it before creating the ruleset — a ruleset requiring a permanently red check locks the repo.

- [ ] **Step 5: Show the ruleset to the user, then create it**

A ruleset is a guardrail, so show the exact payload before applying it. Note there are no `bypass_actors`: the gate applies to the repo owner too, which is the point.

```bash
cd "$REPO"
cat > /tmp/em-ruleset.json <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      } },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "test" } ]
      } }
  ]
}
JSON
gh api repos/schmug/endless-memory/rulesets -X POST --input /tmp/em-ruleset.json --jq '{id,name,enforcement}'
```

`required_approving_review_count` is `0` deliberately. This is a solo repo where the merge decision belongs to the agent once the mechanical gate is green; requiring a human approval would block every merge.

- [ ] **Step 6: Read the ruleset back**

```bash
RS=$(gh api repos/schmug/endless-memory/rulesets --jq '.[0].id')
gh api "repos/schmug/endless-memory/rulesets/$RS" --jq '{enforcement, rules: [.rules[].type], checks: [.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]}'
```

Expected: `enforcement: "active"`, rules including `pull_request` and `required_status_checks`, and `checks: ["test"]`.

This is a read-back, not proof the gate blocks anything. The behavioural proof comes in task 5 step 3. Do not claim the gate works until then.

---

### Task 3: The golden-output lock

Work on a branch from here on — `main` is now gated.

**Files:**
- Create: `test/update-fixtures.mjs`, `export.test.mjs`
- Create (generated): `test/fixtures/quiet-afternoon.strudel`, `test/fixtures/weathered-night.strudel`
- Modify: `package.json` (scripts only)

**Interfaces:**
- Consumes: `station.mjs` as a subprocess; `composer.mjs` indirectly through it.
- Produces: `test/update-fixtures.mjs` exporting `FIXTURES` (array of `{name, anchor, journal}`) and `async exportFixture(fixture)` returning `{strudel: string, score: Array}`.

**Fixture values, already computed — use these literals.** Verified against the prototype on 2026-09-10:

| Fixture | Anchor | Journal | Coverage |
|---|---|---|---|
| `quiet-afternoon` | `2026-09-11T14:00:00Z` | empty, as shipped | 28 scenes, all `afternoon`, `weather: clear`, `weatherKnown: false`, 0 recalls, 0 handoffs |
| `weathered-night` | `2026-09-11T02:00:00Z` | rain + remember (below) | 27 scenes, all `night`, `weather: rain`, `weatherKnown: true`, **8 recalled**, **15 handoffs** |

The motif `m8329137` is `hash('window-seat-v1:2026-09-09:quiet') % 100000000` — the motif the engine itself derives for 2026-09-09 with no weather in effect. It is derived, not invented.

- [ ] **Step 1: Branch**

```bash
cd "$REPO" && git checkout -b feat/golden-fixtures && git symbolic-ref --short HEAD
```

- [ ] **Step 2: Write the fixture definitions and export helper**

Create `test/update-fixtures.mjs`:

```javascript
// Golden fixture definitions and the export helper shared with export.test.mjs.
// Run directly (`npm run fixtures`) to regenerate fixtures after a deliberate
// change to the sound. The regenerated files must be reviewed as a diff.
import { mkdtemp, cp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..');

// Anchors are fixed because `station.mjs export` with no argument reads the wall
// clock. Their coverage is recorded in the plan; the recall assertion in
// export.test.mjs guards it from drifting silently.
export const FIXTURES = [
  {
    name: 'quiet-afternoon',
    anchor: '2026-09-11T14:00:00Z',
    journal: { version: 1, seed: 'window-seat-v1', events: [] },
  },
  {
    name: 'weathered-night',
    anchor: '2026-09-11T02:00:00Z',
    journal: {
      version: 1,
      seed: 'window-seat-v1',
      events: [
        // m8329137 is the motif the engine derives for 2026-09-09 with no
        // weather in effect: hash('window-seat-v1:2026-09-09:quiet') % 1e8.
        { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
        { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
      ],
    },
  },
];

// Spawns the real CLI in a throwaway directory. station.mjs resolves its paths
// from its own file location, so the copy reads and writes only inside `work`
// and never touches the repo or its journal.
export async function exportFixture(fixture) {
  const work = await mkdtemp(join(tmpdir(), 'endless-memory-'));
  await cp(join(repo, 'composer.mjs'), join(work, 'composer.mjs'));
  await cp(join(repo, 'station.mjs'), join(work, 'station.mjs'));
  await writeFile(join(work, 'journal.json'), JSON.stringify(fixture.journal, null, 2) + '\n');
  await run(process.execPath, ['station.mjs', 'export', fixture.anchor], { cwd: work });
  return {
    strudel: await readFile(join(work, 'endless-memory.strudel'), 'utf8'),
    score: JSON.parse(await readFile(join(work, 'score-45min.json'), 'utf8')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(join(dir, 'fixtures'), { recursive: true });
  for (const fixture of FIXTURES) {
    const { strudel, score } = await exportFixture(fixture);
    await writeFile(join(dir, 'fixtures', `${fixture.name}.strudel`), strudel);
    const recalled = score.filter((s) => s.recalled).length;
    const handoffs = score.filter((s) => s.transitioning).length;
    console.log(`${fixture.name}: ${strudel.length} bytes, ${score.length} scenes, ${recalled} recalled, ${handoffs} handoffs`);
  }
}
```

- [ ] **Step 3: Write the failing test**

Create `export.test.mjs` at the repo root, matching the existing `composer.test.mjs` convention:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, exportFixture } from './test/update-fixtures.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

// Characterization tests, not specification. Their job is to make an accidental
// change to a listener-approved sound impossible to merge unnoticed.
for (const fixture of FIXTURES) {
  test(`export is byte-identical to the ${fixture.name} fixture`, async () => {
    const expected = await readFile(join(dir, 'test', 'fixtures', `${fixture.name}.strudel`), 'utf8');
    const { strudel } = await exportFixture(fixture);
    assert.equal(
      strudel,
      expected,
      'Export drifted from the approved sound. If this change is intentional, run `npm run fixtures` and review the diff.',
    );
  });
}

test('the weathered-night fixture still exercises motif recall', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'weathered-night');
  const { score } = await exportFixture(fixture);
  const recalled = score.filter((s) => s.recalled).length;
  assert.ok(recalled > 0, `anchor ${fixture.anchor} no longer covers the recall branch`);
});
```

- [ ] **Step 4: Point the test script at both files** — keep `pretest`; dropping it breaks the suite on a clean checkout (see task 1 step 6)

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "pretest": "node station.mjs export 2026-09-11T14:00:00Z",
    "test": "node --test composer.test.mjs export.test.mjs",
    "fixtures": "node test/update-fixtures.mjs",
    "export": "node station.mjs export"
  },
```

- [ ] **Step 5: Run the test and verify it fails for the right reason**

```bash
cd "$REPO" && npm test 2>&1 | tail -25
```

Expected: the 5 `composer.test.mjs` tests pass; both byte-identical tests **fail** with `ENOENT` on `test/fixtures/*.strudel`. A missing fixture is the correct failure for a golden test — confirm the error really is ENOENT and not a typo, a bad import path, or a crash inside `exportFixture`. The recall test should pass already, since it does not read a fixture.

- [ ] **Step 6: Generate the fixtures**

```bash
cd "$REPO" && npm run fixtures
```

Expected output, matching the coverage table above:

```
quiet-afternoon: <n> bytes, 28 scenes, 0 recalled, 0 handoffs
weathered-night: <n> bytes, 27 scenes, 8 recalled, 15 handoffs
```

If the scene, recall or handoff counts differ from 28/0/0 and 27/8/15, stop. Either the engine is not the one that was measured, or an anchor is wrong.

- [ ] **Step 7: Run the test and verify it passes**

```bash
cd "$REPO" && npm test 2>&1 | tail -12
```

Expected: `# pass 8`, `# fail 0` — the 5 existing tests plus 2 byte-identity tests plus 1 recall-coverage test. Report the counts.

- [ ] **Step 8: Prove the lock actually catches a change**

This is acceptance criterion 5, and it is the most important step in the plan. A golden test nobody has watched fail is not known to work.

```bash
cd "$REPO"
# Nudge one gain value in the chord voice.
sed -i '' 's/\.gain(\.14)/.gain(.15)/' composer.mjs
npm test 2>&1 | tail -20
```

Expected: both byte-identity tests **fail**, printing the "Export drifted from the approved sound" message.

```bash
cd "$REPO"
git checkout composer.mjs
diff -q "$PROTOTYPE/composer.mjs" composer.mjs && echo "composer.mjs restored byte-identical"
npm test 2>&1 | tail -8
```

Expected: `composer.mjs restored byte-identical`, then `# pass 8`, `# fail 0`. Do not continue until `diff -q` is silent.

- [ ] **Step 9: Commit**

```bash
cd "$REPO"
git add export.test.mjs test package.json
git commit -F - <<'MSG'
test: pin the approved sound with golden export fixtures

Characterization tests, not specification: they exist to make an accidental
change to a listener-approved sound impossible to merge unnoticed.

Two fixtures at fixed anchors, because `station.mjs export` with no argument
reads the wall clock. quiet-afternoon (28 scenes, clear, no recall) pins the
baseline daytime arrangement. weathered-night (27 scenes, rain, 8 recalled,
15 motif handoffs) pins night sparseness, the weather easing curve and the
recall branch. A third test asserts the night anchor still covers recall, so
that coverage cannot drift away silently.

The test spawns the real CLI in a temp directory rather than calling
patternSource() directly, which would duplicate station.mjs's string assembly
in the test and miss exactly the regressions this is for.

Verified failing before the fixtures existed, and verified failing again
against a deliberate one-value edit to composer.mjs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Dependency hygiene, LICENSE and README

Same branch. A reviewer could reasonably accept task 3 and reject this, which is why it is a separate task and a separate commit.

**Files:**
- Modify: `package.json`, `package-lock.json`, `README.md`
- Create: `LICENSE`

**Interfaces:**
- Consumes: the fixtures and tests from task 3, which must still pass unchanged.
- Produces: no runtime `dependencies` at all.

- [ ] **Step 1: Move the Strudel packages to devDependencies and drop the orphan**

Only `composer.test.mjs` imports Strudel. `composer.mjs` and `station.mjs` import nothing outside Node's standard library, so the project links against nothing at runtime and the `dependencies` block misrepresents that. Verified 2026-09-10: no package in the lockfile declares `@kabelsalat/web` as a dependency and none of the three Strudel packages declare peer dependencies, so it is a genuine orphan.

Edit `package.json` so the dependency blocks read exactly:

```json
  "dependencies": {},
  "devDependencies": {
    "@strudel/core": "1.2.5",
    "@strudel/mini": "^1.2.6",
    "@strudel/transpiler": "^1.2.6"
  },
  "overrides": {
    "@strudel/core": "$@strudel/core"
  }
```

Keep the `1.2.5` pin and the `overrides` block. 1.2.6's published browser dependency fails to import under Node, which is why the harness is pinned.

- [ ] **Step 2: Refresh the lockfile and verify**

```bash
cd "$REPO"
npm install
rm -rf node_modules && npm ci && npm test 2>&1 | tail -12
```

Expected: `npm install` succeeds and updates `package-lock.json` in place; `npm ci` then installs cleanly; `# pass 8`, `# fail 0`.

Do not delete `package-lock.json` to force a fresh resolve — that risks drifting off the `1.2.5` pin.

**If `npm install` errors on the `$@strudel/core` override** (npm resolves `$name` against direct dependencies, and the package has moved block): replace the override with the literal pin instead, then repeat this step.

```json
  "overrides": {
    "@strudel/core": "1.2.5"
  }
```

- [ ] **Step 3: Confirm the fixtures did not move**

```bash
cd "$REPO" && git status --porcelain test/fixtures && echo "(empty above = fixtures unchanged)"
```

Expected: no output. The fixture bytes come from `composer.mjs` and `station.mjs`, neither of which imports Strudel, so a dependency change provably cannot move them. If a fixture did change, something else was edited — stop.

- [ ] **Step 4: Add the LICENSE**

Create `LICENSE` containing the standard MIT License text, with the copyright line reading exactly:

```
Copyright (c) 2026 schmug
```

Match the wording used in `schmug/terratouch` and `schmug/dewpt`. Use the canonical MIT text — do not paraphrase it.

- [ ] **Step 5: Update the README minimally**

Preserve every existing section: the loop timings, the memory semantics, the weather-connection notes, the V3 handoff description, and the "Next listening and development pass" roadmap. This is a public-repo README, so it is product output with a human audience — but that loosens no quality gate, and the technical content it already carries is the most valuable thing in it.

Add only what this slice changed:

1. In **Verification**, after the existing `npm ci` / `npm test` block, note that the suite now also pins the generated score byte-for-byte at two fixed anchors, and that `npm run fixtures` regenerates them when a sound change is deliberate.
2. A short note that this repo is now the canonical home, and that `$PROTOTYPE` remains as a frozen reference.
3. A one-line note that the Strudel packages are test-harness only and the project has no runtime dependencies.

Do not restructure the document or rewrite its prose.

- [ ] **Step 6: Run the full suite once more**

```bash
cd "$REPO" && npm test 2>&1 | tail -10
```

Expected: `# pass 8`, `# fail 0`. Report the counts.

- [ ] **Step 7: Commit**

```bash
cd "$REPO"
git add package.json package-lock.json LICENSE README.md
git commit -F - <<'MSG'
chore: MIT license, and demote test-only Strudel packages

Only composer.test.mjs imports Strudel; composer.mjs and station.mjs import
nothing outside Node's standard library. Listing the AGPL Strudel packages as
runtime dependencies misrepresented what this project links against at
runtime, which is nothing. Moved to devDependencies.

Dropped @kabelsalat/web: no source file imports it, no package in the lockfile
declares it as a dependency, and none of the Strudel packages declare peer
dependencies.

The @strudel/core 1.2.5 pin stays. 1.2.6's published browser dependency fails
to import under Node.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: Open the PR, prove the gate, merge, file the follow-up

**Files:** none. This task operates on GitHub.

**Interfaces:**
- Consumes: the `feat/golden-fixtures` branch and the ruleset from task 2.
- Produces: a merged `main`, and a filed follow-up issue.

- [ ] **Step 1: Push and open the PR**

```bash
cd "$REPO"
git push -u origin feat/golden-fixtures
gh pr create --title "test: pin the approved sound; MIT license; dependency hygiene" --body-file - <<'BODY'
Locks the listener-approved sound behind a golden-output characterization test,
then cleans up what publishing the repo made wrong.

## Test output

```
# tests 8
# pass 8
# fail 0
```

Five existing engine tests, two byte-identity tests, one recall-coverage test.

## The lock

Two fixtures at fixed anchors, since `station.mjs export` with no argument reads
the wall clock:

| Fixture | Anchor | Coverage |
|---|---|---|
| `quiet-afternoon` | `2026-09-11T14:00:00Z` | 28 scenes, clear, no recall, no handoffs |
| `weathered-night` | `2026-09-11T02:00:00Z` | 27 scenes, rain, 8 recalled, 15 handoffs |

The test spawns the real CLI in a temp directory. Asserting against
`patternSource()` directly would duplicate station.mjs's string assembly inside
the test and miss exactly the regressions this exists to catch.

Verified failing before the fixtures existed, and verified failing again against
a deliberate one-value edit to `composer.mjs` — a golden test nobody has watched
fail is not known to work.

## Dependency hygiene

Only `composer.test.mjs` imports Strudel, so the AGPL packages moved to
`devDependencies` and the unused `@kabelsalat/web` is gone. The `@strudel/core`
1.2.5 pin stays; 1.2.6 fails to import under Node.

Spec: `docs/superpowers/specs/2026-09-10-engine-port-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

- [ ] **Step 2: Observe the gate holding while checks run**

```bash
cd "$REPO"
gh pr view --json number,mergeStateStatus,statusCheckRollup --jq '{number, mergeStateStatus, checks: [.statusCheckRollup[] | {name, status, conclusion}]}'
```

Expected while CI is still running: `mergeStateStatus` is `BLOCKED` or `UNSTABLE`, and the `test` check is `IN_PROGRESS`.

- [ ] **Step 3: Observe it clear once checks pass**

```bash
cd "$REPO"
gh run watch "$(gh run list --branch feat/golden-fixtures --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh pr view --json mergeStateStatus,statusCheckRollup --jq '{mergeStateStatus, checks: [.statusCheckRollup[] | {name, conclusion}]}'
```

Expected: `test` concludes `SUCCESS` and `mergeStateStatus` becomes `CLEAN`.

The transition from blocked to clean is the behavioural proof that the check is actually required. Task 2 step 6 only read the configuration back. Record both observations — the guardrail here is that a claim about a gate must be an observation, not an assertion that it was configured.

If `mergeStateStatus` is `UNKNOWN`, GitHub has not finished computing mergeability. Re-run the command rather than assuming either answer.

- [ ] **Step 4: Merge through the gate**

```bash
cd "$REPO"
gh pr merge --squash --delete-branch
git checkout main && git pull && git log --oneline -4
```

Merging through a green mechanical gate is the agent's decision and needs no further approval.

- [ ] **Step 5: File the deferred export-path refactor**

```bash
gh issue create --repo schmug/endless-memory \
  --title "Refactor the export path in station.mjs to assemble source from structured parts" \
  --body-file - <<'BODY'
## Task

Rewrite how `station.mjs` builds its exported `.strudel` source. Today it renders
a template through `patternSource()`, then regex-matches each rendered token back
to its scene key by comparing `JSON.stringify` output, then rewrites every
double-quoted string to single quotes. Replace that with direct assembly from
structured parts.

## Why

This is the most fragile code in the project, and pieces B through E are about to
build on top of it.

- `station.mjs:29-34` — `template.replace(/"<[^"\n]*>"/g, ...)` re-derives which
  scene key a rendered token came from by stringifying every candidate and
  comparing. A scene whose `chords` and `bass` ever render identically silently
  binds the wrong key.
- `station.mjs:38` — `safeSource` rewrites every double-quoted string in the
  generated source to single quotes, because Strudel's transpiler reads double
  quotes and backticks as mini-notation. This is a real constraint, but doing it
  by regex over already-generated source is the wrong layer.
- `station.mjs:31` — the `.replace(/\.lpf\(\d+\)(?=\.gain\(\.14\))/, ...)` patch
  targets a literal gain value as an anchor. Changing that gain silently breaks
  the cutoff wiring.

## Constraints

- The generated output must stay byte-identical. `export.test.mjs` pins it at two
  anchors and will fail if it moves — that is the point, and it makes this
  refactor provably safe.
- Do not change `composer.mjs`. The sound must not move.
- Keep the single-quote rule; it is a genuine Strudel transpiler constraint, not
  an accident. Move it into generation rather than post-processing.
- Node 22, ESM, no new runtime dependencies.

## Acceptance criteria

- `npm test` reports 8 passing, 0 failing, with `test/fixtures/*.strudel`
  unchanged.
- No regex operates on already-generated source.
- The gain-value anchor in the `lpf` patch is gone.

## Out of scope

- Restructuring into `src/` or defining a public library API. Wait until a second
  consumer exists to shape it.
- Any change to the musical model.
BODY
```

- [ ] **Step 6: Confirm the prototype was never touched**

```bash
diff -r "$PROTOTYPE" . \
  -x node_modules -x .git -x docs -x .github -x test -x LICENSE \
  -x export.test.mjs -x 'endless-memory.strudel' -x 'score-45min.json' -x 'listen.url' \
  -x package.json -x package-lock.json -x README.md
```

Expected: no output. `composer.mjs`, `station.mjs`, `composer.test.mjs`, `journal.json`, `baselines/` and `research/` must be identical on both sides. The excluded files are the ones this slice deliberately added or changed.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| D1 what is copied | 1, steps 2–3 |
| D2 what is not committed | 1, steps 4 and 7 |
| D3 layout | 1, 3, 4 (files created where the table says) |
| D4 the lock | 3 |
| D5 dependency hygiene | 4, steps 1–3 |
| D6 gates and ordering | 1 step 5 (workflow), 2 (publish + ruleset), 5 (PR + merge) |
| D7 README | 4, step 5 |
| D8 license | 4, step 4 |
| Verification | 1 step 6, 3 steps 5–8, 5 steps 2–3, 5 step 6 |
| Acceptance 1–7 | 1 step 6; 1 step 3; 2 step 3; 2 step 6 + 5 step 3; 3 step 8; 5 step 6; 5 step 5 |
| Deferred work | 5, step 5 |

The spec's D4 conditional — "if recall never fires, choose a different anchor and record it here" — is resolved. Recall fires 8 times in 27 scenes at `2026-09-11T02:00:00Z`, measured before planning, so the proposed anchor stands. Task 3 step 6 re-checks the count, and the third test in `export.test.mjs` guards it permanently.

**Placeholder scan.** No `TBD`, `TODO`, "implement later", "add appropriate error handling", or "similar to Task N". The only non-literal in a code block is `<n> bytes` in task 3 step 6's expected output, which is genuine unknown output being reported, not a value the implementer must supply.

**Type consistency.** `FIXTURES` and `exportFixture(fixture)` are defined in task 3 step 2 and consumed in step 3 under the same names. `exportFixture` returns `{strudel, score}` in both. Fixture names `quiet-afternoon` and `weathered-night` are spelled identically in `update-fixtures.mjs`, `export.test.mjs`, the coverage table, task 4 step 3, and the PR body. The check context `test` is spelled identically in task 1 step 5 (job id), task 2 step 5 (ruleset), and task 5 steps 2–3 (observation).
