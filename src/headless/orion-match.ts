import { canonicalStringify } from '@engine/canonical';
import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION, racePresetById } from '@engine/data/index';
import { colonyOutput } from '@engine/economy';
import { empireSummary } from '@engine/selectors';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import { observeEmpire } from '@ai/observation';
import { policyFor } from '@ai/policies';
import { attachAiSeats } from '@ai/seats';
import type { AiPersonality, AiCommand, StrategicPolicy } from '@ai/types';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame } from '@protocol/setup';
import { DEFAULT_SETTINGS, type GameSettings, type LogCommand } from '@protocol/messages';
import type { EngineAdapter } from '@protocol/engineAdapter';

export interface MatchSeat { strategy: StrategicPolicy['id']; race: string; personality: AiPersonality }
export interface MatchOptions { seed: string; turns: number; seats: MatchSeat[]; settings?: Partial<GameSettings> }
export interface SeatMetrics {
  id: number; colonies: number; population: number; technologies: number; researchPerTurn: number;
  warships: number; treasury: number; eliminated: boolean; starvation: number;
  idleProduction: number; researchProduced: number; designsSaved: number; shipsRefitted: number;
  warsDeclared: number; coloniesCaptured: number;
}
const adapter = () => createGameEngine() as unknown as EngineAdapter<GameState>;
const key = (c: AiCommand) => `${c.kind}:${canonicalStringify(c.payload)}`;
const settle = async () => { for (let i = 0; i < 160; i++) await new Promise<void>((resolve) => queueMicrotask(resolve)); };

/** Every seat plays a real policy through HostCore/GameSession. Seat zero is
 * the automated human driver: it submits filtered-observation orders before
 * committing, exactly as a human would. Other seats use production controllers.
 * Full state is used only for scoring and replay verification. */
