# Classic fidelity ledger

This is a scoped source audit, not a completed comparison against an installed
1996 game. Target descriptions come from the repository's `mechanics/` reference;
formula choices and known deviations come from `src/engine/data/README.md`, the
implementation and tests. MATCH means the audited behavior matches that stated
target, not that every edge case is certified. Do not replace whole subsystems
merely to remove an entry from this ledger.

Classifications: **MATCH** implemented target behavior; **PARTIAL** some behavior
present; **REDESIGNED** deliberately different; **STUBBED** named/data entry with
unimplemented effect; **MISSING** no implementation of the target feature.

| Behavior | Status | Evidence / scope | Follow-up |
| --- | --- | --- | --- |
| Farmers/workers/scientists, food and freighter distribution | MATCH | economy.ts, selectors.ts; economy/foodjobs/multirace tests | Continue edge-case/balance audit |
| Morale, pollution, growth, gravity, minerals and buyouts | PARTIAL | economy.ts; F1–F14 document formula choices | Compare exact arithmetic and caps |
| Race presets and point-budget custom picks | MATCH | data/index.ts, adapter.resolveRaceConfig; Lobby builder | Audit trait interactions |
| Android workers and captured/native population groups | PARTIAL | economy.ts, commands.ts; androids/multirace tests | Full classic comparison outstanding |
| Research fields and targeted application selection | MATCH | research.ts; researchtarget/techtree tests | Audit tree costs and timings |
| Classic Creative grants all field applications | MATCH | research.ts when creativeVariant is off | Keep classic mode available |
| Optional Creative application purchases | REDESIGNED | creativeVariant, extra research queues | Clearly identify optional rule |
| Sticky production investment | REDESIGNED | optional stickyBuild command behavior | Preserve as opt-in |
| Fuel-limited star-to-star travel and exploration | PARTIAL | movement.ts, galaxyView, scouts/wormhole tests | Intelligence levels and concealment incomplete |
| Star/gateway technologies | STUBBED | effectsMap jump_gate/star_gate ledger | Implement only after travel/replay tests |
| Colony ships, outposts and settlement | MATCH | commands.ts, fleetRows; colony/outpost tests | Audit costs and mixed ownership |
| Ship designer, hulls, components and refit | PARTIAL | shipdesign.ts; documented C1–C7 choices | Audit classic component space/costs |
| Turn-based player-controlled tactical combat | MISSING | current combat is automatic | Phase 5 distinct deterministic mode |
| Automatic combat and visual playback | REDESIGNED | combat.ts, battles.ts, BattleViewer | Retain as autoresolve |
| Bombardment and marine invasions | PARTIAL | battles.ts, ground.ts; groundbattle/marines/bombard tests | Never-below-one-pop behavior differs from a complete classic audit |
| Teleportation, stasis/cloak specials and some ground equipment | STUBBED | effectsMap explicit stub entries and tests/data/effects | Audit individual handlers, not ledger labels alone |
| Colony defenses and planetary shields | PARTIAL | effectsMap; deferred shield entries, bombardment handlers | Reconcile data ledger with actual handlers |
| Terraforming and advanced governments | PARTIAL | terraform.ts, effects/commands; terraform/advancedgov tests | Compare full progression and limits |
| Espionage, leaders, treaties and proposals | PARTIAL | espionage.ts, leaders.ts, diplomacy.ts | Formula and treaty edge cases remain |
| Council victory | PARTIAL | periodic council and weighted voting; PLAN documents binding tally | Classic final-war acceptance/rejection missing |
| Conquest and Antaran victory | PARTIAL | pipeline.ts, npc.ts, groundbattle/npc tests | End-to-end victory audit outstanding |
| Roaming monsters and full intelligence levels | MISSING | static guardians; explored/scanned visibility only | Later fidelity work |
| Omniscient and stealthy-ships traits | STUBBED | PICK_STATUS in effectsMap.ts | Implement knowledge rules before granting AI access |
| Score/time victory | MISSING | upstream PLAN explicit omission | Decide priority after core victories |
| Capable offline AI opponents | PARTIAL | Orion local AI, 100-turn protocol headless test | Defense/conquest/strategy quality next |
| Persistent emperor memory and conversational diplomacy | MISSING | optional future Orion innovation | Phases 3–4; no live provider in Phase 1 |
| Detailed spreadsheet management and simultaneous turns | REDESIGNED | Svelte UI and WEGO HostCore | Classic-style solo pacing overlays existing pipeline |

The effect ledger contains historical phase labels that can lag newer handlers.
A label alone is not proof that a mechanism is absent. Future audits should
record a concrete command path and regression fixture for each reclassification.
Original proprietary artwork, writing, audio and character names must not be
imported into Orion content.
