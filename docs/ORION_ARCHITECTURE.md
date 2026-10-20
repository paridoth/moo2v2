# Orion architecture

## Inspected foundation

Source baseline: upstream `ba4e7ccfd058788158c978307616c21b1e2c7c53`.
Inspection included README, PLAN, package scripts, the save contract, engine
adapter/commands/pipeline/selectors/contact, protocol host/session/links/setup,
storage repositories/savefile/rebase, headless bots, Svelte screens, tests and E2E.
Upstream already implements solo campaigns and multiple experimental bot policies.
Its older PLAN statement that no NPC empires ship is stale. Orion extends the
existing solo entrypoint instead of adding another game shell.

`createHostedGame` creates HostCore and the human GameSession with independent
engine adapters (their event buffers must not be shared). Each AI uses
`HostCore.createLocalLink` and its own adapter/GameSession. Local channel ids
start at 1000; fresh lobby hellos now allocate ordinary contiguous empire ids.
Remote peer ids and saved seat/name matching retain their previous behavior.

GameSession validates submissions against planned state. HostCore validates
again against authoritative state, assigns gapless sequence numbers, folds,
and broadcasts. The human session is the only persistence writer. Commits are
protocol messages; all seats must commit before the host logs `advance_turn`.
Battle orders use the existing pause and `resolve_combat` command path.
Host turn broadcasts now await local ingestion before capturing the persistence
barrier. Restart/leave flush pending writes before destroying the database.
The single-player turn label and End Turn readiness wait for the session flush at each turn
boundary, so a newly displayed turn is safe to reload even under CPU load or
background-tab throttling. A brief Saving turn status covers that interval.

## Orion vertical slice

- `src/ai/types.ts`: observation, strategy context, command and policy interfaces.
- `observation.ts`: trusted conversion of authoritative state to empire knowledge.
- `strategy.ts`: expander-derived research, economy, fleet and diplomacy components.
- `controller.ts`: event-driven command execution, validation/rejection recovery,
  battle responses and commits. One in-flight command; no polling timers.
- `seats.ts`: session/host attachment; policy injection supports tests and future strategies.
- `src/ui/net.ts`: setup manifest, offline hosting, persistence restore and lifecycle.
- Home uses the existing Lobby for race/custom picks and rule settings.

The policy never receives GameState, a GameSession, or a host reference. The
observation builder and executor are trusted boundaries; clients still contain
the full deterministic state for lockstep. This is an AI information boundary,
not a new anti-cheat protocol or server-side secrecy guarantee.

The AI waits for the human commit. Accepted AI orders are sequenced just like
human orders. AI participants answer battles automatically; a human participant
retains their battle dialog. Completed turns expose a report summary and the
existing detailed Reports screen. Fast-start settings still use the host's
existing fast-turn commitment protocol; classic synchronous flow is the default.

## Persistence and replay

Optional `GameStateSettings.singlePlayer` stores a versioned manifest:
human seat, difficulty and each computer seat's stable name/id, strategy,
personality, race JSON and optional fleet style. It is copied unchanged through
`game_start`, snapshots and existing save exports/rebases. No new save envelope
field, database migration, dependency or replacement persistence format is needed.
Absence preserves legacy/multiplayer behavior.

`ai_turn_complete` is an ordinary validated command restricted to configured AI
seats. It sets optional `Empire.aiTurnCompleted` to the current turn. No resources
or simulation advancement are granted. On reload a completed AI recommits
without replanning. Partly completed plans skip commands found in the restored
current-turn log using canonical payload identities. Battle orders are already
present in state and are not resubmitted.

Replay only folds accepted commands; it never runs the strategy or contacts an
external provider. Existing command semantics and old state defaults are
unchanged. The envelope stays v2. Frozen old-save fixtures remain untouched.
The save contract in [save-compatibility.md](save-compatibility.md) applies to all
future changes. New fields remain absent when old logs are replayed.

Saved manifests override current Home selections on reentry. Downloaded Orion
saves route to offline hosting. Pre-Orion solo saves without ownership metadata
continue through the legacy fair/parity controllers; guessing a migration into
new AI seats would alter their behavior. Multiplayer save loading stays on the
existing remote-room path.

## Advanced strategic policy

New single-player manifests select `strategist-v3`; existing saved policy ids
are honored by `src/ai/policies.ts`. Both v1 and v2 stay available as
compatibility policies and regression benchmarks. The same controller, local
links, completion markers, battle path and persistence barrier execute both.

The v2 planner separates assessment, research, economy, strength estimates and
operations into corresponding modules under `src/ai/`. Observation now also
provides own legal build costs/design options, own buffered job forecasts,
existing treaty protections and public council candidacy. No enemy private
designs, economy, garrisons or orders are added. Determinism checks now apply to
the AI layer too, allowing only the controller's existing microtask scheduling.
Planning state is derived from the DTO and saved queues/transits; no new engine
state fields, command semantics, rule versions or save migrations are required.

The v3 `admiral.ts` policy adds `modernization.ts` for managed role designs and
paid refits. `naval-observation.ts` is a trusted helper of the observation
builder, deriving legal payloads, own-fit estimates and legal local refit choices.
It shares no simulation reference with a policy. Refit queues themselves reserve
ships across reloads; operations omit them until completion. Queued design/refit
targets are not obsoleted. Specialized designs occupy normal player slots and
ship upgrades consume ordinary colony production.

`src/headless/orion-match.ts` supplies active-opponent measurement through the
same host/session path, separate adapters and filtered policies. Its evaluator
may inspect full state for metrics, but that state never reaches a policy. The
CLI in `scripts/orion-benchmark.mjs` uses the existing Vite runtime for TypeScript
loading and emits repeatable JSON/Markdown results without new dependencies.

## Future seams (design only)

Advanced strategic policies implement `StrategicPolicy` against the observation
DTO. Forecasts and goals belong outside the engine; only accepted orders enter
history. Version any persistent AI memory and serialize decisions needed for
continuation. Add optional fields under the save contract, never opaque runtime
objects or timers.

Personalities/relationships should distinguish public strategic facts, private
empire memory and conversations. Engine-recognized agreements must become legal
commands with logged outcomes. A future provider bridge receives a narrower
DiplomaticObservation, persona, relevant memories and legal-action schema, then
returns a proposal. It cannot hold a state mutation callback. Validate provider
output, check resources/legality and log accepted mechanics. Replay/load never
recontact it. Keep API keys in a local/server bridge, with budgets, timeouts,
retry limits and deterministic scripted fallbacks. Providers may include Ollama
and hosted OpenAI-compatible endpoints; none are implemented here.

Interactive tactical combat will be an explicit mode alongside existing
autoresolve. Any new combat state/commands must remain deterministic and
versioned; the current simulator remains usable.
