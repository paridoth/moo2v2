# Orion milestone verification

## Fleet modernization — 2026-10-18

Inspected the existing uncommitted work before continuing in
`/home/josh/Projects/orion-ascendant/moo2v2`. New campaigns now select
`strategist-v3`; saved v1/v2 campaigns keep their exact policy implementations.
Added `naval-observation.ts`, `modernization.ts` and `admiral.ts`: legal researched
escort/assault fits, managed design refresh with slot/queue protection, preferred
commissioning fits, and bounded paid refits at available local yards. Existing
refit queues hold ships across planning/reload. No simulation arithmetic, engine
command semantics, persisted state schema, save format or dependency changed.

| Check | Result |
| --- | --- |
| `npm test` | Pass: **617 tests**, 5 existing skips; 96 files passed / 4 skipped (74.86 s) |
| Orion coverage | 45 tests included in the full suite; 12 added since the v2 checkpoint |
| `npm run check` | Pass: 0 errors; 2 existing BattleViewer warnings |
| `npm run build` | Pass (7.34 s); existing Svelte/chunk-size warnings |
| `npm run test:e2e` | Pass: all 12 browser tests (1.7 min) |
| Final Orion browser check | Pass: downloaded v3 manifest, OPFS reload and offline import (13.4 s) |
| `npm run benchmark:orion -- --output benchmark-results/orion-2026-10-18.json` | Pass: 6 active-opponent matches, 150 turns each; every accepted log revalidated/replayed |
| `git diff --check` | Pass |

New unit scenarios cover researched/legal role payloads (including no free
pre-warp weapons), design slot limits, protected queued designs, useful versus
cosmetic/slow refits, reserves, Easy/defense/active-project constraints, ship
holding and an alternate legal yard when the first one is busy. Privacy fixtures
require v3 decisions to remain unchanged under hidden enemy mutations.

A real HostCore/GameSession fixture stops after a paid refit is queued, verifies
a binary save, rebases it, imports the snapshot branch into SQLite and resumes.
The ship retains its id, completes its upgrade/repairs through production once,
and submits no duplicate design/refit order. Mixed v2/v3 manifest ids survive.
Completed-plan recovery now tests v1, v2 and v3. The browser save test decodes
the actual downloaded file and verifies new campaigns contain v3 seats before
testing OPFS reload and offline import. Frozen old-save fixtures are untouched.

The benchmark uses the normal filtered policy boundary and real host/session
commands for every seat. Seat zero is driven as an automated human and commits
before the production controllers play. Full state is used only for evaluation
and independent replay. It samples planning-boundary idle production/research
and counts actual `ship_refitted` events during replay, rather than queue orders.
Raw JSON includes per-turn hash trails and diagnostics; generated reports live
in the ignored `benchmark-results/` directory and can be regenerated with the
command above. No wall-clock values enter the match report or simulation.

Each scenario uses matching races/personalities and swaps policy seats. All six
matches finish at turn 151 with zero rejected/bounded orders and no winner:

| Start / race | V3 colonies (seat 0 / 1) | V2 colonies (seat 1 / 0) | V3 completed refits (seat 0 / 1) | Food lack, each policy/seat | Idle production |
| --- | --- | --- | --- | --- | --- |
| Average / Solari | 5 / 2 | 2 / 5 | 0 / 0 | 0 | 0 |
| Pre-warp / Ferron | 3 / 3 | 3 / 4 | 2 / 2 | 0 | 0 |
| Advanced / Urgok | 6 / 7 | 7 / 6 | 0 / 0 | 47 | 0 |

Seeds match the three listed in the October 16 checkpoint below. V3 creates
managed designs in the average/advanced scenarios and completes two paid refits
in each pre-warp seating. No wars are declared in this sample. Advanced-start
food shortages affect both policies identically; slower expansion in one v3
pre-warp seating accompanies refit spending. These are measured limitations,
not waived failures or evidence of competitive superiority. Larger tournaments,
combat calibration, remote maintenance routing, multiple fronts and Antaran
victory planning remain next work.

Tooling: the existing bundled Node and installed lockfile packages were reused.
npm 10.9.2 was staged in `/tmp` again because the prior temporary staging was
gone; no package dependency or lockfile changed. Go/Chrome browser tests ran with
the pinned server modules/toolchain. This environment allowed the existing
generated-data subprocess test directly, so no permission workaround was needed.

## Phase 2 continuation — 2026-10-16

