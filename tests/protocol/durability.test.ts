import { expect, it } from 'vitest';
import { MemoryHub } from '@protocol/memoryTransport';
import { createHostedGame, joinGame } from '@protocol/setup';
import { stubEngine } from '@protocol/engineAdapter';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { MemoryGameStore } from '@storage/memory';
import type { SessionCommandRecord } from '@protocol/persistence';

class GatedStore extends MemoryGameStore {
  private gate = Promise.resolve();
  block(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    return release;
  }
  override async appendCommands(gameId: string, records: SessionCommandRecord[]): Promise<void> {
    await this.gate;
    return super.appendCommands(gameId, records);
  }
}

it('local session ingestion precedes the host persistence barrier, including game_start and turn advance', async () => {
  const store = new GatedStore();
  const hub = new MemoryHub(2);
  const identity = { name: 'Host', engineVersion: 'test', dataVersion: 'test', roomCode: 'DURABLE', lobbyServer: 'local' };
  const g = createHostedGame({ transport: hub.join(), engine: stubEngine, store, settings: DEFAULT_SETTINGS, identity });
  const client = joinGame({ transport: hub.join(), engine: stubEngine, store: null, identity: { ...identity, name: 'Guest' } });
  await hub.settle();
  const start = store.block();
  try {
    g.host.startGame('0123456789abcdef0123456789abcdef');
    await hub.settle();
    expect(g.session.isStarted()).toBe(true);
    expect(client.isStarted()).toBe(false); // remote never sees an unrecorded game
    start();
    await g.session.flush();
    await hub.settle();
    expect(client.isStarted()).toBe(true);
    const advance = store.block();
    g.session.commitTurn();
    client.commitTurn();
    await hub.settle();
    expect(g.session.getState()!.turn).toBe(2);
    expect(client.getState()!.turn).toBe(1); // not durable yet
    advance();
    await g.session.flush();
    await hub.settle();
    expect(client.getState()!.turn).toBe(2);
    const log = await store.readCommands(g.session.gameId!);
    expect(log.at(-1)!.kind).toBe('advance_turn');
  } finally { start(); g.host.close(); }
});
