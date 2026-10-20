# MOO2v2 Master Plan & Checklist

This file is the canonical, resumable to-do list for the project. Any developer (or AI model,
on any machine) should be able to continue the work from this file plus the repo. Keep it
current: check items off as they land, and record deviations in place.

Requirements source: `prompt.md`. Mechanics source: `mechanics/` (keep its safe-terminology
names: Ecology, Energized/Hostile climates, Stellar Safety Shield, etc.). All art and prose in
this project are original — procedural sprites, our own descriptions. Never import assets or
text from the original game.

## What we are building

A browser 4X game with Master of Orion 2's rules and mechanics (economy, tech tree, race
picks, colonies, ships) — **except combat and the Creative trait, which are redesigned** — in
100% TypeScript:

- **P2P multiplayer** over [lobbylink](https://github.com/danielrh/lobbylink) WebRTC. The room
  creator (lobbylink `selfId 0`) is the **permanent host** (sequencer). Public signaling server:
  `https://pqrstuvw.xyz/lobbylink` (its allowlist already includes `http://localhost:5173` for
  local vite dev and `danielrh.github.io`).
- **SQLite persistence** (sqlocal + kysely over OPFS in browser; better-sqlite3 in node tests).
  The database records *everything that has happened*: an append-only, host-ordered command log
  plus periodic snapshots. Replaying the log reproduces the exact game state.
- **Spreadsheet-first UI**: a system-wide editable grid of all colonies is the primary screen;
  turns are simultaneous (WEGO) and advance when all players commit.
- **Point-to-point FTL**: ships travel star-to-star within fuel range; no per-system gates
  (except actual gate technologies).
- **One-pass visual combat**: automatic battle where the attacker makes a single pass through
  long/medium/short range bands; sprites + effects; pre-battle orders only (stance, targeting,
  retreat threshold); 2 players per battle; full playback under a minute and skippable.
  Balanced so equal-tech fleets take partial (20–40%) damage per pass, not devastation.
- **Optional modes**: (a) *creative-variant* — Creative races don't get all field applications
  free; they may research each application individually, paying each item's RP cost, min 1 turn
  each; (b) *pick bidding* — sealed-bid auctions (commit–reveal) for contested race picks, paid
  in pick points; winner pays their bid as the pick's cost, losers can't take it; (c) *sticky
  build progress* — switching build items keeps invested progress on the old item instead of
  transferring points.
- **No NPC empires.** Scripted bots exist only for headless testing.

## Architecture (decision register)

1. **Event-sourced deterministic lockstep.** A game = static-data version + settings + seed +
   host-ordered command log. The host assigns a gapless global `seq` to every command
   (including its own) and broadcasts; every peer folds commands identically.
   `replay(log) == state`, always.
2. **System commands live in the same log** under `playerId −1`: `game_start`,
   `auction_result`, `advance_turn`, `battle_orders_final`, `resolve_combat`, `seat_change`.
   Replay is a pure fold — no out-of-band state transitions.
3. **Determinism rules** (load-bearing invariant):
   - Engine is integer-only. Fixed-point 1/256 units in combat; exact integer `isqrt`.
   - Banned in `src/engine`: `Math.random`, `Math.sin/cos/tan/atan2/pow/exp/log`, `Date`,
     `performance`, float-valued sim quantities. Enforced by ESLint + `scripts/check-boundaries.mjs`.
   - PRNG: sfc32, with derived per-turn/per-subsystem streams.
   - Entities get monotonic integer ids; all iteration in id order; canonical JSON
     serialization (sorted keys) + pure-TS xxhash64 state hash every turn.
4. **Single npm package**, layered `src/` with an import-boundary check:
   `engine` (pure TS, zero runtime deps) ← `protocol` ← `storage`; `ui` may import all;
   nothing imports `ui` or `headless`.
5. **Engine↔UI boundary**: `GameSession` facade (in `protocol`) + `engine/selectors.ts` for all
   displayed math. UI reads immutable state snapshots + a version counter (Svelte 5
   `$state.raw`); optimistic command application is synchronous. The Svelte app is fully
   replaceable; headless bots consume the same selectors.
6. **Storage schema** (kysely): `games`, `game_players`, `commands` (canonical history),
   `snapshots` (gzip, every 10 turns), `turn_hashes`, `turn_events` (report feed),
   `battle_replays`, `chat_messages`, `prefs`, `schema_migrations`. Load = latest snapshot +
   replay tail. Save export/import = JSON envelope (also the manual re-host path).
7. **Net protocol** (JSON envelope over lobbylink `sendReliable` only): `hello/welcome`
   (engine/data/protocol version check), `lobby_update`, `race_config`, auction
   `commit/reveal`, `cmd_submit/accept/reject`, `commit_turn/uncommit/commit_status`,
   `hash_report/desync_notice/resync_request/resync_data` (app-chunked > 8 MiB),
   `chat_send/deliver`. lobbylink already covers membership, reconnect (resume tokens +
   seat claim), reliable ordered delivery ≤ 16 MiB, ICE rebuild — do not reimplement.
8. **Turn pipeline** (WEGO; follows `mechanics/game_mechanics.md` §01 twelve-step order with
   §04 colony order; population growth consumes the previous turn's food surplus):
   S0 freeze orders/derive RNG → S1 population → S2 colony output + empire rollup →
   S3 build advance (sticky mode hook) → S4 research (pre-selected target application;
   creative/uncreative; creative-variant purchases) → S5 spawn/refit/repair →
   S6 fleet movement → S7 encounters (pairwise battles) → **S8 async battle-orders sub-phase**
   (60 s timeout defaults; others read-only) → S9 combat resolve + persist replays →
   S10 bombardment/invasion/blockades → S11 upkeep (spies, leaders, events, Antarans,
   monsters, council) → S12 victory check → S13 end turn (events, hash, snapshot).
   Research target apps are pre-selected when research starts so resolution never prompts.
9. **Pluggable effects**: declarative `Modifier[]` records on data rows for ~80% of
   picks/buildings/techs (integer accumulator: `floor(flat × (100 + pct) / 100)`), plus a
   registry of coded `EffectHandler`s (hooks: colonyOutput, empireUpkeep, combatShipInit,
   combatTick, onBuildComplete, onTechGranted, movement) for true specials. A coverage test
   requires every tech application to map to modifiers, a handler, or an explicit stub —
   the stub ledger is the remaining-work queue.
10. **Combat model**: 2D battlefield 512×384 in 1/256 fixed-point; 10 logical ticks/s,
    400-tick cap. Range bands short/medium/long (≤ 96/224/448 units): damage ×100/70/40%,
    to-hit +10/0/−20. Attacker enters at x=0 drifting +x; defender deployed near x=384 with
    starbase/planet behind. Orders per design-group: stance ∈ charge / hold_range / standoff /
    evade_retreat, target priority, fleet retreat threshold. The pass ends when attackers cross
    the defender line, a side is destroyed/retreats, or the tick cap hits; survivors remain
    in-system (sieges take multiple turns by design). A single `COMBAT_PACE` scalar is tuned by
    the balance harness. **Replay = {initial combat state, orders, seed}**; the viewer re-runs
    the same sim and interpolates to 60 fps (pixi.js), with play/2×/4×/skip.
11. **Formula gaps** (marked 🔍 below): the mechanics docs omit some MOO2 arithmetic (growth
    curve, morale table, pollution, buy-cost, tax slider, component space/cost tables,
    miniaturization, map-gen odds, spy formula, leader magnitudes, council rules, Antaran
    cadence). Source each from community references (MOO2 Book / strategy wiki / 1.50 parameter
    docs) in the phase that consumes it. Where sources conflict: decide, document in
    `src/engine/data/README.md`, lock with a golden test.

## How to run (once scaffolded)

```bash
npm install
npm run dev                 # vite on http://localhost:5173 (COOP/COEP headers enabled)
scripts/run-lobby-server.sh # local Go signaling server on http://127.0.0.1:8787
npm test                    # boundaries + data + unit + protocol + storage (fast)
npm run test:game           # headless full-game bot suites
npm run test:e2e            # Playwright: 2 real browsers + local lobbylink + real WebRTC
```

Local play: two browser profiles/tabs → both open http://localhost:5173 → create/join the same
room code (server field: local `http://127.0.0.1:8787` or default public server).

---

## Phased checklist

### Phase 0 — Scaffold ✅ when: dev serves app; `npm test` green; local lobby server handshake OK

- [x] PLAN.md written to repo (this file)
- [x] package.json + tsconfig (strict) + vite + Svelte 5 + path aliases (@engine/@protocol/@storage/@ui)
- [x] COOP/COEP headers in vite dev + preview (needed by sqlocal/OPFS) — verified `crossOriginIsolated === true` in e2e smoke
- [x] Vendor lobbylink TS client → `vendor/lobbylink/` (commit in SOURCE_COMMIT; provenance README + `scripts/update-lobbylink.sh`)
- [x] Directory skeleton (`src/engine|protocol|storage|ui|headless`, `tests/`, `e2e/`)
- [x] `scripts/check-boundaries.mjs` (imports + banned APIs) wired into `npm test`
- [x] Engine determinism bans enforced by check-boundaries.mjs (deviation: no separate ESLint — the script covers both layering and banned APIs; add ESLint later only if needed)
- [x] Dev deps installed: vitest, @playwright/test, better-sqlite3, typescript, svelte-check (sql.js deferred to the fallback-dialect task)
- [x] Runtime deps: svelte, pixi.js, sqlocal, kysely
- [x] `scripts/run-lobby-server.sh` (go run, port 8787, origins for 5173/4173) — verified healthz + config.json
- [x] Playwright config (system Chrome channel, --no-sandbox --disable-dev-shm-usage, serial) + passing smoke test

### Phase 1 — Data foundations + SQLite (prompt item 1) ✅ when: data suite cross-checks all counts/costs vs mechanics docs; a command log written+replayed in browser (OPFS) AND node; hash goldens stable node+chromium

- [x] `src/engine/data/`: generator (`scripts/gen-data.mjs`) parses mechanics tables into
      `generated.ts` (53 picks, 82 fields w/ derived subjects, 173 techs, 191 applications,
      69 buildables, 9 hulls, 45 weapons, 14 mods, CP/scan/stealth/budget constants); curated
      `index.ts` adds lookups, pick exclusivity+budget validation, 13 stock presets (original
      names, mapped row-by-row to races.md). String ids are the canonical join key;
      APPLICATION_ROWS authoritative for tree structure. Leaders/monsters/antarans stat blocks:
      hand-transcription deferred to Phase 6 (consuming phase).
- [ ] 🔍 Non-weapon component tables (armor/shields/computers/drives/specials space+cost) — moved to Phase 4 (consuming phase: ship designer)
- [x] Data bug resolutions in `src/engine/data/README.md` (tech_id 24 + tech_id 10 duplicates → 224/225; tech_id 0 placeholders; numeric-id conflicts 43/72 → string ids canonical; Starlight Projector collision; source typo)
- [x] `rng.ts` (sfc32 + xxhash-derived streams), `isqrt.ts` (exact), `hash.ts` (xxhash32 w/ spec vectors, 16-hex fingerprints), `canonical.ts` (sorted keys, integer-only tripwire)
- [x] `DATA_VERSION` = runtime hash of canonical tables
- [x] Kysely schema + migrations; `storage/node.ts` (better-sqlite3) + `storage/browser.ts` (sqlocal/OPFS, per-game DB files); sql.js fallback deferred to Phase 8
- [x] `GameStore` repositories: commands/snapshots(gzip)/turnHashes/turnEvents/battleReplays/chat/prefs
- [x] Save export/import JSON envelope (tested round-trip)
- [x] Data validation test suite (counts, goldens, linked-list, referential integrity, preset legality) — 36 tests green; `gen-data.mjs --check` runs in CI to catch drift
- [x] Browser OPFS smoke (Playwright): #storage-smoke route writes+reads log+snapshot via sqlocal; node↔chromium parity asserted for DATA_VERSION, canonical hash, and RNG stream

### Phase 2 — Multiplayer core (prompt item 2) ✅ when: two real browsers via local lobbylink advance a stub game in lockstep with hash checks; tab reload resumes via resume-token + resync

- [x] `protocol/transport.ts` NetTransport; `lobbylinkTransport.ts` adapter; `memoryTransport.ts` hub w/ disconnect/rejoin simulation
- [x] `HostCore` sequencer (gapless seq, LocalHostLink for host's own session, seat roster restored from game_start on resume) + `GameSession` fold loop
- [x] `hello`/`welcome`/version-reject (protocol + data-version checks; post-start unknown-seat rejection)
- [x] `cmd_submit/accept/reject` + optimistic planned state w/ rollback; client-side validation first
- [x] `commit_turn`/`uncommit`/`commit_status`; `advance_turn` fires when all seats committed (stub counter engine behind `EngineAdapter` seam — real engine swaps in Phase 3)
- [x] `hash_report` per turn → `desync_notice` → auto `resync_request`/`resync_data` (command tail; gap detection also triggers resync; snapshot-based fast path + gzip deferred to Phase 8 perf budget)
- [x] Chat send/deliver + persistence (post-start)
- [x] Reconnect/rejoin: resume tokens (sessionStorage per tab), gameId derived from seed, per-room sqlite DB, session resume from snapshot+tail, host restart resume from persisted log, client re-hello on host rejoin
- [x] Protocol vitest suite over memory transport (9 scenarios: lobby, versions, start, optimistic, reject, commit/advance, resync, dual persistence, host restart)
- [x] Playwright e2e: 2 browser contexts, real WebRTC via local Go lobbylink — lobby/start/lockstep/hash-agreement/chat/reload-resume all pass (~7s)
- [x] Structural `SessionStore` interface keeps protocol layer storage-free (boundary-enforced)

### Phase 3 — Simulation core (prompt item 3) ✅ when: 2-bot 50-turn determinism (replay==live hash); 20-turn economy golden; node-vs-browser hash parity; 2 humans can play an economy-only game

- [x] Galaxy generation from seed (star counts per Book-Mapgen; color/planet weight tables are
      documented TUNABLE defaults, F13; homeworlds match race picks incl. gravity/size/minerals/artifacts)
- [x] GameState types (integer-only) + canonical serialize/hash integration
- [x] Command set: set_jobs, set_build_queue, buy_production, set_research,
      queue_extra_research, move_ships, colonize, build_outpost, scrap_ship, debug_* (flag-gated).
      Deferred: rename_colony (cosmetic), board_transports/send_population (Phase 6 invasion),
      create_design/set_fleet_policy (Phase 4). set_tax_rate REMOVED — no tax slider exists (F7).
- [x] Pipeline S0–S6 + S12 (elimination/conquest) + S13; S7-S11 arrive Phases 4-6
- [x] Colony economy per §04 order — formulas F1-F14 sourced + golden-locked (growth sqrt curve,
      morale, pollution, buy-cost piecewise, money incl. building %s, climate/mineral/maxpop
      tables, gravity penalties, freighter food redistribution, trade goods/housing)
- [x] Research S4: one active field, pre-selected target app, creative-all/uncreative-random,
      **creative-variant purchases** (full field cost each, one per turn), hyper-advanced repeatables
      (25000 + 10000/level), RP pool carries on switch (documented)
- [x] **Sticky-build mode** in set_build_queue (progress parks on switched-away item) + normal-mode carryover; overflow chains completions; buyout with per-turn lockout
- [x] Colonization/outposts; point-to-point FTL (fuel range from support stars, drives 2-7 pc/t +2 transdimensional, wormholes 1t); building maintenance w/ climate penalty (ship CP/maintenance in Phase 4)
- [x] `selectors.ts`: colonyRows/empireSummary/researchChoices/galaxyView/fleetRows/moveOptions
- [x] Headless bot driver (`src/headless/bots.ts`): expander policy + runHeadlessGame/replayGame
- [x] UI v1: colonies spreadsheet (jobs steppers, build dropdown + queue, buy, per-colony nets),
      SVG galaxy map (select/move/colonize), research screen (fields by subject + target radio),
      fleets table, empire header bar (BC/food/RP/research ETA/commit)
- [x] Determinism suites: 2-seed 40-turn bot games with replay==live, identical reruns,
      snapshot-restore equivalence, apply-purity, real-engine node↔browser hash parity (e2e)
- [x] Full e2e: two browsers play real turns (race select → orders via spreadsheet → commit →
      hash agreement → reload-resume mid-game → continue) in ~8s

### Phase 4 — Combat (prompt item 4) ✅ when: battle fixtures golden-locked; 20–40% equal-tech damage envelope passes; e2e battle renders and skips in 2 browsers; multi-turn sieges work headless

- [x] Component model + miniaturization as documented combat-redesign C-rules (shipdesign.ts
      header: C1 auto armor/drive, C2 computer 5% space, C3 shields 15%, C4 combat speed,
      C5 miniaturization -10% per deeper completed field (floor 50%), C6 to-hit window).
      Combat is exempt from classic fidelity per prompt.md.
- [x] Design -> combat-stat derivation (`designStats`; effect-registry integration lands Phase 5)
- [x] Tick sim (10/s, cap 400): stances charge/hold/standoff/evade with no-overshoot brawling,
      3 range bands (dmg 100/70/40%, hit +10/0/-20), to-hit clamp 5-95, shields flat+pool with
      3%/tick accumulator regen, armor->structure, ap/sp/hv/pd/af/co/nr mods, crippled <1/3
      structure, missiles/torpedoes as targetable projectiles + point defense, retreat
      thresholds, one-pass termination, survivors carry damage (repair at own colonies)
- [x] S7 pairwise encounters (colony owner defends; one battle per star per turn, rest queue);
      war/peace relations + declare_war/offer_peace handshake (full diplomacy Phase 6)
- [x] S8 battle-orders sub-phase: engine pauses in phase='battle_orders'; only battle_orders
      accepted; host auto-emits resolve_combat when all sides ordered or on timeout (defaults);
      protocol tests cover both paths
- [x] S9 outcomes + battle_replay events persisted to battle_replays via session; S10-lite:
      bombardment (20 dmg/pop unit, 60/40 pop/building split, never below 1 pop) + CP overage
      (10 BC/point) + colony-star repair. Invasion/ground combat + blockades -> Phase 6.
- [x] Ship designer UI (live designStats, mods, obsolete); spreadsheet queues designs;
      pre-battle orders dialog; Empires tab (relations, replay list)
- [x] Pixi battle viewer re-runs the deterministic sim for frames; procedural sprites (original
      shapes in player colors), beam/missile/death VFX, structure bars, shield rings,
      play/pause/1-2-4x/skip
- [x] Balance harness (3 archetypes x 3 stance pairs x 12 seeds + tier-advantage): COMBAT_PACE
      tuned to 250 -> 32.4% average fleet damage (target 20-40); tier advantage decisive >=80%
- [x] E2E: war -> fleets -> commit -> orders dialogs in both browsers -> deterministic resolve
      (hash agreement) -> replay viewer renders, skips, summarizes (~11 s)

### Phase 5 — Pluggable subsystems (prompt item 5) ✅ when: coverage test shows every tech application implemented or explicitly stubbed; earlier goldens unchanged except intended diffs

- [x] Modifier model (`effects.ts`): 19 targets across farm/prod/sci coeff+flat, morale,
      max-pop, growth, money halves, pollution divisor/absorb/zero, spy/scan/stealth, CP;
      colony scope (building present) + empire scope (tech known); coded colony handlers
      (robotic factory by minerals, VR network empire-wide, wellness non-cumulative)
- [x] Economy fully migrated to declarative data (`data/effectsMap.ts`) — golden tests
      unchanged; CP sources now modifier-driven (star bases, tachyon comms)
- [x] Live effect wins beyond parity: advanced_city_planning, learning_optimization,
      microlite_construction, space_port, scanners/spy techs, stealth_suit, megafluxers
      (+25% space), hull gating C7 (cruiser/battleship/titan/doomstar unlocks)
- [x] Combat/ship specials: implemented set (battle pods, reinforced hull, battle scanner,
      inertial stabilizer) + ~30 explicitly stubbed combat specials, colony defenses, fighters,
      terraforming chain, androids, advanced governments -> ledger entries tagged Phase 6/7
- [x] All 53 race picks accounted for in PICK_STATUS (implemented handler or Phase 6 stub:
      ground/spying/diplomacy/lucky/omniscient/stealthy picks)
- [x] Coverage gate: every application (191), buildable, and pick has modifiers | handler |
      stub — test fails on omissions; stub ledger printed as the remaining-work queue;
      no-op deferred buildings are unbuildable (DEFERRED list) so players cannot waste BC

### Phase 6a — Host save/load game files (URGENT, inserted 2026-07-08) ✅ when: save downloads a binary file; loading it re-hosts the identical game (hash-verified); corruption/tamper/version mismatches are rejected with clear errors; e2e covers the full save→reload→load→client-rejoin cycle

- [x] `storage/savefile.ts`: binary format = magic `MOO2SAVE` + version byte + gzip(canonical
      JSON SaveEnvelope: game row, players, full command log, latest snapshot). Plain-JSON
      envelopes also accepted (debugging).
- [x] Robust load validation: magic/version check, gunzip + JSON errors surfaced clearly,
      structural checks (gapless seq from 0, game_start first, seed format), engine/data
      version equality, and **full deterministic replay verification** (fold the log, compare
      the final hash to the snapshot hash) before any import. Layered `SaveFileError` stages
      (magic/version/compression/json/structure/engine_version/data_version/replay).
- [x] Save UI (host only, game header): download `.moo2save` (re-verified before writing);
      secondary raw `.sqlite3` download via sqlocal getDatabaseFile.
- [x] Load UI (Home screen): file dialog → decode/verify → import into the entered room's
      store (room_code overridden = manual re-host, loader becomes seat 0; other active games
      in the room marked abandoned) → resume path restores the game; joining clients resync
      automatically. Deviation: after a successful load the UI auto-connects, so the
      "loaded turn N" note is transient — the e2e asserts restored turn + state hash instead.
- [x] Tests: unit round-trip + corrupted-magic/truncated/tampered-payload/version-mismatch
      rejection (tests/storage/savefile.test.ts, 6 tests incl. node headless-game →
      export → encode → decode → import → host resume → hash equality); Playwright e2e
      (e2e/saveload.spec.ts: play turns → Save download → fresh room → Load upload →
      re-host hash-identical → second browser rejoins + resyncs → play continues →
      corrupted file rejected with clear error).

### Phase 6 — Full game systems ✅ when: headless 4-player 200-turn game exercises everything with stable hashes; each victory condition reachable in a scripted fixture

- [x] Leaders: 46-leader pool from mechanics/leaders.md; hire/dismiss/assign commands;
      offers/salaries/XP at S11; skill effects across economy/combat/espionage/diplomacy/
      movement (magnitudes = our L1-L4 decisions, documented in data/README.md)
- [x] Espionage: spy buildable (+1 agent, cap 10), E1 success formula (documented decision),
      steal/sabotage as turn events, assassin/spy-master leaders, alien management center
- [x] Diplomacy: proposals (peace/NAP/alliance/trade/research/gift/tech-exchange/surrender);
      surrender transfers the whole realm; trader/diplomat leader bonuses
- [x] Galactic Council: every 25 turns, two largest by population stand, votes weighted
      pop/5, 2/3 threshold wins (fixture-tested). Deviation: no accept/reject "final war"
      step — the tally is binding (documented simplification)
- [x] Random events (option-gated, E1: 8 kinds, lucky-immune); monsters guard ~12% of
      systems (M1 rescaled stat blocks); Orion = farthest star, Guardian + prize worlds,
      bounty = death ray + Loknar offer. Deviation: monsters guard but do not roam (M1)
- [x] Antarans (A1): raids from turn ~25 every 25-40 turns, scaling parties, raze on win;
      dimensional portal + attack_antarans → home-garrison battle → Antaran victory
- [x] Victory/loss: conquest, council, Antaran, concession (resign dissolves the realm);
      endscreen banner per win type (full endscreen polish in Phase 7). Score/time victory
      NOT implemented (optional; skipped — documented)
- [x] Gate: tests/determinism/soak.test.ts — 4 players, 200 turns, all modes on, replay==live
      hash + identical rerun trail (~3 s); combat specials batch (19 designable specials,
      colony defense batteries) landed en route

### Phase 7 — UI completion + modes polish ✅ when: full game start→victory by 2 humans, spreadsheet-first; auction e2e passes; all screens keyboard-navigable

- [x] Spreadsheet v2: multi-select bulk builds, filter box, sortable columns, totals footer,
      sticky-build parked-progress indicators. Deviations: drag-paint jobs skipped (steppers +
      bulk ops cover the workflow); named build templates skipped (bulk-set fills the role);
      optimistic planned state IS the dirty indicator (commands render instantly, host rejects
      roll back)
- [x] Lobby/setup: host game-setup panel (galaxy/start/all 5 modes with help text); custom race
      builder with live pick-budget validation; sealed-bid auction UI (commit → auto-reveal →
      results). Deviation: losers don't re-pick — the pick is simply forfeited (budget slack
      returns; documented in protocol/auction.ts); tie → lower seat wins
- [x] Map v2: fuel-range shading (dashed rings), monster-lair ☠ + blockade ⚓ badges with
      sidebar detail; fog = unexplored dimming (intel levels beyond explored/unexplored not
      modeled — deviation)
- [x] Reports timeline: filterable turn-event feed (~50 humanized kinds, unread badge);
      replay list on Empires
- [x] Diplomacy on Empires tab (proposals all 8 kinds, council voting) + chat dock with
      all/DM targeting
- [x] Empires tab: leaders (offers/hire/assign/dismiss), agents, resign, attack-Antarans;
      saves manager = Save/DB buttons + Home load (Phase 6a); help/glossary panel (?).
      No tax slider exists by design (F7)
- [x] Creative-variant purchase UI on Research; keyboard navigation via native controls
      (buttons/selects/inputs throughout)
- [x] Gates: auction e2e (e2e/auction.spec.ts) + full e2e matrix green (6 specs)

### Phase 8 — Hardening + performance ✅ when: 500-turn fuzz soak clean; desync drill recovers via resync; 8-player ~70-star turn < 2 s; snapshot < 8 MiB gzip; e2e matrix green twice consecutively

- [x] Desync drill: corrupted client state → hash_report mismatch → desync_notice →
      auto-resync → hash convergence (tests/protocol/desync.test.ts)
- [x] Host-loss: reload-resume covered in multiplayer e2e + host-restart protocol tests;
      "host offline" pause banner in-game; re-host from exported save = saveload e2e.
      Deviation: no dedicated claimAfterMs seat-replacement e2e (lobbylink handles seat
      claims; reconnect paths are covered)
- [x] Budgets (tests/determinism/budget.test.ts): 8-player large-galaxy 100-turn game —
      turn advance ≪ 2 s, gzip snapshot ≪ 8 MiB. Selector memoization audited: not needed
      at this scale (documented); spreadsheet virtualization unnecessary (< 100 rows)
- [x] Error surfaces: version-reject (Phase 2), host-offline banner, persistence-unavailable
      banner (Save disabled with tooltip)
- [x] sql.js kysely dialect: OMITTED (deviation) — the store-null fallback keeps play fully
      functional; an in-memory sql.js DB would add a dependency without real persistence
- [x] 500-turn chaos-bot fuzz soak (wars/diplomacy/spies/leaders/votes/buyouts randomized,
      all modes on) with full-replay + rerun-trail equality (tests/determinism/fuzz.test.ts);
      e2e matrix green twice consecutively

### Phase 9 — Deploy + handoff ✅ when: playable at public URL between two machines via pqrstuvw.xyz/lobbylink; a fresh dev/VM can resume from the repo alone

- [x] Static production build (`npm run build`, relative base `./`); original COI service
      worker (`public/coi-sw.js`, registered from index.html when not isolated) supplies
      COOP/COEP on static hosts; verified via `vite preview`
- [x] Default server `https://pqrstuvw.xyz/lobbylink` (DEFAULT_SERVER) + custom-server
      field on the Home screen (both since Phase 2)
- [x] README: setup, local lobby server, test suites, architecture map, multiplayer
      model, optional modes
- [x] `src/engine/data/README.md`: complete decision table (F1-F14, C, L1-L4, T1-T2,
      M1, A1, E1) — the 🔍 gaps of the original plan are all resolved-and-documented
- [x] Final PLAN.md status sync (this file). NOTE: publishing dist/ to a public URL and
      the cross-machine playtest is an operator step — the build is static-host ready
      and the public signaling allowlist already covers danielrh.github.io

## Verification

- Phase gates above; `npm test` must stay green throughout (vitest maxWorkers ≤ 2; e2e serial — sandbox has 2 CPUs).
- Determinism invariants: replay-from-log == live hash; node == browser hash sequences; snapshot-restore == continuous run.
- Human check per milestone: `npm run dev` + `scripts/run-lobby-server.sh`, two browser profiles, play.

## Risk notes

- OPFS needs cross-origin isolation → COOP/COEP dev headers now; service-worker shim for static hosting; per-game DB filenames (OPFS handles are exclusive per file).
- lobbylink reliable cap 16 MiB → gzip snapshots + app-chunk > 8 MiB + size budget test.
- Playwright + WebRTC in sandbox → proven earliest (Phase 2 smoke); system Chrome `channel:'chrome'` + `--no-sandbox`.
- Host trust: commit–reveal for sealed bids; malicious-host reordering accepted for friendly play (documented); full logs on every peer enable evidence + re-hosting.
- lobbylink upstream: no changes required (vendored client covers membership/reliability/reconnect). If a genuine need appears, patch upstream generically — never game-specific.

## Orion Ascendant continuation

The upstream architecture and completed phases above remain historical context.
The new single-player/strategic-AI work is tracked in
[docs/ORION_ROADMAP.md](docs/ORION_ROADMAP.md), with architecture decisions,
fidelity classifications and executed verification linked there. Orion reuses the
existing solo mode and protocol; it does not restart the upstream engine plan.
