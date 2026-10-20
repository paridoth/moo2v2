// UI-side network/persistence glue: connect to a room, open the per-room
// database, detect resumable games, and wire up the session (+ HostCore when
// this browser is the room creator / player 0).

import { ENGINE_VERSION } from '@engine/index';
import { DATA_VERSION } from '@engine/data/index';
import { createGameEngine } from '@engine/adapter';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import { attachAiSeats } from '@ai/seats';
import type { LocalAiController } from '@ai/controller';
import { botRaceById, botRacePicks } from './botRaces';
import type { EngineAdapter } from '@protocol/engineAdapter';
import type { HostCore } from '@protocol/host';
import { LobbylinkTransport } from '@protocol/lobbylinkTransport';
import { MemoryHub } from '@protocol/memoryTransport';
import { DEFAULT_SETTINGS, type LogCommand } from '@protocol/messages';
import { createHostedGame, generateSeed, joinGame } from '@protocol/setup';
import { GameSession } from '@protocol/session';
import type { NetTransport } from '@protocol/transport';
import { SoloBot, type BotMode, type BotPersonality } from './soloBot';
import { isOpfsLikelyAvailable, openBrowserStore } from '@storage/browser';
import { MemoryGameStore, type GameStoreLike } from '@storage/memory';
import type { SQLocalKysely } from 'sqlocal/kysely';

export const DEFAULT_SERVER = 'https://pqrstuvw.xyz/lobbylink';

export interface RoomParams {
  server: string;
  code: string;
  name: string;
  playerCount: number;
  /** enable logged debug commands (testing) — host setting */
  debug?: boolean;
}

export interface ActiveGame {
  transport: Pick<NetTransport, 'close' | 'onEvent' | 'selfId'>;
  session: GameSession<GameState>;
  host: HostCore<GameState> | null;
  store: GameStoreLike | null;
  sqlocal: SQLocalKysely | null;
  /** persistence is RAM-only: browser storage is unavailable to this tab
   * (saves still download fine, but nothing survives a reload) */
  memoryOnly: boolean;
  params: RoomParams;
  startGame: () => void;
  /** single-player mode: the first bot opponent (legacy aggression handle) */
  solo: SoloBot | null;
  /** single-player mode: ALL local bot opponents (1..N, in seat order) */
  soloBots: SoloBot[];
  /** Fair Orion seats; no full-state strategy access or debug grants. */
  aiSeats?: LocalAiController[];
  /** bots subbed in for absent players (host only; name-matched to seats) */
  bots: SoloBot[];
  /** play-by-mail session info (set by enterPbmGame); null in normal games */
  pbm: {
    role: 'host' | 'guest';
    note: string;
    /** final upload + lock release; called by leaveGame */
    stop: () => Promise<void>;
  } | null;
  /** how this solo game was configured — lets 🔄 restart rebuild it exactly */
  soloSetup: SoloSetup | null;
}

/** lobby-level bot choice: the two SoloBot modes plus the OnionAI doctrine
 * (a fair-mode bot running the constraint-driven onion brain) */
export type LobbyBotMode = BotMode | 'onion' | 'strategic';

export interface SoloSetup {
  name: string;
  botMode: LobbyBotMode;
  specs: SoloBotSpec[];
  /** room code the campaign persists under (default SOLO) */
  code: string;
  difficulty?: SinglePlayerConfig['difficulty'];
  configuration?: SinglePlayerConfig;
}

/** Host-side: let a bot take over an absent player's seat. The bot helloes
 * with the seat's name, so the host's name matching hands it that empire. */
export function addBotForSeat(active: ActiveGame, seatName: string, mode: BotMode = 'fair'): SoloBot | null {
  if (!active.host) return null;
  const link = active.host.createLocalLink();
  const session = new GameSession<GameState>({
    link,
    engine: createGameEngine() as unknown as EngineAdapter<GameState>,
    store: null, // the host's own session already records the game
    playerId: -1, // the host's welcome assigns the real seat
    name: seatName,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: active.params.code,
    lobbyServer: active.params.server,
  });
  const bot = new SoloBot({ session, mode, personality: 'auto' });
  active.bots.push(bot);
  return bot;
}