Current checkout: `/home/josh/Projects/orion-ascendant/moo2v2`, unpacked from the
provided `orion-ascendant-handoff.tar.gz`. Inspected all existing uncommitted
changes and the six Orion design documents before extending them. The original
archive and its Git history remain intact; no prior work or frozen fixture was
discarded. The Phase 1 record below describes the earlier executor.

New campaigns now choose `strategist-v2`; saved `expander-v1` manifests dispatch
to their original policy. Changes add derived assessment, research utility and
prerequisite lookahead, buffered own-economy forecasts, shipyard/design selection,
queued command-point budgets, visible-strength estimates, defensive commitments,
rallying, escorted marine expeditions, restrained war preparation/declarations
and council self-votes. Existing engine command arithmetic, save envelope,
database schema and rule versions are unchanged.

Environment: bundled Node v24.19.0; npm 10.9.2 staged under `/tmp/orion-npm`;
`npm ci` installed the unchanged lockfile (137 packages). The same seven existing
audit findings were reported. System Chrome and Go were available; the browser
server fetched the required Go 1.26.4 toolchain and pinned modules into `/tmp`.
No project dependency was added. The initial sandboxed full test run hit
`spawnSync node EPERM` in the existing generated-data subprocess test; direct
generation validation passed, and the complete suite passed with child-process
permissions enabled. No assertion or test was skipped to accommodate this.

| Check | Result |
| --- | --- |
| `npm test -- --disableConsoleIntercept` | Pass: 605 tests, 5 existing skips; 94 files passed / 4 skipped (64.72 s) |
| `npm run check` | Pass: 0 errors; 2 existing BattleViewer warnings |
| Final `npm run test:orion` | Pass: 33 tests in 4 files (30.22 s) |
| `npm run build` | Pass; existing chunk-size/Svelte warnings |
| `npm run test:e2e` | Pass: all 12 browser tests (1.8 min) |
| Final `npm run test:e2e -- e2e/orion.spec.ts` | Pass: offline play, OPFS reload, save download/import (11.8 s) |
| `git diff --check` | Pass |

The full suite includes deterministic engine regressions, frozen old-save
fixtures, storage/protocol regressions and the Orion suites. The final focused
Orion rerun also exercises the outpost-only bombardment decision added during
review. AI-layer boundaries now ban nondeterministic operations too, preserving
the controller's existing microtask scheduling exception.

Three scenarios each run **twice for 110 turns** with matching per-turn hashes,
matching metrics and full accepted-log revalidation/replay. At turn 111:

| Start / AI races | Colonies | New technologies | Research/turn | Military ships | Cumulative food lack |
| --- | --- | --- | --- | --- | --- |
| Average: Solari / Hivex | 2 / 6 | 5 / 4 | 22 / 12 | 2 / 8 | 0 / 0 |
| Pre-warp: Lithor / Ferron | 4 / 2 | 9 / 7 | 13 / 3 | 2 / 2 | 0 / 0 |
| Advanced: Cerebri / Urgok | 4 / 5 | 11 / 2 | 22 / 2 | 3 / 5 | 0 / 0 |

Seeds respectively: `0123456789abcdef0123456789abcdef`,
`fedcba9876543210fedcba9876543210`, `abcdef0123456789abcdef0123456789`.
Both AIs survive each scenario with zero rejections, work-limit hits or debug
commands. Factory construction is required when the empire has learned the
application; a race may not have it yet, and uncreative choices remain seeded
engine outcomes. These gates measure practical development, not comparative
win rates; some pre-warp economies still develop slowly.

Additional tests prove: insufficient expeditions rally rather than trickle into
combat; defenders account for in-flight reinforcements; queued hulls reserve CP;
scientific paths value descendants; active research stays stable; treaties,
Easy difficulty, food and treasury constrain new wars; only actual marine squads
enable invasion; council votes do not repeat. Hidden enemy internals, including
scanned enemies' weapons, damage and garrisons, cannot affect observations or v2
decisions. A completed expedition is saved and verified before turn resolution,
reloaded without repeating its grouped movement, then fights and captures a
colony through HostCore/GameSession. Partial v2 planning, snapshot branches and
completed v1/v2 plans all resume through the existing completion/deduplication
mechanism.

Remaining Phase 2 work: larger competitive tournaments, calibrated uncertainty,
refits/specialized custom designs, multiple fronts and Antaran victory planning.
No LLM, personality-memory subsystem or tactical-mode rewrite is introduced.

