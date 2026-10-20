import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '@engine/canonical';
import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import type { EngineAdapter, GameStartPayload } from '@protocol/engineAdapter';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, type GameSettings, type LogCommand } from '@protocol/messages';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, generateSeed } from '@protocol/setup';
import { gameIdFromSeed } from '@protocol/session';
import type { StrategicPolicy } from '@ai/types';
import { expanderStrategy } from '@ai/strategy';
import { attachAiSeats } from '@ai/seats';
import { MemoryGameStore } from '@storage/memory';
import { openNodeStore } from '@storage/node';
import { decodeSaveFile, encodeSaveFile, verifySaveEnvelope } from '@storage/savefile';
import { rebaseSave } from '@storage/rebase';
import { empireSummary } from '@engine/selectors';

const SEED = '0123456789abcdef0123456789abcdef';
const config: SinglePlayerConfig = {
  version: 1, humanSeat: 0, difficulty: 'normal', opponents: [1, 2].map((seat) => ({
    seat, name: `Orion AI ${seat}`, strategy: 'expander-v1', personality: seat === 1 ? 'balanced' : 'expander',
    raceJson: JSON.stringify({ presetId: 'solari' }),
  })),
};
const adapter = () => createGameEngine() as unknown as EngineAdapter<GameState>;

async function game(log?: LogCommand[], store = new MemoryGameStore(), policy?: StrategicPolicy, options: Partial<GameSettings> = {}, seed = SEED) {
  const hub = new MemoryHub(3);
  const start = log?.find((c) => c.kind === 'game_start')?.payload as GameStartPayload | undefined;
  const aiConfig = start?.settings.singlePlayer ?? options.singlePlayer ?? config;
  seed = start?.seed ?? seed;
  if (log && start && !await store.getGame(gameIdFromSeed(seed))) {
    await store.createGame({ gameId: gameIdFromSeed(seed), seed, settings: start.settings,
      engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, protocolVersion: PROTOCOL_VERSION,
      localPlayerId: 0, roomCode: 'ORION', lobbyServer: 'local' }, start.players);
    await store.appendCommands(gameIdFromSeed(seed), log);
  }
  const hosted = createHostedGame({ transport: hub.join(), engine: adapter(), hostEngine: adapter(), store,
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', playerCount: 3, singlePlayer: aiConfig, ...options },
    identity: { name: 'Human', engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, roomCode: 'ORION', lobbyServer: 'local' },
    ...(log ? { resume: { gameId: gameIdFromSeed(seed), log } } : {}),
  });
  const bots = attachAiSeats(hosted.host, aiConfig, policy);
  await settle();
  if (!log) {
    hosted.session.setRaceConfig(JSON.stringify({ presetId: 'solari' }), true);
    await settle();
    hosted.host.startGame(seed);
    await settle();
  }
  return { ...hosted, hub, bots, store, close() { bots.forEach((b) => b.close()); hosted.host.close(); } };
}