/** Host-side: retire a stand-in bot and free its seat for the returning human. */
export function removeBotForSeat(active: ActiveGame, bot: SoloBot): void {
  bot.close();
  if (active.host && bot.seatId >= 0) active.host.releaseSeat(bot.seatId);
  active.bots = active.bots.filter((b) => b !== bot);
}

interface ResumeInfo {
  gameId: string;
  lastSeq: number;
  state: GameState | null;
  log: LogCommand[];
}

async function loadResume(
  store: GameStoreLike,
  roomCode: string,
  engine: EngineAdapter<GameState>,
): Promise<ResumeInfo | null> {
  const games = await store.listGames();
  const g = games.find((x) => x.room_code === roomCode && x.status === 'active');
  if (!g) return null;
  if (g.engine_version !== ENGINE_VERSION || g.data_version !== DATA_VERSION) {
    // replaying an old log through a newer engine could silently diverge —
    // leave the stored game alone; the save-file loader knows how to rebase it
    console.warn(
      `[net] not auto-resuming ${g.game_id}: stored ${g.engine_version}/${g.data_version} vs build ${ENGINE_VERSION}/${DATA_VERSION}`,
    );
    return null;
  }
  const snap = await store.latestSnapshot(g.game_id);
  let state: GameState | null = snap ? engine.deserialize(snap.stateJson) : null;
  let lastSeq = snap?.seq ?? -1;
  const tail = await store.readCommands(g.game_id, lastSeq + 1);
  for (const c of tail) {
    state = c.kind === 'game_start' ? engine.init(c.payload as never) : state ? engine.apply(state, c) : null;
    lastSeq = c.seq;
  }
  const log = (await store.readCommands(g.game_id)).map((c) => ({
    seq: c.seq,
    turn: c.turn,
    playerId: c.playerId,
    kind: c.kind,
    payload: c.payload,
  }));
  return { gameId: g.game_id, lastSeq, state, log };
}

/** Open the room's OPFS database, detecting sqlocal's silent RAM fallback.
 * The fallback swaps in a memory driver (storageType 'memory') — that is the
 * signal that nothing will survive a reload. Note: the `persisted` flag is
 * just navigator.storage.persisted(), a browser permission that is false for
 * nearly everyone — it must NOT be used for this. */
async function openRoomStore(
  roomCode: string,
): Promise<{ store: GameStoreLike; sqlocal: SQLocalKysely | null; memoryOnly: boolean }> {
  if (isOpfsLikelyAvailable()) {
    try {
      const opened = await openBrowserStore(`moo2v2-room-${roomCode}.sqlite3`);
      const info = await opened.sqlocal.getDatabaseInfo().catch(() => null);
      if (info && (info.storageType === 'memory' || info.databasePath === ':memory:')) {
        await opened.store.destroy().catch(() => undefined);
      } else {
        return { store: opened.store, sqlocal: opened.sqlocal, memoryOnly: false };
      }
    } catch (e) {
      console.warn('[net] persistence unavailable:', e);
    }
  }
  // safety net: keep the whole game record in memory so a verified save file
  // can always be downloaded from this tab
  return { store: new MemoryGameStore(), sqlocal: null, memoryOnly: true };
}

export async function enterRoom(params: RoomParams): Promise<ActiveGame> {
  const transport = await LobbylinkTransport.connect({
    server: params.server,
    code: params.code,
    maxPlayers: params.playerCount,
  });

  const { store, sqlocal, memoryOnly } = await openRoomStore(params.code);

  const identity = {
    name: params.name,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: params.code,
    lobbyServer: params.server,
  };

  const resume = store ? await loadResume(store, params.code, createGameEngine() as unknown as EngineAdapter<GameState>) : null;

  if (transport.selfId === 0) {
    const hosted = createHostedGame<GameState>({
      transport,
      engine: createGameEngine() as unknown as EngineAdapter<GameState>,
      hostEngine: createGameEngine() as unknown as EngineAdapter<GameState>,
      branchEngine: createGameEngine() as unknown as EngineAdapter<GameState>,
      store,
      settings: { ...DEFAULT_SETTINGS, playerCount: params.playerCount, debugCommands: params.debug ?? false },
      identity,
      ...(resume && resume.log.length ? { resume: { gameId: resume.gameId, log: resume.log } } : {}),
    });
    return {
      transport,
      session: hosted.session,
      host: hosted.host,
      store,
      sqlocal,
      memoryOnly,
      params,
      startGame: () => hosted.host.startGame(generateSeed()),
      solo: null,
      soloBots: [],
      bots: [],
      pbm: null,
      soloSetup: null,
    };
  }

  const session = joinGame<GameState>({
    transport,
    engine: createGameEngine() as unknown as EngineAdapter<GameState>,
    branchEngine: createGameEngine() as unknown as EngineAdapter<GameState>,
    store,
    identity,
    ...(resume ? { resume: { gameId: resume.gameId, lastSeq: resume.lastSeq, state: resume.state } } : {}),
  });
  transport.onEvent((ev) => {
    if ((ev.type === 'player-rejoined' || ev.type === 'player-joined') && ev.playerId === 0) {
      // host page reload: re-introduce ourselves so it can resync us
      session.resendHello();
    }
  });
  return {
    transport,
    session,
    host: null,
    store,
    sqlocal,
    memoryOnly,
    params,
    startGame: () => {
      throw new Error('only the host can start');
    },
    solo: null,
    soloBots: [],
    bots: [],
    pbm: null,
    soloSetup: null,
  };
}

