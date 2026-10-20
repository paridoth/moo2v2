// Global UI state: which screen is visible plus the active game handle.
// Screens re-render off `app.version`, bumped on every session event; all game
// data is read through session getters (engine state is never proxied).

import type { ActiveGame } from './net';

export interface ReplayEntry {
  battleId: string;
  seed: string;
  input: unknown;
  summary: Record<string, unknown>;
  turn: number;
  watched: boolean;
}

export interface GroundBattleEntry {
  turn: number;
  watched: boolean;
  payload: {
    colonyId: number;
    colonyName: string;
    starId: number;
    attacker: number;
    defender: number;
    captured: boolean;
    civilianLosses: number;
    startTroops: number;
    startMilitia: number;
    /** trained marines in the defending garrison at the start (rest of
     * startMilitia is civilian militia); optional on pre-0.20 replay feeds */
    startGarrison?: number;
    /** playback scenery facts (optional on pre-0.20 replay feeds) */
    climate?: string;
    farming?: boolean;
    rounds: Array<{ t: number; m: number }>;
  };
}

export interface ReportEntry {
  turn: number;
  kind: string;
  payload: Record<string, unknown>;
}

export const app = $state({
  screen: 'home' as 'home' | 'lobby' | 'game',
  error: '',
  connecting: false,
  version: 0,
  chat: [] as Array<{ id: number; from: number; to: number; text: string }>,
  replays: [] as ReplayEntry[],
  groundBattles: [] as GroundBattleEntry[],
  /** replay currently open in the battle viewer */
  viewing: null as ReplayEntry | null,
  /** invasion playback queued/open over the map (waits for the ship-battle
   * viewer to close: the landing is watched after the pass that won it) */
  viewingGround: null as GroundBattleEntry | null,
  /** turn-event feed visible to this player (newest last) */
  reports: [] as ReportEntry[],
  /** host peer connectivity (clients only; host is always true) */
  hostConnected: true,
  /** transient note when the host rejects a command that passed optimistic
   * local validation (lost races: leader hires, colonize contention...) */
  rejectedNote: '',
  /** the ?room=&name= URL auto-join already ran (don't rejoin after leaving) */
  autoJoined: false,
  /** fast start: the CONTACT flash overlay (null = dismissed / never) */
  contactFlash: null as null | { turn: number; pairs: Array<[number, number]> },
  /** map view: star to center/select on next open (colony-ship arrival alert) */
  focusStarId: null as number | null,
  /** slider autopilot (bugs.md): when on, five weights run every colony each
   * turn and the player only manages research, ships and the map */
  autopilot: {
    enabled: false,
    weights: { infra: 6, pop: 5, research: 5, colonyShips: 4, military: 3 },
  },
  /** map-view quick builds: colonyId → player-pinned queue items, in build
   * order. Autopilot leaves pinned colonies' queues alone (see quickBuild.ts) */
  pins: {} as Record<number, string[]>,
  /** research queue: started automatically (client-issued set_research) when
   * the current field completes; entries validated again at dequeue time */
  researchQueue: [] as Array<{ fieldNum: number; fieldId: string; targetApp: string | null }>,
  /** pop the battle viewer up over the map as soon as one of MY battles
   * resolves (plays at 2×; the Empires-tab replay list keeps the archive) */
  autoReplay: true,
  /** idle scouts fly themselves to the nearest unexplored star in fuel range
   * (ordinary move_ships commands — reroutable like any manual order) */
  autoExplore: false,
  /** bumped to ask the shell to generate+open the campaign timelapse (used
   * by the Empires tab; the shell owns the viewer so it can pop on any tab) */
  timelapseRequest: 0,
});

// autopilot settings survive reloads (per browser, not per game)
try {
  const saved = localStorage.getItem('moo2.autopilot');
  if (saved) {
    const parsed = JSON.parse(saved) as typeof app.autopilot;
    app.autopilot.enabled = parsed.enabled === true;
    // sanitize: a hand-edited/corrupt entry must not NaN a slider off
    const num = (v: unknown, d: number) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : d;
    };
    const w = app.autopilot.weights;
    app.autopilot.weights = {
      infra: num(parsed.weights?.infra, w.infra),
      pop: num(parsed.weights?.pop, w.pop),
      research: num(parsed.weights?.research, w.research),
      colonyShips: num(parsed.weights?.colonyShips, w.colonyShips),
      military: num(parsed.weights?.military, w.military),
    };
  }
} catch {
  // corrupt/absent storage: defaults stand
}
export function saveAutopilot(): void {
  try {
    localStorage.setItem('moo2.autopilot', JSON.stringify(app.autopilot));
  } catch {
    // private mode: settings last for this tab only
  }
}