To run commands in this executor, expose the staged tools first:

```bash
cd /home/josh/Projects/orion-ascendant/moo2v2
export PATH=/tmp/orion-bin:/home/josh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
npm run dev
```

The npm staging paths are temporary; a normal installed Node/npm also works.

## Historical Phase 1 record

Source baseline: `ba4e7ccfd058788158c978307616c21b1e2c7c53`.
Worktree: `/home/hermes/moo2v2`. Date: 2026-10-16 (America/Chicago).

## Environment

The initial `npm ci` attempt failed with `/bin/bash: npm: command not found`.
Installed Node v22.16.0/npm into `/home/hermes/.local/node` and successfully
reran the install. No project dependency was added. npm reported 7 existing audit
issues (2 moderate, 5 high); dependency upgrades were outside this slice.

System Chrome 155.0.8059.84 was available. Go was initially missing; installed a
bootstrap toolchain in `/home/hermes/.local/go`. The existing E2E server then
automatically downloaded the module-required Go 1.26.4 and pinned Go modules.
Browser tests ran with real Chrome, OPFS/SQLite and the Go signaling/PBM server.
The runtime skill's environment-status tool and network policy file were not
available in this executor; normal proxy-aware git/download commands succeeded.
No test dependency remained blocked.

## Unmodified baseline

| Command | Result |
| --- | --- |
| `npm ci` | Pass after local Node installation; 137 packages installed |
| `npm run check` | Pass; 0 errors, 2 existing BattleViewer Svelte warnings |
| `npm test` | 571 passed, 5 skipped, 1 failed; 89 files passed, 4 skipped, 1 failed |
| `npm run test:game` | 21 passed, 1 failed; 9 files passed, 1 failed |
| `npm run build` | Pass; existing large-chunk and Svelte warnings |

Both failing baseline runs hit `ENOENT` for
`bugs/moo2v2-314-turn204.moo2save` in `tests/determinism/bombard-repro.test.ts`.
That save is not tracked upstream. The test now constructs the six beam-destroyer
versus minimum-population-colony scenario itself, preserving its original
bombardment assertions. No frozen save fixture was edited or test skipped.

The first browser run occurred after the initial code slice and toolchain setup,
so it is not an unmodified baseline: all 11 existing browser tests passed then.
A later full run including Orion caught an intermittent restart/reload issue.
Console instrumentation exposed outstanding writes against a destroyed SQLite
driver. Restart/leave now flush before closing storage, and the host barrier
waits for async local ingestion. Under CPU load the browser could also show a
resolved turn before its queued SQLite tail was recorded; reloading a background
tab then restored the prior turn without a console error. Single-player turn readiness now
waits for that persistence boundary, with a brief Saving turn status. The existing restart E2E now asserts no
persistence errors as well as reload/continued play. SQLite-backed lockstep tests
now wait for the real start persistence handshake before issuing client commands;
MemoryHub alone can only drain microtasks, not asynchronous database writes. The quick-build E2E also now accepts an immediate named auto-play interrupt
(such as a leader offer), as its existing intended behavior already specified.
The readiness indicator is scoped to single player; multiplayer retains its
existing turn display and reconnect/resync behavior. The battle E2E now gives
both peers the same 30-second resolution timeout: the remote peer correctly waits
for durable battle history while the host also prepares its animated replay.
Incidental favicon 404s are
outside that targeted console assertion.

## Final checks

| Command | Final result |
| --- | --- |
| `npm run check` | Pass: 0 errors, 2 existing Svelte warnings |
| `npm test` | Pass: 587 tests; 5 existing opt-in skips; 93 files passed / 4 skipped (87.40 s final run) |
| `npm run test:game` | Pass: 22 tests in 10 files (40.89 s) |
| `npm run test:orion` | Pass: 15 tests in 3 files; also included in the final full suite |
| `npx vitest run tests/protocol` | Pass: 60 tests in 15 files |
| `npm run build` | Pass; also rebuilt successfully by the final Playwright web-server startup |
| `npm run test:e2e` | Pass: all 12 browser tests (1.6 min final run) |
| Restart E2E, `--repeat-each=3` | Pass: all 3 runs while `npm test` ran concurrently (56.7 s) |
| `git diff --check` | Pass |

The final build retains upstream chunk-size warnings. No new test is skipped.
There are 36 changed/new files; the inventory below groups every one.

