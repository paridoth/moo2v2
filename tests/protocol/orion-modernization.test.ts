import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame } from '@protocol/setup';
import { gameIdFromSeed } from '@protocol/session';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type LogCommand } from '@protocol/messages';
import type { EngineAdapter, GameStartPayload } from '@protocol/engineAdapter';
import { attachAiSeats } from '@ai/seats';
import { MemoryGameStore } from '@storage/memory';
import { openNodeStore } from '@storage/node';
import { decodeSaveFile, encodeSaveFile, verifySaveEnvelope } from '@storage/savefile';
import { rebaseSave } from '@storage/rebase';
import { runStrategicMatch } from '../../src/headless/orion-match';

const SEED = '0123456789abcdef0123456789abcdef';
const adapter = () => createGameEngine() as unknown as EngineAdapter<GameState>;
const config: SinglePlayerConfig = { version: 1, humanSeat: 0, difficulty: 'normal', opponents: [1, 2].map((seat) => ({
  seat, name: `AI ${seat}`, strategy: seat === 1 ? 'strategist-v3' : 'strategist-v2', personality: 'balanced',
  raceJson: JSON.stringify({ presetId: 'solari' }),
})) };
const settle = async () => { for (let i = 0; i < 600; i++) await new Promise<void>((resolve) => queueMicrotask(resolve)); };
function fixture() {
  const state = createGameEngine().init({ seed: SEED,
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', playerCount: 3, singlePlayer: config },
    players: [0, 1, 2].map((id) => ({ id, name: id ? `AI ${id}` : 'Human', raceJson: JSON.stringify({ presetId: 'solari' }) })), dataVersion: DATA_VERSION });
  const empire = state.empires.find((e) => e.id === 1)!;
  empire.bc = 500;
  const colony = state.colonies.find((c) => c.owner === 1)!;
  const starId = state.planets.find((p) => p.id === colony.planetId)!.starId;
  state.ships.push({ id: 99000, owner: 1, shipKind: 'design', designId: empire.designs.find((d) => d.hull === 'frigate')!.id,
    location: { kind: 'star', starId }, cargoPopUnits: 0, cargoRace: 1, dmgArmor: 2, dmgStructure: 1 });
  return state;
}
function startLog(state: GameState): LogCommand[] {
  return [{ seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: { seed: SEED, settings: state.settings,
    players: state.empires.map((e) => ({ id: e.id, name: e.name, raceJson: null })), dataVersion: DATA_VERSION,
    resumeState: adapter().serialize(state) } }];
}
async function game(log: LogCommand[], store: MemoryGameStore | Awaited<ReturnType<typeof openNodeStore>> = new MemoryGameStore()) {
  const start = log[0]!.payload as GameStartPayload;
  const gameId = gameIdFromSeed(start.seed);
  if (!await store.getGame(gameId)) {
    await store.createGame({ gameId, seed: start.seed, settings: start.settings,
      engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, protocolVersion: PROTOCOL_VERSION,
      localPlayerId: 0, roomCode: 'MODERN', lobbyServer: 'local' }, start.players);
    await store.appendCommands(gameId, log);
  }
  const hub = new MemoryHub(3);
  const transport = hub.join();
  const hosted = createHostedGame({ transport, engine: adapter(), hostEngine: adapter(), store,
    settings: start.settings, identity: { name: 'Human', engineVersion: ENGINE_VERSION,
      dataVersion: DATA_VERSION, roomCode: 'MODERN', lobbyServer: 'local' }, resume: { gameId, log } });
  const bots = attachAiSeats(hosted.host, config);
  await settle();
  return { ...hosted, store, bots, close() { bots.forEach((b) => b.close()); hosted.host.close(); transport.close(); } };
}
async function endTurn(g: Awaited<ReturnType<typeof game>>) {
  const before = g.session.getState()!.turn;
  g.session.commitTurn();
  for (let i = 0; i < 20; i++) {
    await settle();
    await g.session.flush();
    if (g.session.getState()!.turn > before) return;
  }
  throw new Error(`modernization turn ${before} stalled`);
}