// auto-replay preference survives reloads (per browser)
try {
  app.autoReplay = localStorage.getItem('moo2.autoReplay') !== '0';
} catch {
  // defaults stand
}
export function saveAutoReplay(): void {
  try {
    localStorage.setItem('moo2.autoReplay', app.autoReplay ? '1' : '0');
  } catch {
    // private mode: lasts for this tab only
  }
}

// ---- per-game UI state (pins / research queue / auto-explore): keyed by the
// room code so a reload of the same game keeps the player's standing orders.
// All of it is client-side convenience — losing it never corrupts a game. ----
let perGameKey = '';
export function savePerGame(): void {
  if (!perGameKey) return;
  try {
    localStorage.setItem(
      perGameKey,
      JSON.stringify({ pins: app.pins, researchQueue: app.researchQueue, autoExplore: app.autoExplore }),
    );
  } catch {
    // private mode: lasts for this tab only
  }
}
function loadPerGame(roomCode: string): void {
  perGameKey = `moo2.game.${roomCode}`;
  app.pins = {};
  app.researchQueue = [];
  app.autoExplore = false;
  try {
    const raw = localStorage.getItem(perGameKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<typeof app>;
    // sanitize: hand-edited storage must not smuggle non-arrays into the UI
    if (parsed.pins && typeof parsed.pins === 'object') {
      for (const [k, v] of Object.entries(parsed.pins)) {
        const id = Number(k);
        if (Number.isInteger(id) && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
          app.pins[id] = v;
        }
      }
    }
    if (Array.isArray(parsed.researchQueue)) {
      app.researchQueue = parsed.researchQueue.filter(
        (e) =>
          e &&
          typeof e.fieldNum === 'number' &&
          typeof e.fieldId === 'string' &&
          (e.targetApp === null || typeof e.targetApp === 'string'),
      );
    }
    app.autoExplore = parsed.autoExplore === true;
  } catch {
    // corrupt/absent storage: defaults stand
  }
}

let rejectedNoteTimer: ReturnType<typeof setTimeout> | null = null;

// Not reactive on purpose: session/transport are external objects.
let activeGame: ActiveGame | null = null;

export function getActive(): ActiveGame | null {
  return activeGame;
}

export function bindActive(active: ActiveGame): void {
  activeGame = active;
  app.error = '';
  loadPerGame(active.params.code);
  app.screen = active.session.isStarted() ? 'game' : 'lobby';
  app.hostConnected = true;
  app.version++;
  if (!active.host) {
    // signaling blips fire spurious player-left for a host whose data channel
    // is fine — only show "host offline" if they stay gone for a while
    let hostLostTimer: ReturnType<typeof setTimeout> | null = null;
    active.transport.onEvent((ev) => {
      if (ev.type === 'player-left' && ev.playerId === 0) {
        if (!hostLostTimer) {
          hostLostTimer = setTimeout(() => {
            hostLostTimer = null;
            app.hostConnected = false;
            app.version++;
          }, 8000);
        }
      } else if ((ev.type === 'player-rejoined' || ev.type === 'player-joined') && ev.playerId === 0) {
        if (hostLostTimer) {
          clearTimeout(hostLostTimer);
          hostLostTimer = null;
        }
        app.hostConnected = true;
      }
      app.version++;
    });
  }
  active.session.subscribe((ev) => {
    app.version++;
    // any session event means host traffic is flowing: the "host offline"
    // banner must clear even when only the signaling websocket dropped
    // (lobbylink fires player-left(0) while the data channel stays healthy)
    if (!active.host && !app.hostConnected) app.hostConnected = true;
    if (ev.type === 'started') app.screen = 'game';
    else if (ev.type === 'version-reject') {
      app.error = ev.reason;
      app.screen = 'home';
    } else if (ev.type === 'rejected') {
      // the optimistic UI already reverted; without a note the action just
      // silently un-happens (lost host-side races)
      app.rejectedNote = `⛔ ${ev.reason}`;
      if (rejectedNoteTimer) clearTimeout(rejectedNoteTimer);
      rejectedNoteTimer = setTimeout(() => {
        app.rejectedNote = '';
        app.version++;
      }, 6000);
    } else if (ev.type === 'chat') {
      app.chat.push({ id: ev.id, from: ev.from, to: ev.to, text: ev.text });
      if (app.chat.length > 100) app.chat.shift();
    } else if (ev.type === 'turn-advanced') {
      // authoritative boundary. In a fast game the preview already showed
      // (identical) events for this turn — the dedupe below drops repeats.
      ingestTurnEvents(active, active.session.lastTurnEvents, ev.turn - 1);
    } else if (ev.type === 'fast-advanced') {
      // fast preview boundary: show the player what their turn produced
      ingestTurnEvents(active, [...active.session.getFastEvents()], ev.turn - 1);
    } else if (ev.type === 'contact') {
      app.contactFlash = { turn: ev.turn, pairs: ev.pairs };
    }
  });
  if (import.meta.env.DEV) {
    // dev/e2e hook: drive the session from the console or page.evaluate
    (window as unknown as Record<string, unknown>)['__moo2'] = { session: active.session };
  }
}

/** Fold one turn's events into the report/replay feeds. Fast games deliver a
 * turn twice (preview first, authoritative later) — repeats are dropped by
 * content, which also self-heals the rare preview/authoritative mismatch
 * (the authoritative version appends and the discrepancy is visible). */
function ingestTurnEvents(
  active: ActiveGame,
  events: ReadonlyArray<{ visibleTo: number; kind: string; payload: Record<string, unknown> }>,
  turn: number,
): void {
  const me = active.session.playerId;
  for (const e of events) {
    if (e.kind === 'ground_battle') {
      if (e.visibleTo !== me) continue; // participants only
      const gp = e.payload as GroundBattleEntry['payload'];
      if (!app.groundBattles.some((g) => g.turn === turn && g.payload.colonyId === gp.colonyId)) {
        const entry: GroundBattleEntry = { turn, payload: gp, watched: false };
        app.groundBattles.push(entry);
        if (app.groundBattles.length > 20) app.groundBattles.shift();
        // my invasion just resolved: queue the playback over the map. It
        // renders once no ship-battle replay is up (the shell hides it behind
        // app.viewing), so a landing that followed a battle plays second.
        if (app.autoReplay && !app.viewingGround) app.viewingGround = entry;
      }
      continue;
    }
    if (e.kind === 'battle_replay') {
      if (e.visibleTo !== -1 && e.visibleTo !== me) continue; // participants only
      const p = e.payload as { battleId: string; seed: string; input: unknown; summary: Record<string, unknown> };
      if (!app.replays.some((r) => r.battleId === p.battleId)) {
        const entry: ReplayEntry = { ...p, turn, watched: false };
        app.replays.push(entry);
        if (app.replays.length > 20) app.replays.shift();
        // one of MY battles just resolved: pop the viewer up over the map
        // right away (participants only — visibleTo === me), playing at 2×.
        // A battle already on screen keeps priority; the nav badge catches
        // any extras and the Empires-tab list keeps the full archive.
        if (app.autoReplay && e.visibleTo === me && !app.viewing) {
          app.viewing = entry;
        }
      }
      continue;
    }
    if (e.visibleTo === -1 || e.visibleTo === me) {
      const json = JSON.stringify(e.payload);
      if (app.reports.some((r) => r.turn === turn && r.kind === e.kind && JSON.stringify(r.payload) === json)) {
        continue;
      }
      app.reports.push({ turn, kind: e.kind, payload: e.payload as Record<string, unknown> });
      if (app.reports.length > 300) app.reports.shift();
    }
  }
}

/** Scrub per-game UI state: reports/replays/an open viewer leaking into the
 * next game shows the previous game's battles under the new game's turns. */
export function resetGameUiState(): void {
  app.chat = [];
  app.replays = [];
  app.groundBattles = [];
  app.reports = [];
  app.viewing = null;
  app.viewingGround = null;
  app.rejectedNote = '';
  app.hostConnected = true;
  app.contactFlash = null;
  app.focusStarId = null;
  app.pins = {};
  app.researchQueue = [];
  app.autoExplore = false;
  app.timelapseRequest = 0;
  app.version++;
}

export function leaveGame(): void {
  const g = activeGame;
  activeGame = null;
  app.screen = 'home';
  resetGameUiState();
  if (!g) return;
  g.host?.close();
  for (const b of g.aiSeats ?? []) b.close();
  g.solo?.close();
  for (const b of g.soloBots) b.close(); // close() is idempotent (solo = soloBots[0])
  for (const b of g.bots) b.close();
  void (async () => {
    // play-by-mail: final upload + lock release must finish BEFORE the store
    // (its data source) is torn down
    await g.pbm?.stop().catch(() => undefined);
    g.transport.close();
    await Promise.resolve();
    await g.session.flush();
    // release the room database (OPFS access handle) so another tab can take it
    await g.store?.destroy().catch(() => undefined);
  })();
}
