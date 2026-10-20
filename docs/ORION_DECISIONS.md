# Orion decisions

1. **Extend upstream solo play.** The inspected upstream already has offline
   games, multiple bots, reloads and saves. Reuse its Home/Lobby/game/storage
   paths. Orion strategic AI is the default; legacy fair/parity/onion choices
   remain explicitly selectable. Parity is labeled experimental debug assistance.
2. **Local AI uses normal seats.** Use HostCore local links and independent
   GameSessions. Allocate contiguous fresh local empire ids instead of exposing
   transport channel ids 1000+. No direct gameplay mutations from orchestration.
3. **A separate AI layer.** Add an enforced `@ai` layer importing engine/protocol,
   with UI/headless allowed to consume it. The engine never imports AI.
4. **Filtered DTO rather than redacted GameState.** Policies cannot accidentally
   query a hidden enemy field through an engine selector. Observation construction
   stays at one trusted boundary and tests assert hidden-state invariance.
5. **No cheating in Orion difficulties.** Easy/Normal change choices, not rules,
   resources or visibility. Existing debug grants stay confined to legacy parity.
6. **Classic pacing over the current pipeline.** Human commits first, then AI
   issues orders and commits; normal host advancement and battle phases remain.
7. **Durable AI completion.** Protocol commits are not command-log entries, so
   they cannot prevent replanning after a crash. A new validated completion
   command and optional empire field solve this without a second persistence log.
   Canonical command identities also cover interrupted partial plans.
8. **Optional settings manifest.** AI seat ownership, strategy version and config
   travel with existing game_start/settings/snapshots. Old states omit them.
   Save envelope/database schemas do not change. Old command behavior is unchanged;
   this addition does not change old-log rule arithmetic. Frozen saves remain intact.
9. **One in-flight order and no polling.** Event-driven coalescing plus per-turn
   intent deduplication and bounded work avoids timer leaks and runaway retries.
   Host close also rejects already queued local messages.
10. **Self-contained upstream regression fixture.** Baseline tests depended on an
    untracked bug save. Recreate its beam-destroyer/minimum-population scenario
    in the test rather than weakening/skipping its assertions or editing a golden.
11. **Persistence ordering is explicit.** A queued local-link delivery must ingest
    before HostCore captures the session flush barrier. Restart/leave drain
    queued deliveries and flush before destroying SQLite. Browser restart tests
    exposed outstanding writes using a destroyed driver; a gated-store protocol
    test proves remote turn broadcasts wait for durable commands. Single-player turn readiness in
    the UI also waits for persistence: under CPU load a background tab could show
    the next turn before its SQLite tail was written, then lose it on reload.
12. **Future systems remain designs.** No live LLM, provider framework, tactical
    rewrite, voice work or graphics overhaul in this milestone. Preserve narrow
    interfaces and record limitations rather than calling those systems complete.
13. **Policy upgrades are explicit and saved.** New campaigns use `strategist-v2`;
    existing `expander-v1` manifests retain v1 behavior on continuation. Unknown
    policy ids fail explicitly. The manifest format remains version 1: the policy
    id is its existing extension point. Accepted-command replay never dispatches AI.
14. **Derive operational commitments from saved facts.** Goals, forecasts and
    rally selection use current observations, queues and own transit orders.
    No ephemeral plan object must survive a reload. Keep completion markers and
    canonical command deduplication in the existing controller.
15. **Estimate uncertainty without revealing hidden state.** Enemy strength uses
    visible hull summaries and fixed colony defense allowances. Marine counts
    are bounded expeditions rather than hidden-garrison counters. Existing treaties
    prevent autonomous war declarations. V2 reuses engine-maintained legal ship
    templates; v3's custom-design extension is recorded below.
16. **Version the fleet-modernization policy.** `strategist-v3` is the new-game
    default. V1/v2 manifests retain their policies; engine/save versions remain
    unchanged because accepted-command mechanics are unchanged. V3 creates legal
    custom designs and refits via existing commands, not grants or mutations.
17. **Queues are maintenance commitments.** New and restored refit queues hold
    their ship at its yard. Design refresh cannot obsolete a queued target and
    cancel its progress. Useful refits compete for bounded local yard capacity;
    distant maintenance routing remains future work.
18. **Measure active opponents without inventing wins.** Matched-seat benchmarks
    automate the human seat through the same filtered policy/ordinary commands
    while normal controllers run the other seats. They revalidate and replay the
    accepted history. Count completed refit events and actual waste/food lack;
    unfinished turn-cap games are never labeled victories or used to claim a
    competitive win rate.