describe('Orion fleet modernization through the protocol', () => {
  it('resumes a partially queued paid refit, completes it once, and preserves mixed policy ids in save branches', async () => {
    const state = fixture();
    const oldDesign = state.ships.find((s) => s.id === 99000)!.designId;
    const g = await game(startLog(state));
    g.bots[1]!.close();
    const stop = g.session.subscribe(() => {
      if (g.host.getLog().some((c) => c.playerId === 1 && c.kind === 'set_build_queue'
        && (c.payload as { items: string[] }).items.some((i) => i.startsWith('refit:99000:')))) g.bots[0]!.close();
    });
    g.session.commitTurn(); await settle(); stop();
    const partial = [...g.host.getLog()];
    expect(partial.filter((c) => c.playerId === 1 && c.kind === 'save_design')).toHaveLength(2);
    expect(partial.some((c) => c.playerId === 1 && c.kind === 'ai_turn_complete')).toBe(false);
    expect(g.session.getState()!.colonies.some((c) => c.queue.some((i) => i.item.startsWith('refit:99000:')))).toBe(true);
    expect(g.session.getState()!.ships.find((s) => s.id === 99000)!.designId).toBe(oldDesign);
    await g.session.snapshotNow();
    const envelope = await decodeSaveFile(await encodeSaveFile(await g.store.exportGame(g.session.gameId!)));
    expect(verifySaveEnvelope(envelope).finalHash).toBe(adapter().hash(g.session.getState()!));
    g.close();
    const branch = rebaseSave(envelope, 'snapshot', undefined, '11111111111111111111111111111111');
    expect(JSON.parse(branch.envelope.snapshot!.stateJson).settings.singlePlayer).toEqual(config);
    const branchStore = await openNodeStore(); await branchStore.importGame(branch.envelope);
    const resumed = await game(branch.envelope.commands.map((c) => ({ ...c, payload: JSON.parse(c.payload) })), branchStore);
    try {
      for (let t = 0; t < 8 && resumed.session.getState()!.ships.find((s) => s.id === 99000)!.designId === oldDesign; t++) await endTurn(resumed);
      const ship = resumed.session.getState()!.ships.find((s) => s.id === 99000)!;
      expect(ship.designId).not.toBe(oldDesign);
      expect(ship.dmgArmor).toBe(0); expect(ship.dmgStructure).toBe(0);
      expect(resumed.bots.every((b) => b.diagnostics.rejected === 0 && b.diagnostics.bounded === 0)).toBe(true);
      const log = resumed.host.getLog();
      expect(log.some((c) => c.playerId === 1 && c.kind === 'save_design')).toBe(false); // designs survived snapshot
      expect(log.some((c) => c.kind === 'set_build_queue' && (c.payload as { items: string[] }).items.some((i) => i.startsWith('refit:99000:')))).toBe(false);
      await resumed.session.snapshotNow();
      expect(verifySaveEnvelope(await resumed.store.exportGame(resumed.session.gameId!)).finalHash).toBe(adapter().hash(resumed.session.getState()!));
    } finally { resumed.close(); await resumed.session.flush(); await branchStore.destroy(); }
  });

  it('runs active mixed-policy matches with repeatable hash trails and measured development', async () => {
    const options = { seed: SEED, turns: 110, seats: [
      { strategy: 'strategist-v3' as const, race: 'solari', personality: 'militarist' as const },
      { strategy: 'strategist-v2' as const, race: 'solari', personality: 'militarist' as const },
    ] };
    const a = await runStrategicMatch(options);
    const b = await runStrategicMatch(options);
    expect(a).toEqual(b);
    expect(a.finalTurn).toBe(111);
    expect(a.metrics.every((m) => !m.eliminated && m.colonies > 1 && m.technologies > 0 && m.idleProduction === 0 && m.starvation === 0)).toBe(true);
    expect(a.metrics[0]!.designsSaved).toBeGreaterThan(0);
    expect(a.metrics[1]!.designsSaved).toBe(0);
    expect(a.diagnostics.every((d) => d.rejected === 0 && d.bounded === 0)).toBe(true);
  }, 120_000);
});