async function settle() {
  // No timers in the controller; bounded microtask cascades plus persistence.
  for (let i = 0; i < 600; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
}
async function endTurn(g: Awaited<ReturnType<typeof game>>) {
  const before = g.session.getState()!.turn;
  g.session.commitTurn();
  for (let tries = 0; tries < 20; tries++) {
    await settle();
    const s = g.session.getState()!;
    if (s.phase === 'planning' && s.turn > before) return;
    for (const b of s.pendingBattles) {
      if ((b.attacker === 0 && !b.ordersA) || (b.defender === 0 && !b.ordersD)) {
        g.session.submit('battle_orders', { battleId: b.id, orders: { stance: 'hold_range', priority: 'nearest', retreatThresholdPct: 25, bombard: false } });
      }
    }
  }
  throw new Error(`turn ${before} stalled: ${JSON.stringify(g.bots.map((b) => b.diagnostics))}`);
}
function replay(log: readonly LogCommand[]) {
  const e = adapter();
  let state: GameState | null = null;
  for (const c of log) {
    if (c.kind === 'game_start') state = e.init(c.payload as never);
    else {
      if (c.playerId >= 0) expect(e.validate(state!, c)).toBeNull();
      state = e.apply(state!, c);
    }
  }
  return state!;
}

describe('Orion local AI seats', () => {
  it('creates one human and two AI empires; waits for the human, completes turns with valid orders and bounded work', async () => {
    const g = await game();
    try {
      expect(g.session.getRoster().map((p) => p.id)).toEqual([0, 1, 2]);
      expect(g.session.getState()!.empires).toHaveLength(3);
      expect(g.session.submit('ai_turn_complete', {}).error).toBe('not an AI seat');
      expect(g.host.getLog()).toHaveLength(1); // no AI planning before human end turn
      for (let i = 0; i < 4; i++) await endTurn(g);
      expect(g.session.getState()!.turn).toBe(5);
      const log = [...g.host.getLog()];
      expect(log.filter((c) => c.kind === 'ai_turn_complete')).toHaveLength(8);
      expect(log.some((c) => c.kind.startsWith('debug_'))).toBe(false);
      expect(g.bots.every((b) => b.diagnostics.rejected === 0 && b.diagnostics.bounded === 0)).toBe(true);
      expect(adapter().hash(replay(log))).toBe(adapter().hash(g.session.getState()!));
      const count = log.length;
      await settle();
      expect(g.host.getLog()).toHaveLength(count);
    } finally { g.close(); }
  });

  it('round-trips a verified save, restores ownership/difficulty and resumes all seats; snapshot branches retain AI', async () => {
    const g = await game();
    await endTurn(g);
    await g.session.snapshotNow();
    const envelope = await decodeSaveFile(await encodeSaveFile(await g.store.exportGame(g.session.gameId!)));
    const verified = verifySaveEnvelope(envelope);
    const log = [...g.host.getLog()];
    const hash = adapter().hash(g.session.getState()!);
    g.close();
    expect(verified.finalHash).toBe(hash);
    const restored = await openNodeStore();
    await restored.importGame(envelope);
    const rows = await restored.readCommands(envelope.game.game_id);
    await restored.destroy();
    const resumed = await game(rows);
    try {
      expect(adapter().hash(resumed.session.getState()!)).toBe(hash);
      expect(resumed.session.getState()!.settings.singlePlayer).toEqual(config);
      await endTurn(resumed);
      expect(resumed.session.getState()!.turn).toBe(3);
    } finally { resumed.close(); }
    const branch = rebaseSave(envelope, 'snapshot', undefined, generateSeed());
    expect(JSON.parse(branch.envelope.snapshot!.stateJson).settings.singlePlayer).toEqual(config);
    const branchLog = branch.envelope.commands.map((c) => ({ ...c, payload: JSON.parse(c.payload) }));
    const fork = await game(branchLog);
    try { await endTurn(fork); expect(fork.session.getState()!.turn).toBe(3); } finally { fork.close(); }
    expect(log.filter((c) => c.kind === 'ai_turn_complete')).toHaveLength(2);
  });

  it.each(['expander-v1', 'strategist-v2', 'strategist-v3'] as const)('restarting completed %s planning does not duplicate orders', async (strategy) => {
    const g = await game(undefined, undefined, undefined, { singlePlayer: { ...config,
      opponents: config.opponents.map((p) => ({ ...p, strategy })),
    } });
    // One AI completes a plan while the second is disconnected. The host log
    // retains its marker even though commit packets are ephemeral.
    g.bots[1]!.close();
    g.session.commitTurn();
    await settle();
    const log = [...g.host.getLog()];
    const before = log.filter((c) => c.playerId === 1);
    expect(before.some((c) => c.kind === 'ai_turn_complete')).toBe(true);
    g.close();
    const resumed = await game(log);
    try {
      await endTurn(resumed);
      expect(resumed.host.getLog().filter((c) => c.playerId === 1 && c.turn === 1)).toEqual(before);
    } finally { resumed.close(); }
  });

  it('resumes a partially submitted plan without repeating accepted intents', async () => {
    const g = await game();
    const unsub = g.session.subscribe((ev) => {
      if (ev.type === 'state' && g.host.getLog().some((c) => c.playerId === 1 && c.kind === 'set_jobs')) {
        g.bots.forEach((b) => b.close());
      }
    });
    g.session.commitTurn();
    await settle();
    const log = [...g.host.getLog()];
    expect(log.some((c) => c.playerId === 1 && c.kind === 'set_jobs')).toBe(true);
    expect(log.some((c) => c.playerId === 1 && c.kind === 'ai_turn_complete')).toBe(false);
    unsub();
    g.close();
    const resumed = await game(log);
    try {
      await endTurn(resumed);
      const orders = resumed.host.getLog().filter((c) => c.playerId > 0 && c.turn === 1);
      const keys = orders.map((c) => `${c.playerId}:${c.kind}:${canonicalStringify(c.payload)}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(resumed.session.getState()!.turn).toBe(2);
    } finally { resumed.close(); }
  });

  it.each([
    { startMode: 'pre_warp' as const },
    { startMode: 'advanced' as const },
    { fastStart: true },
    { singlePlayer: { ...config, difficulty: 'easy' as const } },
  ])('supports existing setup variation %j without rejected orders or stalls', async (options) => {
    const g = await game(undefined, undefined, undefined, options);
    try {
      for (let t = 0; t < 12; t++) await endTurn(g);
      expect(g.session.getState()!.turn).toBe(13);
      expect(g.bots.every((b) => b.diagnostics.rejected === 0 && b.diagnostics.bounded === 0)).toBe(true);
      expect(adapter().hash(replay(g.host.getLog()))).toBe(adapter().hash(g.session.getState()!));
    } finally { g.close(); }
  });

  it('skips a rejected intent and closes cleanly without submitting again', async () => {
    const policy: StrategicPolicy = { ...expanderStrategy, plan: (o, ctx) => [
      { kind: 'set_jobs', payload: { colonyId: -999, groups: [] } }, ...expanderStrategy.plan(o, ctx),
    ] };
    const g = await game(undefined, undefined, policy);
    await endTurn(g);
    expect(g.bots.every((b) => b.diagnostics.rejected === 1)).toBe(true);
    g.close();
    const count = g.host.getLog().length;
    g.session.commitTurn();
    await settle();
    expect(g.host.getLog()).toHaveLength(count);
  });

  it('automatically orders AI battles while preserving the human battle decision, including mid-battle reload', async () => {
    const original = await game();
    const fixture = structuredClone(original.session.getState()!);
    original.close();
    const starId = fixture.stars[0]!.id;
    fixture.ships = [0, 1].map((owner) => ({ id: 9000 + owner, owner, shipKind: 'design',
      designId: fixture.empires.find((e) => e.id === owner)!.designs[0]!.id,
      location: { kind: 'star', starId }, cargoPopUnits: 0, cargoRace: owner, dmgStructure: 0, dmgArmor: 0,
    }));
    fixture.phase = 'battle_orders';
    fixture.pendingBattles = [{ id: 'orion-battle', starId, attacker: 0, defender: 1, ordersA: null, ordersD: null }];
    const log: LogCommand[] = [{ seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: {
      seed: SEED, settings: fixture.settings, players: fixture.empires.map((e) => ({ id: e.id, name: e.name, raceJson: null })),
      dataVersion: DATA_VERSION, resumeState: adapter().serialize(fixture),
    } }];
    const battle = await game(log);
    expect(battle.session.getState()!.phase).toBe('battle_orders');
    expect(battle.session.getState()!.pendingBattles[0]!.ordersD).not.toBeNull();
    expect(battle.session.getState()!.pendingBattles[0]!.ordersA).toBeNull();
    const pausedLog = [...battle.host.getLog()];
    battle.close();
    const resumed = await game(pausedLog);
    try {
      expect(resumed.host.getLog().filter((c) => c.kind === 'battle_orders')).toHaveLength(1);
      resumed.session.submit('battle_orders', { battleId: 'orion-battle', orders: {
        stance: 'hold_range', priority: 'nearest', retreatThresholdPct: 25, bombard: false,
      } });
      await settle();
      expect(resumed.session.getState()!.phase).toBe('planning');
      expect(resumed.session.getState()!.turn).toBe(2);
      expect(resumed.host.getLog().filter((c) => c.kind === 'resolve_combat')).toHaveLength(1);
      expect(adapter().hash(replay(resumed.host.getLog()))).toBe(adapter().hash(resumed.session.getState()!));
    } finally { resumed.close(); }
  });

  it('runs 100 turns with multiple strategic opponents, develops economies and reproduces hashes', async () => {
    const trails: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const g = await game();
      const trail: string[] = [];
      const openingResearch = new Map(g.session.getState()!.empires.map((e) => [e.id, e.knownApps.length]));
      try {
        for (let t = 0; t < 100; t++) { await endTurn(g); trail.push(adapter().hash(g.session.getState()!)); }
        const state = g.session.getState()!;
        expect(state.turn).toBe(101);
        for (const id of [1, 2]) {
          expect(state.colonies.filter((c) => c.owner === id && !c.outpost).length).toBeGreaterThan(1);
          expect(state.empires.find((e) => e.id === id)!.knownApps.length).toBeGreaterThan(openingResearch.get(id)!);
          expect(state.colonies.some((c) => c.owner === id && c.buildings.includes('automated_factory'))).toBe(true);
          expect(state.ships.some((s) => s.owner === id && s.shipKind === 'design')).toBe(true);
          expect(state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.foodLackPrev, 0)).toBe(0);
        }
        expect(g.bots.every((b) => b.diagnostics.rejected === 0 && b.diagnostics.bounded === 0)).toBe(true);
        expect(adapter().hash(replay(g.host.getLog()))).toBe(adapter().hash(state));
        trails.push(trail);
      } finally { g.close(); }
    }
    expect(trails[0]).toEqual(trails[1]);
  }, 120_000);
});

const strategicConfig: SinglePlayerConfig = { ...config,
  opponents: config.opponents.map((p) => ({ ...p, strategy: 'strategist-v2' as const })),
};

describe('Orion advanced strategy campaigns', () => {
  it.each([
    { seed: SEED, startMode: 'average' as const, races: ['solari', 'hivex'] },
    { seed: 'fedcba9876543210fedcba9876543210', startMode: 'pre_warp' as const, races: ['lithor', 'ferron'] },
    { seed: 'abcdef0123456789abcdef0123456789', startMode: 'advanced' as const, races: ['cerebri', 'urgok'] },
  ])('reproduces 100+ turns and quality metrics: $startMode $races', async ({ seed, startMode, races }) => {
    const aiConfig: SinglePlayerConfig = { ...strategicConfig, opponents: strategicConfig.opponents.map((p, i) => ({
      ...p, raceJson: JSON.stringify({ presetId: races[i] }), personality: i === 0 ? 'techer' : 'militarist',
    })) };
    const trails: string[][] = [];
    const metrics: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const g = await game(undefined, undefined, undefined, { startMode, singlePlayer: aiConfig }, seed);
      const opening = g.session.getState()!.empires.map((e) => e.knownApps.length);
      const trail: string[] = [];
      const starvation = [0, 0, 0];
      try {
        for (let t = 0; t < 110 && g.session.getState()!.winner === null; t++) {
          await endTurn(g);
          const state = g.session.getState()!;
          for (const id of [1, 2]) starvation[id]! += state.colonies.filter((c) => c.owner === id).reduce((n, c) => n + c.foodLackPrev, 0);
          trail.push(adapter().hash(state));
        }
        const s = g.session.getState()!;
        const results = [1, 2].map((id) => {
          const e = s.empires.find((e) => e.id === id)!;
          const colonies = s.colonies.filter((c) => c.owner === id && !c.outpost);
          return { id, colonies: colonies.length, technologies: e.knownApps.length - opening[id]!,
            research: empireSummary(s, id).researchPerTurn, starvation: starvation[id], eliminated: e.eliminated,
            factories: colonies.filter((c) => c.buildings.includes('automated_factory')).length,
            factoryKnown: e.knownApps.includes('automated_factory'),
            military: s.ships.filter((f) => f.owner === id && f.shipKind === 'design').length };
        });
        for (const result of results) {
          expect(result.eliminated).toBe(false);
          expect(result.colonies).toBeGreaterThan(1);
          expect(result.technologies).toBeGreaterThan(0);
          if (result.factoryKnown) expect(result.factories).toBeGreaterThan(0);
          expect(result.military).toBeGreaterThan(0);
          expect(result.research).toBeGreaterThan(0);
          expect(result.starvation).toBe(0);
        }
        expect(g.bots.map((b) => [b.diagnostics.rejected, b.diagnostics.bounded])).toEqual([[0, 0], [0, 0]]);
        expect(g.host.getLog().some((c) => c.kind.startsWith('debug_'))).toBe(false);
        expect(adapter().hash(replay(g.host.getLog()))).toBe(adapter().hash(s));
        trails.push(trail); metrics.push(results);
      } finally { g.close(); }
    }
    expect(trails[0]).toEqual(trails[1]);
    expect(metrics[0]).toEqual(metrics[1]);
    console.info(`Strategist ${startMode} ${seed}: ${JSON.stringify(metrics[0])}`);
  }, 120_000);

  it('resumes a partial v2 plan, verifies a binary save and continues a snapshot branch with its saved policy', async () => {
    const options = { singlePlayer: strategicConfig };
    const g = await game(undefined, undefined, undefined, options);
    const unsub = g.session.subscribe((ev) => {
      if (ev.type === 'state' && g.host.getLog().some((c) => c.playerId === 1 && c.kind === 'set_jobs')) g.bots.forEach((b) => b.close());
    });
    g.session.commitTurn(); await settle();
    const partial = [...g.host.getLog()]; unsub(); g.close();
    expect(partial.some((c) => c.playerId === 1 && c.kind === 'set_jobs')).toBe(true);
    expect(partial.some((c) => c.playerId === 1 && c.kind === 'ai_turn_complete')).toBe(false);
    const resumed = await game(partial, g.store, undefined, options);
    await endTurn(resumed);
    const commands = resumed.host.getLog().filter((c) => c.playerId > 0 && c.turn === 1);
    const keys = commands.map((c) => `${c.playerId}:${c.kind}:${canonicalStringify(c.payload)}`);
    expect(new Set(keys).size).toBe(keys.length);
    await resumed.session.snapshotNow();
    const save = await decodeSaveFile(await encodeSaveFile(await resumed.store.exportGame(resumed.session.gameId!)));
    expect(verifySaveEnvelope(save).finalHash).toBe(adapter().hash(resumed.session.getState()!));
    const branch = rebaseSave(save, 'snapshot', undefined, generateSeed()); resumed.close();
    const log = branch.envelope.commands.map((c) => ({ ...c, payload: JSON.parse(c.payload) }));
    const fork = await game(log, undefined, undefined, options);
    try {
      expect(fork.session.getState()!.settings.singlePlayer!.opponents.every((p) => p.strategy === 'strategist-v2')).toBe(true);
      await endTurn(fork);
      expect(fork.session.getState()!.turn).toBe(3);
      expect(adapter().hash(replay(fork.host.getLog()))).toBe(adapter().hash(fork.session.getState()!));
    } finally { fork.close(); }
  });

  it('executes a coordinated marine expedition through real commands, battle orders and capture', async () => {
    const options = { singlePlayer: strategicConfig };
    const original = await game(undefined, undefined, undefined, options);
    const fixture = structuredClone(original.session.getState()!); original.close();
    const colony = fixture.colonies.find((c) => c.owner === 0)!;
    const home = fixture.colonies.find((c) => c.owner === 1)!;
    const origin = fixture.stars.find((s) => s.id === fixture.planets.find((p) => p.id === home.planetId)!.starId)!;
    const dest = fixture.stars.find((s) => s.id === fixture.planets.find((p) => p.id === colony.planetId)!.starId)!;
    dest.x = origin.x + 100; dest.y = origin.y;
    fixture.monsters = [];
    fixture.relations = [{ a: 0, b: 1, status: 'war', peaceOfferedBy: [],
      treaties: { nap: false, alliance: false, trade: false, research: false } }];
    colony.groups = [{ race: 0, popK: 1000, farmers: 1, workers: 0, scientists: 0, unrest: false }];
    colony.buildings = []; colony.marines = 0;
    const e = fixture.empires.find((e) => e.id === 1)!;
    const design = e.designs.find((d) => d.hull === 'destroyer')!;
    fixture.ships = Array.from({ length: 8 }, (_, i) => ({ id: 90000 + i, owner: 1, shipKind: 'design' as const,
      designId: design.id, location: { kind: 'star' as const, starId: origin.id },
      cargoPopUnits: 0, cargoRace: 1, dmgStructure: 0, dmgArmor: 0 }));
    for (let i = 0; i < 3; i++) fixture.ships.push({ id: 91000 + i, owner: 1, shipKind: 'transport', designId: null,
      location: { kind: 'star', starId: origin.id }, cargoPopUnits: 0, cargoRace: 1, dmgStructure: 0, dmgArmor: 0, marines: 4 });
    fixture.ships.push({ id: 92000, owner: 0, shipKind: 'scout', designId: null,
      location: { kind: 'star', starId: dest.id }, cargoPopUnits: 0, cargoRace: 0, dmgStructure: 0, dmgArmor: 0 });
    e.exploredStars.push(dest.id);
    const log: LogCommand[] = [{ seq: 0, turn: 0, playerId: -1, kind: 'game_start', payload: {
      seed: SEED, settings: fixture.settings, players: fixture.empires.map((emp) => ({ id: emp.id, name: emp.name, raceJson: null })),
      dataVersion: DATA_VERSION, resumeState: adapter().serialize(fixture),
    } }];
    const planned = await game(log, undefined, undefined, options);
    planned.bots[1]!.close(); // retain the completed expedition before advance
    planned.session.commitTurn(); await settle();
    expect(planned.session.getState()!.turn).toBe(1);
    expect(planned.host.getLog().some((c) => c.playerId === 1 && c.kind === 'ai_turn_complete')).toBe(true);
    await planned.session.snapshotNow();
    const save = await decodeSaveFile(await encodeSaveFile(await planned.store.exportGame(planned.session.gameId!)));
    expect(verifySaveEnvelope(save).finalHash).toBe(adapter().hash(planned.session.getState()!));
    const savedLog = [...planned.host.getLog()]; planned.close();
    const g = await game(savedLog, undefined, undefined, options);
    try {
      await endTurn(g);
      const expedition = g.host.getLog().find((c) => c.playerId === 1 && c.kind === 'move_ships'
        && (c.payload as { destStarId: number }).destStarId === dest.id);
      expect((expedition?.payload as { shipIds: number[] }).shipIds).toHaveLength(11);
      expect(g.host.getLog().filter((c) => c.playerId === 1 && c.kind === 'move_ships'
        && (c.payload as { destStarId: number }).destStarId === dest.id)).toHaveLength(1);
      expect(g.host.getLog().some((c) => c.playerId === 1 && c.kind === 'battle_orders'
        && (c.payload as { orders: { invade: boolean } }).orders.invade)).toBe(true);
      expect(g.session.getState()!.colonies.find((c) => c.id === colony.id)!.owner).toBe(1);
      expect(g.bots.every((b) => b.diagnostics.rejected === 0)).toBe(true);
      expect(adapter().hash(replay(g.host.getLog()))).toBe(adapter().hash(g.session.getState()!));
    } finally { g.close(); }
  });
});
