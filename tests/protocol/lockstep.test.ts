import { describe, expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { stubEngine, type StubState } from '@protocol/engineAdapter';
import { createHostedGame, joinGame } from '@protocol/setup';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import type { GameSession, SessionEvent } from '@protocol/session';
import { openNodeStore } from '@storage/node';

const SEED = '0123456789abcdef0123456789abcdef';

function identity(name: string) {
  return {
    name,
    engineVersion: '0.1.0',
    dataVersion: 'dv-test',
    roomCode: 'ROOM',
    lobbyServer: 'memory',
  };
}

async function twoPlayerGame(withStores = false) {
  const hub = new MemoryHub(2);
  const t0 = hub.join();
  const t1 = hub.join();
  const store0 = withStores ? await openNodeStore() : null;
  const store1 = withStores ? await openNodeStore() : null;
  const hosted = createHostedGame<StubState>({
    transport: t0,
    engine: stubEngine,
    store: store0,
    settings: { ...DEFAULT_SETTINGS, playerCount: 2 },
    identity: identity('Host'),
  });
  const client = joinGame<StubState>({
    transport: t1,
    engine: stubEngine,
    store: store1,
    identity: identity('Client'),
  });
  await hub.settle();
  return { hub, hosted, client, store0, store1 };
}

function events(session: GameSession<StubState>): SessionEvent[] {
  const out: SessionEvent[] = [];
  session.subscribe((ev) => out.push(ev));
  return out;
}

describe('lobby', () => {
  it('hello/welcome/lobby_update populate rosters on both sides', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    expect(hosted.session.getRoster().map((p) => p.name)).toEqual(['Host', 'Client']);
    expect(client.getRoster().map((p) => p.name)).toEqual(['Host', 'Client']);
    client.setRaceConfig('{"preset":"cerebri"}', true);
    await hub.settle();
    expect(hosted.session.getRoster()[1]!.ready).toBe(true);
    expect(hosted.session.getRoster()[1]!.raceJson).toBe('{"preset":"cerebri"}');
  });

  it('rejects mismatched data versions', async () => {
    const hub = new MemoryHub(2);
    const t0 = hub.join();
    const t1 = hub.join();
    createHostedGame<StubState>({
      transport: t0,
      engine: stubEngine,
      store: null,
      settings: DEFAULT_SETTINGS,
      identity: identity('Host'),
    });
    const bad = joinGame<StubState>({
      transport: t1,
      engine: stubEngine,
      store: null,
      identity: { ...identity('Bad'), dataVersion: 'dv-OTHER' },
    });
    const evs = events(bad);
    await hub.settle();
    expect(evs.some((e) => e.type === 'version-reject')).toBe(true);
    expect(bad.getRoster().length).toBe(0);
  });
});

describe('start + lockstep', () => {
  it('game_start initializes identical state on both peers', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    hosted.host.startGame(SEED);
    await hub.settle();
    expect(hosted.session.isStarted()).toBe(true);
    expect(client.isStarted()).toBe(true);
    expect(stubEngine.hash(hosted.session.getState()!)).toBe(stubEngine.hash(client.getState()!));
    expect(hosted.session.gameId).toBe('g-0123456789abcdef');
    expect(client.gameId).toBe('g-0123456789abcdef');
  });

  it('submit applies optimistically, then authoritatively; both peers converge', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    hosted.host.startGame(SEED);
    await hub.settle();

    const res = client.submit('increment', { n: 5 });
    expect(res.error).toBeUndefined();
    // optimistic: planned reflects it immediately, auth does not yet
    expect(client.getPlanned()!.counters['1']).toBe(5);
    expect(client.getState()!.counters['1']).toBe(0);
    expect(client.getPendingCount()).toBe(1);

    await hub.settle();
    expect(client.getState()!.counters['1']).toBe(5);
    expect(client.getPendingCount()).toBe(0);
    expect(hosted.session.getState()!.counters['1']).toBe(5);

    hosted.session.submit('increment', { n: 2 });
    await hub.settle();
    expect(client.getState()!.counters['0']).toBe(2);
    expect(stubEngine.hash(hosted.session.getState()!)).toBe(stubEngine.hash(client.getState()!));
  });

  it('invalid submissions are rejected and rolled back', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    hosted.host.startGame(SEED);
    await hub.settle();

    const evs = events(client);
    // bypass client-side validation to exercise the host rejection path
    client['link'].send({ t: 'cmd_submit', clientId: 'x1', turn: 1, kind: 'bogus', payload: {} });
    await hub.settle();
    expect(evs.some((e) => e.type === 'rejected')).toBe(true);
    expect(stubEngine.hash(hosted.session.getState()!)).toBe(stubEngine.hash(client.getState()!));

    const res = client.submit('increment', { n: 1.5 });
    expect(res.error).toContain('integer');
    expect(client.getPendingCount()).toBe(0);
  });

  it('advance_turn fires only when every seat committed; hashes agree', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    hosted.host.startGame(SEED);
    await hub.settle();

    client.submit('increment', { n: 3 });
    client.commitTurn();
    await hub.settle();
    expect(hosted.session.getState()!.turn).toBe(1); // host not committed yet
    expect(client.getCommitted()).toEqual([1]);

    hosted.session.commitTurn();
    await hub.settle();
    expect(hosted.session.getState()!.turn).toBe(2);
    expect(client.getState()!.turn).toBe(2);
    expect(client.getCommitted()).toEqual([]);

    // uncommit path
    client.commitTurn();
    client.uncommitTurn();
    hosted.session.commitTurn();
    await hub.settle();
    expect(client.getState()!.turn).toBe(2); // still waiting on client
    client.commitTurn();
    await hub.settle();
    expect(client.getState()!.turn).toBe(3);
  });
});