export async function runStrategicMatch(options: MatchOptions) {
  if (!Number.isSafeInteger(options.turns) || options.turns < 1 || options.turns > 1000) throw new Error('turns must be 1..1000');
  if (options.seats.length < 2 || options.seats.length > 8) throw new Error('matches need 2..8 seats');
  if (!/^[0-9a-f]{32}$/.test(options.seed)) throw new Error('seed must be 32 lowercase hex digits');
  for (const seat of options.seats) if (!racePresetById.has(seat.race)) throw new Error(`unknown benchmark race ${seat.race}`);
  const config: SinglePlayerConfig = { version: 1, humanSeat: 0, difficulty: 'normal', opponents: options.seats.slice(1).map((s, i) => ({
    seat: i + 1, name: `AI ${i + 1}`, strategy: s.strategy, personality: s.personality, raceJson: JSON.stringify({ presetId: s.race }),
  })) };
  const hub = new MemoryHub(options.seats.length);
  const transport = hub.join();
  const hosted = createHostedGame({ transport, engine: adapter(), hostEngine: adapter(), store: null,
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', ...options.settings,
      playerCount: options.seats.length, singlePlayer: config, debugCommands: false, fastStart: false },
    identity: { name: 'AI 0', engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, roomCode: 'BENCHMARK', lobbyServer: 'local' },
  });
  const bots = attachAiSeats(hosted.host, config);
  const policy = policyFor(options.seats[0]!.strategy);
  const context = { difficulty: config.difficulty, personality: options.seats[0]!.personality };
  const driver = { rejected: 0, bounded: 0 };
  try {
    hosted.session.setRaceConfig(JSON.stringify({ presetId: options.seats[0]!.race }), true);
    await settle(); hosted.host.startGame(options.seed); await settle();
    let state = hosted.session.getState();
    if (!state) throw new Error('match failed to start');
    const metrics: SeatMetrics[] = state.empires.map((e) => ({ id: e.id, colonies: 0, population: 0, technologies: 0,
      researchPerTurn: 0, warships: 0, treasury: 0, eliminated: false, starvation: 0, idleProduction: 0,
      researchProduced: 0, designsSaved: 0, shipsRefitted: 0, warsDeclared: 0, coloniesCaptured: 0 }));
    const openingTech = state.empires.map((e) => e.knownApps.length);
    const hashes: string[] = [];
    const submit = async (c: AiCommand) => {
      const result = hosted.session.submit(c.kind, c.payload);
      if (result.error) driver.rejected++;
      await settle();
    };
    for (let turn = 0; turn < options.turns && state.winner === null; turn++) {
      const before = state.turn;
      const priorOwners = new Map(state.colonies.map((c) => [c.id, c.owner]));
      const attempted = new Set<string>();
      const limit = Math.min(512, 32 + state.colonies.filter((c) => c.owner === 0).length * 8 + state.ships.filter((s) => s.owner === 0).length * 3);
      for (let order = 0; order < limit; order++) {
        const o = observeEmpire(hosted.session.getState()!, 0);
        if (o.self.eliminated) break;
        const command = policy.plan(o, context).find((c) => !attempted.has(key(c)));
        if (!command) break;
        attempted.add(key(command)); await submit(command);
        if (order === limit - 1) driver.bounded++;
      }
      // Capture the planning boundary for every seat, before advance_turn.
      // Bots run after seat zero commits, so collect their idle/research values
      // in the host session event when their completion marker is accepted.
      const sample = (s: GameState, id: number) => {
        for (const c of s.colonies.filter((c) => c.owner === id && !c.outpost)) {
          const output = colonyOutput(s, c);
          if (!c.queue.length) metrics[id]!.idleProduction += Math.max(0, output.prod);
          metrics[id]!.researchProduced += output.research;
        }
      };
      sample(hosted.session.getState()!, 0);
      const sampled = new Set<number>();
      const stop = hosted.session.subscribe(() => {
        const s = hosted.session.getState()!;
        if (s.turn !== before) return;
        for (const e of s.empires) if (e.id !== 0 && !sampled.has(e.id) && e.aiTurnCompleted === before) {
          sample(s, e.id); sampled.add(e.id);
        }
      });
      hosted.session.commitTurn();
      try {
        let advanced = false;
        for (let wait = 0; wait < 32; wait++) {
          await settle(); state = hosted.session.getState()!;
          if (state.phase === 'planning' && (state.turn > before || state.winner !== null)) { advanced = true; break; }
          for (const b of observeEmpire(state, 0).battles.filter((b) => !b.ordered)) {
            await submit({ kind: 'battle_orders', payload: { battleId: b.id, orders: policy.battleOrders(observeEmpire(hosted.session.getState()!, 0), context, b.id) } });
          }
        }
        if (!advanced) throw new Error(`match stalled at turn ${before}`);
      } finally { stop(); }
      for (const c of state.colonies) {
        metrics[c.owner]!.starvation += c.foodLackPrev;
        if (priorOwners.has(c.id) && priorOwners.get(c.id) !== c.owner) metrics[c.owner]!.coloniesCaptured++;
      }
      hashes.push(adapter().hash(state));
    }
    const log = [...hosted.host.getLog()];
    for (const m of metrics) {
      const e = state.empires.find((e) => e.id === m.id)!;
      const colonies = state.colonies.filter((c) => c.owner === m.id && !c.outpost);
      Object.assign(m, { colonies: colonies.length, population: colonies.reduce((n, c) => n + c.groups.reduce((sum, g) => sum + g.popK, 0), 0),
        technologies: e.knownApps.length - openingTech[m.id]!, researchPerTurn: empireSummary(state, m.id).researchPerTurn,
        warships: state.ships.filter((s) => s.owner === m.id && s.shipKind === 'design').length, treasury: e.bc, eliminated: e.eliminated,
        designsSaved: log.filter((c) => c.playerId === m.id && c.kind === 'save_design').length,
        warsDeclared: log.filter((c) => c.playerId === m.id && c.kind === 'declare_war').length });
    }
    // Count successful refits, rather than merely queued intentions, using
    // normal engine events from an independent full replay.
    const replay = adapter();
    let folded: GameState | null = null;
    for (const command of log) {
      if (command.kind === 'game_start') folded = replay.init(command.payload as never);
      else {
        if (command.playerId >= 0 && replay.validate(folded!, command) !== null) throw new Error(`invalid replay command ${command.seq}`);
        folded = replay.apply(folded!, command);
      }
      for (const event of replay.takeEvents?.() ?? []) {
        if (event.kind === 'ship_refitted' && metrics[event.visibleTo]) metrics[event.visibleTo]!.shipsRefitted++;
      }
    }
    const finalHash = adapter().hash(state);
    if (replay.hash(folded!) !== finalHash) throw new Error('match replay hash mismatch');
    return { options, finalTurn: state.turn, winner: state.winner, winType: state.winType, metrics, hashes, finalHash,
      commands: log.length, diagnostics: [driver, ...bots.map((b) => ({ rejected: b.diagnostics.rejected, bounded: b.diagnostics.bounded }))] };
  } finally { bots.forEach((b) => b.close()); hosted.host.close(); transport.close(); }
}
