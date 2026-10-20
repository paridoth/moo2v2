# Orion roadmap

## First milestone plan

1. Inspect source/session/host/save/visibility APIs and run upstream baseline.
2. Reuse offline entrypoint; add two default fair opponents through local links.
3. Introduce a typed observation and expander-derived policy, separate executor.
4. Persist seat/config ownership and completion without changing old save shapes.
5. Verify automatic turns, combat, privacy, deterministic headless quality,
   reload/save import, and existing multiplayer; document precise test results.

## Delivered scope

- [x] Phase 0 source audit, baseline runs and architecture/fidelity/decision docs.
- [x] Default one human plus two local strategic AI seats; no lobby server required.
- [x] Existing race/custom-race and galaxy/rule settings retained.
- [x] Easy/Normal policy difficulty and initial strategic preset biases.
- [x] Typed filtered observation, modular planning functions and ordinary commands.
- [x] Food/jobs/builds/research/settlers/exploration/basic navy/treasury behavior.
- [x] Automatic commits, AI battle orders, rejection/shutdown/duplicate protection.
- [x] Optional manifest and completion state preserve replay and save/rebase behavior.
- [x] Browser reload and save-file import reattach stored AI seats.
- [x] Automated quality/determinism/privacy/protocol/browser coverage.

Verification commands and recorded results live in
[ORION_VERIFICATION.md](ORION_VERIFICATION.md). Completion here refers to the
small Phase 1 vertical slice, not all strategic or fidelity goals.

## Known limits and next milestones

**Phase 2 — advanced strategy.** New games use `strategist-v3`; saved v1 and v2
games retain their policy. The first milestone (`strategist-v2`) delivered:

- [x] Derived strategic goals, treasury/food forecasts and bounded reserves.
- [x] Research utility, prerequisite lookahead and foundational technology paths.
- [x] Shipyard roles, legal auto-design template selection and queued CP budgets.
- [x] Visible hull-strength estimates, defense reinforcement and fleet rallying.
- [x] Grouped escorted marine expeditions, battle invasion orders and capture.
- [x] Restrained war preparation/declarations and own council candidacy votes.
- [x] Three seeds, six races, three start modes, repeated 110-turn hash trails,
  privacy tests, full replay and interrupted/completed-plan save continuation.

The fleet-modernization milestone (`strategist-v3`) adds:

- [x] Legal escort/assault design generation using researched components.
- [x] Managed design refresh with slot limits and protection for queued work.
- [x] Paid same-hull refits at available yards; queued ships remain at the yard.
- [x] Budget, duration, readiness and improvement thresholds for refits.
- [x] Mixed-policy save/rebase/SQLite continuation and default-policy browser checks.
- [x] A repeatable six-match, 150-turn benchmark against active v2 opponents,
  swapping seats and measuring food lack, idle production, research and refits.

Remaining: larger competitive tournaments, calibrated combat forecasts,
maintenance routing to distant yards, additional design roles, multiple fronts
and Antaran victory planning. Initial comparisons reached the turn cap without
victory; they establish executable development/maintenance coverage, not win-rate
superiority. Shared advanced-start food shortages and slow pre-warp development
remain measurable balance gaps. There is no hard difficulty or learned opponent
model yet.

**Phase 3 — emperor personalities and memory.** Persist behavioral profiles,
relationships, incidents, goals and treaty reputations; influence actual planning.
Current presets are small biases, not these full characters.

**Phase 4 — optional LLM diplomacy.** Filtered requests, secure provider bridge,
structured legal proposals, conversations/event memory, AI-to-AI negotiation,
budgets/retries/fallbacks and offline replay. No live integration in this release.

**Phase 5 — classic tactical mode.** Player-controlled deterministic combat as an
option; keep automatic combat as autoresolve. Version all new combat state.

**Phase 6 — modern interface.** Map, colony management, ship designer, research,
diplomacy and original character presentation. Retain detailed controls.

**Phase 7 — fidelity, balance and distributables.** Audit the fidelity ledger,
effect stubs, all victories and save compatibility, then package stable builds.

Additional limits: legacy experimental bots still have full-state knowledge;
only Orion strategic AI has the new observation boundary. Legacy saves without
seat metadata use their older controllers. Upstream lockstep is an honor-system
multiplayer architecture, not hidden-state anti-cheat. Existing Svelte warnings
and build-size warnings remain. Strategic preset naming and balance are early.