The dedicated `npm run test:orion` suite passed 15 tests in 3 files before the
final broad run. It covers:

1. One human plus two local AI empires with contiguous ordinary seats.
2. No AI planning before human End Turn; automatic turn completion afterward.
3. Every accepted player command revalidated during replay.
4. No debug grants, duplicate intents, unbounded planning or unexpected rejections.
5. Complete and interrupted-partial AI plan reloads.
6. Verified binary save encode/decode, actual SQLite import, and snapshot rebase.
7. AI battle orders, preserved human battle choice and mid-battle reload.
8. Rejected-order recovery and shutdown with no subsequent accepted commands.
9. Two identical 100-turn headless HostCore/GameSession runs and matching hash
   trails/full replay, with expansion, factories, research, military and food gates.
10. Pre-warp/advanced starts, Easy difficulty and fast-start compatibility.
11. Hidden enemy economy/colony/fleet invariance, explored-but-unscanned secrecy,
    transit fleet filtering, visible contact summaries and detached references.
12. A gated persistence test proving remote start/advance broadcasts wait for
    the host's durable command record.

The Orion browser spec blocks every request outside the production static origin,
issues human production orders, advances turns with two computers, reloads with
intentionally different Home bot options, then imports a downloaded save into a
new offline room and continues. Existing multiplayer, combat, auction, storage,
PBM, quick-build, solo and timelapse specs remain in the full browser run.

Four balance files / five tests are opt-in upstream skips in ordinary `npm test`;
no new skip was introduced. The optional balance tournament is not part of the
requested regression commands and was not executed.

## Launch and play

In this workspace:

```bash
cd /home/hermes/moo2v2
export PATH=/home/hermes/.local/node/bin:$PATH
npm run dev
```

Open http://localhost:5173. Enter your name and optionally a campaign room code.
Keep **Orion strategic AI (fair)**, choose **Easy** or **Normal**, and click
**Single player vs 2 bots**. In the lobby choose a preset/custom race, galaxy
size and existing settings, then **Start game**. Issue orders and **End Turn**;
computers finish automatically. Review the summary/Reports and answer human
battle dialogs as needed. Save downloads a verified file. Reenter the same
campaign to resume browser storage, or Load the file into a named room.

Other commands:

```bash
npm run test:orion
npm test
npm run test:game
npm run check
npm run build
npm run preview                 # http://localhost:4173
export PATH=/home/hermes/.local/go/bin:$PATH
npm run test:e2e
```

For multiplayer development only, run `bash scripts/run-lobby-server.sh` in a
second terminal. Single player needs no signaling server or external AI service.

## Changed files

AI: `src/ai/{types,observation,strategy,controller,seats}.ts`.
Engine/protocol: `src/engine/{types,commands}.ts`,
`src/protocol/{messages,host}.ts`.
UI: `src/ui/net.ts`, `src/ui/state.svelte.ts`,
`src/ui/screens/{Home,GameShell}.svelte`.
Layer/build/test wiring: `scripts/check-boundaries.mjs`, `tsconfig.json`,
`vite.config.ts`, `vitest.config.ts`, `package.json`.
Tests: `tests/protocol/{orion,durability,lockstep}.test.ts`,
`tests/unit/orion-observation.test.ts`,
`tests/determinism/bombard-repro.test.ts`, `e2e/orion.spec.ts`, `e2e/solo.spec.ts`, `e2e/quickbuild.spec.ts`, `e2e/battle.spec.ts`.
Documentation: README, PLAN and `docs/{ORION_VISION,ORION_ARCHITECTURE,
CLASSIC_FIDELITY,AI_DESIGN,ORION_ROADMAP,ORION_DECISIONS,ORION_VERIFICATION}.md`.

## Limitations

This is the first complete playable vertical slice. Strategic military planning,
marine invasion orchestration, persistent emperor memory, full relationships,
LLM providers, interactive tactical combat and graphics modernization remain
future work. Presets are small biases; difficulty has no resource bonuses.
Legacy experimental bots retain their older knowledge policies; only Orion
strategic seats use the filtered DTO. Stale intelligence snapshots and an
anti-cheat multiplayer protocol are not implemented. Ordinary browsers still
need working OPFS for reload persistence; the existing memory fallback supports
save downloads and displays its warning. Existing Svelte/build-size warnings
remain. No new unresolved failure is accepted as a completed feature.