/** Per-bot setup for solo games: play-style plus the scenario dressing
 * (race archetype/preset, banner color, fleet silhouette). */
export interface SoloBotSpec {
  personality?: BotPersonality | 'auto';
  /** archetype id (botRaces.ts) or stock preset id; SoloBot defaults hivex */
  race?: string;
  /** banner color #rrggbb */
  color?: string;
  /** fleet silhouette (shipstyles.ts id) */
  shipStyle?: string;
}

/** Single-player mode: an in-process game against one or more bots — no
 * lobbylink server, no WebRTC (every bot is a local MemoryHub session).
 * Persists like any room (code SOLO by default; opts.code lets several bot
 * campaigns coexist, one per tab), so a reload resumes the campaign; bots
 * keep their stable names (Bot, Bot 2, ...) so resume re-seats them. */
export async function enterSoloGame(
  name: string,
  botMode: LobbyBotMode = 'strategic',
  personality: BotPersonality | 'auto' = 'militarist',
  botSpecs?: SoloBotSpec[],
  opts?: {
    /** room code the campaign persists under (default SOLO) */
    code?: string;
    /** abandon any stored campaign under this code and start over */
    fresh?: boolean;
    difficulty?: SinglePlayerConfig['difficulty'];
    configuration?: SinglePlayerConfig;
  },
): Promise<ActiveGame> {
  let specs: SoloBotSpec[] = botSpecs?.length ? botSpecs : [{ personality }, { personality: 'expander' }];
  const playerCount = 1 + specs.length;
  const code = opts?.code?.trim() || 'SOLO';
  const params: RoomParams = { server: 'local', code, name, playerCount };
  const hub = new MemoryHub(8); // capacity also covers restored legacy campaigns
  const hostTransport = hub.join();

  const { store, sqlocal, memoryOnly } = await openRoomStore(params.code);
  if (opts?.fresh) {
    // retire the stored campaign so loadResume starts a new galaxy; the old
    // game stays in the database (a downloaded save can still resurrect it)
    for (const g of await store.listGames()) {
      if (g.room_code === params.code && g.status === 'active') await store.setGameStatus(g.game_id, 'abandoned');
    }
  }

  const identity = {
    name,
    engineVersion: ENGINE_VERSION,
    dataVersion: DATA_VERSION,
    roomCode: params.code,
    lobbyServer: params.server,
  };
  const resume = await loadResume(store, params.code, createGameEngine() as unknown as EngineAdapter<GameState>);
  // Saved ownership wins over the Home screen's current bot count/options.
  const savedConfig = resume?.state?.settings.singlePlayer;
  if (savedConfig) botMode = 'strategic';
  // Pre-Orion saves have no ownership metadata. Preserve their old solo
  // policy instead of silently migrating them or enabling new commands.
  if (resume?.state && !savedConfig && botMode === 'strategic') {
    botMode = resume.state.settings.debugCommands ? 'parity' : 'fair';
    specs = resume.state.empires.filter((e) => e.id !== 0).map(() => ({ personality: 'auto' }));
  }
  let config: SinglePlayerConfig | undefined = savedConfig ?? opts?.configuration;
  if (botMode === 'strategic' && !config) {
    config = {
      version: 1, humanSeat: 0, difficulty: opts?.difficulty ?? 'normal',
      opponents: specs.map((spec, i) => {
        const race = spec.race ? botRaceById.get(spec.race) : undefined;
        const picks = spec.race ? botRacePicks(spec.race, DEFAULT_SETTINGS.pickPoints ?? 10) : null;
        return {
          seat: i + 1, name: i === 0 ? 'Bot' : `Bot ${i + 1}`, strategy: 'strategist-v3',
          personality: spec.personality === 'auto' || !spec.personality ? 'balanced' : spec.personality,
          raceJson: JSON.stringify({ ...(race && picks ? { picks, raceName: race.name } : { presetId: spec.race ?? 'hivex' }),
            ...(spec.color ? { color: spec.color } : {}) }),
          ...(spec.shipStyle ? { shipStyle: spec.shipStyle } : {}),
        };
      }),
    };
  }
  if (savedConfig) specs = savedConfig.opponents.map((p) => ({ personality: p.personality }));
  params.playerCount = config ? config.opponents.length + 1 : specs.length + 1;

  const hosted = createHostedGame<GameState>({
    transport: hostTransport,
    engine: createGameEngine() as unknown as EngineAdapter<GameState>,
    hostEngine: createGameEngine() as unknown as EngineAdapter<GameState>,
    branchEngine: createGameEngine() as unknown as EngineAdapter<GameState>,
    store,
    // debugCommands power the parity bot's logged "grants" — the sim has no
    // bot cases; the fair bot never uses them
    settings: { ...DEFAULT_SETTINGS, playerCount: config ? config.opponents.length + 1 : playerCount,
      debugCommands: botMode === 'parity', ...(config ? { singlePlayer: config } : {}) },
    identity,
    ...(resume && resume.log.length ? { resume: { gameId: resume.gameId, log: resume.log } } : {}),
  });
  const aiSeats = config ? attachAiSeats(hosted.host, config) : [];
  const soloBots = config ? [] : specs.map((spec, i) => {
    const botSession = joinGame<GameState>({
      transport: hub.join(),
      engine: createGameEngine() as unknown as EngineAdapter<GameState>,
      store: null, // the human's store records the game; the bots keep nothing
      identity: { ...identity, name: i === 0 ? 'Bot' : `Bot ${i + 1}` },
    });
    return new SoloBot({
      session: botSession,
      mode: botMode === 'parity' ? 'parity' : 'fair',
      ...(botMode === 'onion' ? { brain: 'onion' as const } : {}),
      personality: spec.personality ?? personality,
      ...(spec.race ? { race: spec.race } : {}),
      ...(spec.color ? { color: spec.color } : {}),
      ...(spec.shipStyle ? { shipStyle: spec.shipStyle } : {}),
    });
  });

  return {
    transport: hostTransport,
    session: hosted.session,
    host: hosted.host,
    store,
    sqlocal,
    memoryOnly,
    params,
    startGame: () => hosted.host.startGame(generateSeed()),
    solo: soloBots[0] ?? null,
    soloBots,
    aiSeats,
    bots: [],
    pbm: null,
    soloSetup: { name, botMode, specs, code: params.code, difficulty: config?.difficulty, configuration: config },
  };
}

/** Tear down a solo game and start a fresh campaign in the same room with the
 * same bots. Unlike leaveGame, the store handle is released BEFORE re-entry
 * (awaited), so the new game reopens the same OPFS database instead of
 * falling back to memory-only persistence. */
export async function restartSoloGame(active: ActiveGame): Promise<ActiveGame> {
  const setup = active.soloSetup;
  if (!setup) throw new Error('not a single-player game');
  for (const b of active.soloBots) b.close();
  for (const b of active.aiSeats ?? []) b.close();
  active.host?.close();
  active.transport.close();
  await Promise.resolve(); // drain already queued local deliveries
  await active.session.flush();
  await active.store?.destroy().catch(() => undefined);
  return enterSoloGame(setup.name, setup.botMode, setup.specs[0]?.personality ?? 'militarist', setup.specs, {
    code: setup.code,
    fresh: true,
    difficulty: setup.difficulty,
    configuration: setup.configuration,
  });
}
