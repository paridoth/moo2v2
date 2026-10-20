import { createGameEngine } from '@engine/adapter';
import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import type { EngineAdapter } from '@protocol/engineAdapter';
import type { HostCore } from '@protocol/host';
import { GameSession } from '@protocol/session';
import type { StrategicPolicy } from './types';
import { LocalAiController } from './controller';

/** Same host channel/session protocol as multiplayer, with no transport peer. */
export function attachAiSeats(host: HostCore<GameState>, config: SinglePlayerConfig, policy?: StrategicPolicy): LocalAiController[] {
  return config.opponents.map((opponent) => {
    const session = new GameSession<GameState>({
      link: host.createLocalLink(),
      engine: createGameEngine() as unknown as EngineAdapter<GameState>,
      store: null, // the human's session is the sole durable writer
      playerId: -1,
      name: opponent.name,
      engineVersion: ENGINE_VERSION,
      dataVersion: DATA_VERSION,
      roomCode: 'local-ai',
      lobbyServer: 'local',
    });
    return new LocalAiController(session, config, opponent, policy, host.getLog());
  });
}
