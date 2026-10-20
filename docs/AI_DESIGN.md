# Strategic AI design

## Implemented contract

`StrategicPolicy.plan(EmpireObservation, StrategyContext)` returns ordinary
command intents. `battleOrders` returns legal pre-battle orders. No policy may
receive authoritative GameState or a mutable session. The trusted controller
refreshes the observation after each response, validates through GameSession,
and relies on HostCore for final authority. Strategy components are exported
separately for research, economy, fleets and diplomacy.

The baseline adapts the working `src/headless/bots.ts` expander's sequence:
feed colonies, assign industry/science, choose useful builds, keep research
active, explore and settle. Legacy scripted bots and experimental UI bots remain
available as regression benchmarks; the new runtime does not import headless/UI.

## Knowledge boundary

Own empire, colonies, ship details, economy outputs, available research and move
options are legitimate inputs. Foreign empires expose contacted ids/names only.
Enemy colonies expose scanned and surveyed identity/owner/outpost status, not population,
queues, buildings, treasury, designs or research. Enemy parked fleets expose the
same kind/hull summaries as galaxyView in currently scanned systems. Enemy transit
fleets are withheld. Unsurveyed planet details, raw star/wormhole objects, private
proposals and unrelated battles are omitted. Visible guardians inform safe
civilian routes. The returned DTO is detached from simulation references.

Observation tests change hidden enemy ships, population, buildings, queues,
credits and technologies and require identical observations and decisions.
A future knowledge model should persist stale sightings separately. The initial
policy is stricter than upstream galaxyView: explored systems outside current
scanners do not expose live foreign fleets, colonies or new contacts. Geological
survey information remains available after leaving scanner range.

## Baseline decisions

- Economy uses existing job presets and the food solver; preserves native and
  android job restrictions. Research receives a share of flexible population.
- Research prioritizes inexpensive live choices and useful applications, with
  explicit deterministic ties. It replaces exhausted targets.
- Production prioritizes economic foundations, a small normal-difficulty navy,
  a bounded settler pipeline, infrastructure and command-point headroom.
- Treasury reserves constrain buyouts; deficit handling uses trade goods and
  ordinary production taxes. Food transport shortages request freighter fleets.
- Scouts explore reachable unknown systems. Settlers score surveyed free planets
  by size/climate/minerals, otherwise explore. Known guardians/hostile ships are
  avoided by civilians. Warships defend visible threats and can move toward
  discovered colonies of empires already at war.
- Incoming proposals receive a simple mechanical accept/reject policy. There
  is no diplomatic conversation, relationship memory or autonomous war planning.
- Combat uses legal stance/target/retreat defaults and preserves human orders.

Easy focuses on economy and expansion and omits routine navy production/buyouts;
Normal includes them. Neither difficulty grants money, technology or hidden
knowledge. Profiles provide small practical biases: techer adds science,
industrialist spends reserves sooner, expander increases settlers, and
militarist/rusher seek a larger navy. These are initial strategy presets, not
Phase 3 emperor personalities. Balanced is the common policy.

## Execution and recovery

The controller waits for the human commit (or the equivalent fast-turn status),
sends one order, then waits for acceptance/rejection before choosing the next.
Canonical command identities prevent retrying the same intent during a turn.
Rejected intents are skipped, not retried indefinitely. Attempt count is bounded
by empire size with an absolute 512 cap. No controller timers or intervals exist.

`ai_turn_complete` durably marks finished planning. Reload restores that marker
and recommits without ordering again; partly completed turns use the current
log to skip previously submitted intents. Battle orders already in state are
honored. A closed controller unsubscribes and queued work checks its closed flag.
The host also refuses queued messages after close. Victory stops AI activity;
eliminated seats still satisfy the upstream host's all-seat commitment barrier.

Headless acceptance runs real HostCore/GameSession/local links, not an alternate
simulation path: one human commits and two strategic controllers play 100 turns,
with per-turn identical-run hashes and full-log replay validation. Quality gates
require expansion, factories, research growth, military construction and fed
colonies. Additional fixtures exercise save import/rebase, restart before turn
resolution, rejected commands, human battle decisions, shutdown and privacy.
These are practical baseline gates, not a claim of competitive AI strength.

## Phase 2: strategist-v2

The first advanced policy is `strategist-v2`. Saved `expander-v1` seats continue
with the original policy; `policies.ts` dispatches by the manifest's saved id. The
manifest version, save envelope, database schema and engine arithmetic are
unchanged. Replay folds the accepted commands and never invokes a policy.

`assessment.ts` derives recover/defend/expand/conquer/develop goals from current
knowledge. It forecasts four turns of treasury pressure, reserves six turns of
deficit spending, estimates naval demand and bounds marine expeditions. None of
these derived goals needs persistent memory. Own accepted transit orders and
queues provide durable commitments across partial-turn reloads.

`research.ts` scores useful applications per expected research turn using listed
costs. Discounted utility from descendants up to three prerequisites away helps
select deliberate paths. Factories, laboratories and pre-warp colony capability
receive high foundational values. Active research is retained to avoid churn.
Uncreative application outcomes remain the engine's normal seeded choices.

