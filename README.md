# MOO2v2

Try it at https://fireflyk64.github.io

A browser 4X strategy game with rules and mechanics inspired by Master of Orion 2 — economy,
tech tree, race picks, colonies, leaders, espionage, diplomacy, monsters, Antarans —
**except combat and the Creative trait, which are redesigned**. 100% TypeScript,
peer-to-peer multiplayer over WebRTC, SQLite persistence in the browser, and a
spreadsheet-first UI with simultaneous (WEGO) turns.

All art and prose are original: procedural sprites, our own descriptions. Rule
arithmetic the source docs omit is our own documented design (see
`src/engine/data/README.md`).

## Quick start

```bash
npm install
npm run dev                    # http://localhost:5173 (COOP/COEP headers on)
scripts/run-lobby-server.sh    # local Go signaling server on http://127.0.0.1:8787
```

Local play: open two browser profiles/tabs at http://localhost:5173, enter the same
room code in both (server field: local `http://127.0.0.1:8787` or the default public
`https://pqrstuvw.xyz/lobbylink`). The room creator is the permanent host.

URL parameters skip the form: `/?server=…&room=CODE&name=Alice&players=2`.

## Tests

```bash
npm test              # boundaries + data + unit + protocol + storage + determinism
npm run test:game     # headless suites incl. 200-turn soak + 500-turn fuzz
npm run test:balance  # combat balance harness (MOO2_BALANCE=1)
npm run test:e2e      # Playwright: real browsers + local game server + real WebRTC
(cd server && go test ./...)  # Go game server (play-by-mail store)
```

## Production build

```bash
npm run build         # static site in dist/ (relative base path)
npx vite preview      # serve it locally with COOP/COEP headers
```

Deploy `dist/` to any static host. OPFS persistence needs cross-origin isolation;
on hosts that can't send COOP/COEP headers (GitHub Pages), the bundled
`coi-sw.js` service worker adds them (one automatic reload on first visit).
The public signaling server allowlists `danielrh.github.io` and localhost dev.

## Architecture map

```
src/engine     pure deterministic core: zero deps, integer-only math, sfc32 PRNG,
               canonical JSON + xxhash state hashes. Data tables generated from
               mechanics/ into data/generated.ts; effects are declarative
               modifiers + coded handlers with a coverage-gated stub ledger.
               Turn pipeline S1-S13 (economy, research, movement, battles,
               ground ops, leaders, espionage, NPCs, diplomacy, victory).
src/protocol   event-sourced lockstep: HostCore sequencer assigns gapless seq
               to every command; GameSession folds them + optimistic planned
               state; hello/welcome versioning, resync, chat, sealed-bid pick
               auction (commit-reveal). Transport = vendored lobbylink WebRTC.
src/storage    kysely over better-sqlite3 (node) / sqlocal+OPFS (browser):
               command log, gzip snapshots, turn hashes, events, replays, chat;
               .moo2save binary save files with full replay verification.
src/ui         Svelte 5 screens (colonies spreadsheet, map, research, fleets,
               designer, empires, reports) + pixi.js battle viewer that re-runs
               the deterministic sim for playback. Warships are procedural
               pixel-art sprites: every empire picks one of ten fleet styles
               (set_ship_style, cosmetic) and every design one model variant of
               its hull class; battle/shipart.ts generates the grids, shiptex.ts
               rasterizes/tints them, effects.ts draws weapon, shield, engine
               and explosion VFX on an additive glow layer.
src/headless   scripted bots (expander, chaos) driving full games for tests.
```

Load-bearing invariant: `replay(log) == state`, always. The engine bans
`Math.random`, `Date`, floats in sim state, and unordered iteration —
enforced by `scripts/check-boundaries.mjs` along with layer imports
(`engine ← protocol ← storage; ui may import all; nothing imports ui`).

- `PLAN.md` — the full phased checklist (all phases complete) with deviations
  recorded in place.
- `src/engine/data/README.md` — every formula decision (F1-F14, C, L1-L4, T1-T2,
  M1, A1, E1) with sources and the tests that lock them.
- `mechanics/` — the safe-terminology mechanics reference the data generator
  parses.
- `vendor/lobbylink/` — vendored WebRTC client (provenance + update script).

## Save compatibility