describe('resync + persistence', () => {
  it('a disconnected peer catches up via resync and converges', async () => {
    const { hub, hosted, client } = await twoPlayerGame();
    hosted.host.startGame(SEED);
    await hub.settle();

    client.commitTurn();
    await hub.settle();
    hub.disconnect(1);
    hosted.session.submit('increment', { n: 7 });
    hosted.session.commitTurn(); // both committed -> advance while client is away
    await hub.settle();
    expect(hosted.session.getState()!.turn).toBe(2);
    expect(client.getState()!.turn).toBe(1);

    hub.reconnect(1);
    client.requestResync();
    await hub.settle();
    expect(client.getState()!.turn).toBe(2);
    expect(stubEngine.hash(hosted.session.getState()!)).toBe(stubEngine.hash(client.getState()!));
  });

  it('both peers persist the identical command log and turn hashes', async () => {
    const { hub, hosted, client, store0, store1 } = await twoPlayerGame(true);
    hosted.host.startGame(SEED);
    await hub.settle();
    // Real SQLite completion is outside MemoryHub's microtask queue. The
    // host now correctly holds remote game_start until it is durable.
    await hosted.session.flush();
    await hub.settle();
    client.submit('increment', { n: 4 });
    hosted.session.submit('increment', { n: 9 });
    await hub.settle();
    client.commitTurn();
    hosted.session.commitTurn();
    await hub.settle();
    await hosted.session.flush();
    await client.flush();

    const gid = 'g-0123456789abcdef';
    const log0 = await store0!.readCommands(gid);
    const log1 = await store1!.readCommands(gid);
    expect(log0.length).toBeGreaterThanOrEqual(4); // start, 2 increments, advance
    expect(log0).toEqual(log1);
    expect(log0[0]!.kind).toBe('game_start');
    expect(log0[log0.length - 1]!.kind).toBe('advance_turn');

    const h0 = await store0!.getTurnHash(gid, 1);
    const h1 = await store1!.getTurnHash(gid, 1);
    expect(h0).toBeDefined();
    expect(h0).toBe(h1);

    const game0 = await store0!.getGame(gid);
    expect(game0?.seed).toBe(SEED);
    expect(game0?.local_player_id).toBe(0);
    const game1 = await store1!.getGame(gid);
    expect(game1?.local_player_id).toBe(1);
    await store0!.destroy();
    await store1!.destroy();
  });

  it('host resumes from its persisted log after a restart', async () => {
    const { hub, hosted, client, store0, store1 } = await twoPlayerGame(true);
    hosted.host.startGame(SEED);
    await hub.settle();
    // Real SQLite completion is outside MemoryHub's microtask queue. The
    // host now correctly holds remote game_start until it is durable.
    await hosted.session.flush();
    await hub.settle();
    hosted.session.submit('increment', { n: 2 });
    client.submit('increment', { n: 3 });
    await hub.settle();
    await hosted.session.flush();

    // host "restarts": tear down HostCore, rebuild from the persisted log
    hosted.host.close();
    const gid = 'g-0123456789abcdef';
    const log = await store0!.readCommands(gid);
    hub.leave(0);
    await hub.settle();
    const t0 = hub.rejoinSlot(0);
    const resumed = createHostedGame<StubState>({
      transport: t0,
      engine: stubEngine,
      store: store0,
      settings: DEFAULT_SETTINGS,
      identity: identity('Host'),
      resume: { gameId: gid, log: log.map((c) => ({ ...c, playerId: c.playerId })) },
    });
    await hub.settle();
    expect(resumed.session.getState()!.counters['0']).toBe(2);
    expect(resumed.session.getState()!.counters['1']).toBe(3);

    // client re-introduces itself (the app does this on host player-rejoined);
    // a restarted host only accepts commands from channels that have helloed,
    // because hello is what assigns the empire seat (name matching on resume)
    client.resendHello();
    await hub.settle();

    // client continues: submits against the resumed host
    client.submit('increment', { n: 1 });
    await hub.settle();
    expect(resumed.session.getState()!.counters['1']).toBe(4);
    expect(stubEngine.hash(resumed.session.getState()!)).toBe(stubEngine.hash(client.getState()!));
    await store0!.destroy();
    await store1!.destroy();
  });
});