`economy.ts` allocates military production to the strongest third of colonies;
other worlds prioritize infrastructure. It selects among the engine-maintained,
best-known design templates by hull strength and build time, reserves command
points for queued ships, grows command capacity, trains/boards marine transports
through ordinary production, and budgets buyouts against reserves. Own-job
forecasts keep a food buffer for growth and preserve cybernetic upkeep workers.
Native farmers and hardwired android jobs remain protected. V1 still receives
its original lean job recommendations.

`strength.ts` uses coarse hull weights for visible enemy ships. It never reads
enemy weapons, damage, garrisons or technology; enemy colonies receive a fixed
defense allowance and attacks require a safety margin. Own damage is known and
reduces estimated readiness. These values are heuristics, not combat odds.

`operations.ts` reserves local defenders, counts in-flight reinforcements and
sends nearby ships to threatened colonies. Offensive groups rally at one safe
origin until escorts and at least twelve marines can depart together. The
existing battle order enables invasion after a win; enemy outpost-only systems
receive a bombard order to remove the dome under the normal engine rules.
Civilian population cargo never counts as marines; prior civilian transit
destinations are reserved too.
Militarist/rusher presets may prepare and declare one war after turn 40, requiring
economic readiness, trained troops, a visible reachable colony and a substantial
strength advantage. Any existing treaty blocks a declaration. Easy never starts
a war. Council candidates back themselves, otherwise abstaining.

Acceptance covers three distinct seeds, six races and average/pre-warp/advanced
starts with two identical 110-turn runs per scenario, full replay validation and
quality gates. A real-protocol expedition fixture saves after departure orders,
reloads the completed plan without duplicate movement, fights and captures a
colony. Unit scenarios cover rallying, defense commitments, research paths,
command-point reservations, war restraints, council votes and private enemy-data
invariance. See ORION_VERIFICATION.md for executed results.

## Phase 2: fleet modernization (strategist-v3)

New campaigns select `strategist-v3`; v1 and v2 remain unchanged compatibility
policies. `admiral.ts` composes the existing research, economy and operations
planners with design and maintenance decisions. It logs ordinary `save_design`,
`obsolete_design` and `set_build_queue` commands, using the existing refit item
syntax. There is no new engine command, state field or save migration.

`naval-observation.ts` is a trusted observation helper. It derives two bounded
design roles from own researched hulls/components: a small beam-focused escort
and a larger mixed-weapon assault hull. Selected researched defensive specials
fit through the real designer; pre-warp empires receive no unresearched weapons.
Own-fit power is a deterministic heuristic for design/refit comparisons, not
enemy intelligence or a combat-win forecast. Foreign internals remain excluded.

`modernization.ts` refreshes only its named managed designs. It respects the
twelve-design limit, never evicts unrelated designs and leaves any design used
by a build/refit queue active until that work finishes. Commissioning prefers
the strongest own fit per hull while retaining all queued CP accounting.
Refits need a legal local yard, idle/passive production, adequate treasury,
at least a 25% estimated improvement, at most six turns and at most 60% of the
new ship's cost. At most one-third of the navy (minimum one ship) can refit at
once. Easy, recovery and visible-defense emergencies defer new refits.

Accepted refit queues are the durable maintenance reservation: operational
planning and new-war readiness omit those ships. The AI cannot move a ship away
while its yard spends production. There is no runtime-only reservation to lose
on reload. Both newly planned refits and existing queues reserve their yard/ship;
multiple legal yards in a system are considered. Repairs/upgrades occur only
when the normal production pipeline completes the refit.

`src/headless/orion-match.ts` runs active policy matches through real hosted
sessions. Seat zero is an automated human driver issuing filtered-observation
orders before committing; other seats use production controllers. Evaluation
reads full state only for metrics/replay. The CLI `npm run benchmark:orion`
plays six 150-turn comparisons against v2, across three seeds/start modes/races
with swapped seats, and writes JSON plus a Markdown report. It records actual
refit-completion events, idle production and food lack, and validates full replay.
Turn-cap outcomes are explicitly unfinished games, not victories. The initial
run includes paid refits but no wars/winners and exposes shared advanced-start
food shortages; no superiority claim follows from it.

Remaining Phase 2 work includes larger tournaments, calibrated uncertainty,
routing old ships to remote yards, more design roles, multiple coordinated
fronts and Antaran victory planning. Conquest and council participation are
implemented; this is not a claim of competitive AI strength.

## Next design steps

Phase 3: versioned aggression, ambition, honor, greed, paranoia, openness,
xenophobia and risk preferences; strategic goals and event-based relationships
(trust/respect/fear, disputes, treaties, wars and broken promises). Derive memory
from visible events and persist any non-derived state with absent defaults.

Phase 4: a separate DiplomaticObservation and provider request/result interface.
Requests include private empire knowledge, persona, relevant memory/conversation
and legal proposal schema. Outputs are untrusted proposals validated by the
engine. Providers never access state mutation. Accepted commands and conversation
records must be saved so replay needs no provider. Support local Ollama and a
secure bridge for hosted OpenAI-compatible services, with spending/token caps,
timeouts, bounded retries and a scripted fallback. Do not put hosted API keys in
client JavaScript. No provider implementation is included in Phase 1.