Saves are forward-compatible from format v2 on: every `.moo2save` embeds a
final-state snapshot and loads on any future build (snapshot-first when
versions differ, full replay verification when they match). Saves carry the
whole turn history unless "no history" is checked, and the load screen can
branch a "what-if" game from any earlier turn. The rules that keep this true
live in `docs/save-compatibility.md` — read them before changing engine state
or data tables. `tests/storage/golden.test.ts` enforces them with a frozen
fixture.

## Multiplayer model

The host (room seat 0) sequences every command — including its own — into a
gapless log and broadcasts; every peer folds identically and reports state
hashes each turn. Hash mismatch triggers automatic resync. Both peers persist
the full log + snapshots per room in their own browser database, so the host
can reload mid-game and resume, and any player can download a verified
`.moo2save` and re-host it in a fresh room.

## Play by mail

For games where nobody can agree on a time. The game's own Go server lives in
`server/` (`cmd/moo2v2-server`): it links the generic lobbylink lobby in as a
library (the public `lobbyserver` package, fetched from GitHub and pinned in
`server/go.mod` — lobbylink itself stays game-agnostic; use a `go.work`
pointing at a local checkout to hack on both) and mounts moo2v2's
play-by-mail routes next to it. Started with `--pbm-config <file>` (JSON:
`{"password", "data_dir", "lock_ttl_seconds"}`, example in
`server/pbm-config.example.json`), it stores one authoritative save per room
code under `/pbm/` and hands out a single expiring lock so one player at a
time hosts. Flow: log in once with the
shared password (remembered as a token), take the room lock, the latest save
downloads and re-hosts locally over the same server; every commit re-uploads
the save together with who-has-committed, so the game advances whenever the
last outstanding player mails in their turn. "📬 mail in & leave" does a final
upload and releases the lock (a vanished player's lock simply times out). If
someone is playing right now, your PBM login joins their live game instead —
and any 💾 save of a PBM game resumes as a normal serverless game, so play can
move freely between the two modes. Seats can carry an optional protect
password; like everything here past the shared password, that is coordination
for friends on the honor system, not a security barrier. The dev/e2e server
(`scripts/run-lobby-server.sh`) enables PBM with password `moo2` and data under
`/tmp/moo2v2-pbm-dev`.

## Optional modes

- **Creative variant** — Creative races buy field applications individually.
- **Pick bidding** — contested race picks go to sealed-bid (commit-reveal) auction.
- **Sticky build** — switching builds parks invested production on the old item.
- **Antaran attacks** — scaling raids; build the dimensional portal to win at their home.
- **Random events** — option-gated windfalls/disasters; lucky races dodge the bad ones.

## Orion Ascendant single player

Select **Orion strategic AI (fair)** (the default), enter your name, and click
**Single player vs 2 bots**. No signaling server, second tab, API key or LLM is
needed. Choose Easy/Normal and opponent presets on Home; choose your race/custom
picks, galaxy and existing rules in the lobby, then Start game. Issue orders and
End Turn; both computers act and the usual engine resolves the turn. Battle
participants controlled by AI answer automatically. Use Reports for turn details.

Save downloads a verified `.moo2save`. To resume browser storage, reenter the same
campaign room code and click Single player. Stored AI ownership/settings override
Home choices. To restore a downloaded Orion save, enter a name and room code,
choose Load and confirm; it hosts offline with its computer seats. For a fresh
campaign use a different room code or the in-game Restart control.

See [Orion roadmap](docs/ORION_ROADMAP.md),
[architecture](docs/ORION_ARCHITECTURE.md) and
[verification](docs/ORION_VERIFICATION.md). New campaigns use the strategic
policy (`strategist-v3`) with research paths, production forecasts, shipyard
roles, escort/assault designs, paid refits, fleet rallying and escorted marine
invasions. Saved v1/v2 campaigns retain their original policies.
Competitive balance, richer emperor memory and conversational diplomacy remain
future work.

Run `npm run benchmark:orion` for six active v3-versus-v2 matches (150 turns,
swapped seats across three races/start modes). Results and a report go to
`benchmark-results/orion.json` and `.json.md`. Use `-- --turns 300 --output
benchmark-results/long.json` to change the cap/output. Turn-cap games are reported
as unfinished. The benchmark validates accepted-log replay and measures refits,
idle production, research and food shortages; it does not establish win-rate
superiority.
