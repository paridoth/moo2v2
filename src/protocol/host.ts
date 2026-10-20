// HostCore: the single sequencer (runs only on player 0's machine). Assigns
// gapless global sequence numbers, validates player commands against the
// authoritative state, broadcasts acceptances, decides turn advancement, and
// serves resyncs. Persistence of the log is the host session's job (single
// writer); HostCore keeps the full log in memory for resync serving.

import type { EngineAdapter, GameStartPayload } from './engineAdapter';
import { findContested, resolveAuction, type AuctionOutcome } from './auction';
import { gameIdFromSeed } from './session';
import { LocalHostLink } from './link';
import {
  FAST_MAX_AHEAD,
  PROTOCOL_VERSION,
  type ClientToHost,
  type GameSettings,
  type HostToClient,
  type LogCommand,
  type PlayerRoster,
} from './messages';
import type { NetTransport } from './transport';

interface Seat {
  name: string;
  ready: boolean;
  raceJson: string | null;
  connected: boolean;
  hello: boolean;
}

export interface HostCoreOptions<S> {
  transport: NetTransport;
  engine: EngineAdapter<S>;
  gameId: string;
  settings: GameSettings;
  engineVersion: string;
  dataVersion: string;
  hostName: string;
  /** resume from an existing log (page reload) */
  resumeLog?: LogCommand[];
}

/** commit/reveal phase length for the sealed-bid pick auction */
export const AUCTION_PHASE_MS = 45_000;

export class HostCore<S> {
  readonly localLink: LocalHostLink;
  private readonly transport: NetTransport;
  private readonly engine: EngineAdapter<S>;
  /** derived from the seed at game_start (fresh hosts are constructed with ''
   * — the welcome must still carry the real id so a rejoining client can
   * detect that its auto-resumed local game is NOT the game in this room) */
  private gameId: string;
  private settings: GameSettings;
  private readonly engineVersion: string;
  private readonly dataVersion: string;

  private seats = new Map<number, Seat>();
  /** channel (transport peer id, or host-local link id) → empire seat. In a
   * fresh lobby channels and seats coincide; a game resumed from a save
   * matches each hello to a saved empire by name instead of join order. */
  private seatMap = new Map<number, number>();
  private localLinks = new Map<number, LocalHostLink>();
  private nextLocalChannel = 1000; // never collides with lobbylink peer ids
  private log: LogCommand[] = [];
  private lastSeq = -1;
  private state: S | null = null;
  private committed = new Set<number>();
  // ----- fast start (async turns until contact) -----
  /** commands submitted for turns the authoritative sim has not reached yet,
   * FIFO per turn (drained + validated when the sim arrives at that turn) */
  private fastBuf = new Map<number, Array<{ seat: number; clientId: string; kind: string; payload: unknown }>>();
  /** clientIds ever buffered — clients re-send their buffers after a host
   * restart or reconnect; duplicates must not double-apply */
  private fastBufIds = new Set<string>();
  /** highest turn each seat has committed through */
  private fastCommitted = new Map<number, number>();
  /** guards the one-time CONTACT broadcast */
  private contactAnnounced = false;
  // chat ids are namespaced per host session (epoch-second base): a resumed
  // host restarting at 0 would collide with persisted rows and the storage
  // layer's conflict handling silently dropped every post-restart message
  private chatSeq = Date.now();
  private turnHashes = new Map<number, string>();
  /** ordered broadcast queue (drainOutbox); barrier-gated for turn commands */
  private outbox: Array<{ cmd: LogCommand; clientId?: string; submitter?: number }> = [];
  private draining = false;
  private closed = false;
  private persistBarrier: (() => Promise<void>) | null = null;
  private unsubs: Array<() => void> = [];
  private battleTimer: ReturnType<typeof setTimeout> | null = null;
  private battleOrdersTimeoutMs = 60_000;
  /** auto-turn: armed once all seats but one have committed */
  private autoTurnTimer: ReturnType<typeof setTimeout> | null = null;
  private autoTurnDeadline = 0;
  /** turn the auto-turn timer was armed for (realtime re-arms each turn) */
  private autoTurnArmedTurn = -1;
  private auction: {
    seed: string;
    contested: Record<string, number[]>;
    bidders: number[];
    phase: 'commit' | 'reveal';
    commits: Map<number, string>;
    reveals: Map<number, { bids: Record<string, number>; nonce: string }>;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(opts: HostCoreOptions<S>) {
    this.transport = opts.transport;
    this.engine = opts.engine;
    this.gameId = opts.gameId;
    this.settings = opts.settings;
    this.battleOrdersTimeoutMs = opts.settings.battleOrdersTimeoutMs || 60_000;
    this.engineVersion = opts.engineVersion;
    this.dataVersion = opts.dataVersion;
    this.localLink = new LocalHostLink((msg) => this.route(0, msg));
    this.localLinks.set(0, this.localLink);

    this.seats.set(0, {
      name: opts.hostName,
      ready: false,
      raceJson: null,
      connected: true,
      hello: true,
    });

    if (opts.resumeLog?.length) {
      for (const cmd of opts.resumeLog) this.fold(cmd);
      this.battleOrdersTimeoutMs = this.settings.battleOrdersTimeoutMs || 60_000;
      // a resumed fast game that already reached contact stays synchronous —
      // mark it announced so the refold never re-flashes CONTACT
      if (this.fastEnabled() && this.state) {
        const pairs = this.engine.contactPairs?.(this.state) ?? [];
        const winner = this.engine.winnerOf?.(this.state) ?? null;
        if (pairs.length || winner !== null) this.contactAnnounced = true;
      }
      this.checkBattlePhase(); // resumed mid battle-orders phase: restart the clock
      this.armAutoTurn(); // commits may already be one short of the table
      // fast phase: a crash between advance_turn and resolve_combat leaves an
      // NPC battle dangling — the pump resolves it immediately on resume
      if (this.fastLive()) this.fastPump();
    }

    this.unsubs.push(this.transport.onMessage((from, msg) => this.route(from, msg as ClientToHost)));
    this.unsubs.push(
      this.transport.onEvent((ev) => {
        if (ev.type === 'player-left') {
          const seatId = this.seatMap.get(ev.playerId);
          const seat = seatId !== undefined ? this.seats.get(seatId) : undefined;
          if (seat) seat.connected = false;
          this.broadcastLobby();
        } else if (ev.type === 'player-rejoined' || ev.type === 'player-joined') {
          const seatId = this.seatMap.get(ev.playerId);
          const seat = seatId !== undefined ? this.seats.get(seatId) : undefined;
          if (seat) seat.connected = true;
          // roster broadcast happens after their hello
        }
      }),
    );
  }

  get started(): boolean {
    return this.log.length > 0;
  }

  getLog(): readonly LogCommand[] {
    return this.log;
  }

  close(): void {
    this.closed = true;
    for (const u of this.unsubs) u();
    if (this.battleTimer) clearTimeout(this.battleTimer);
    if (this.autoTurnTimer) clearTimeout(this.autoTurnTimer);
  }

  // ----- message routing -----

  private route(from: number, msg: ClientToHost): void {
    if (this.closed) return;
    if (msg.t === 'hello') return this.onHello(from, msg);
    const seat = this.seatMap.get(from);
    if (seat === undefined) return; // must hello (and get a seat) first
    // lobbylink signaling blips fire player-left while the data channel is
    // fine — any message from the seat proves they are alive, so self-heal
    // the flag instead of showing a phantom "not connected" (bugs.md)
    const seatInfo = this.seats.get(seat);
    if (seatInfo && !seatInfo.connected) {
      seatInfo.connected = true;
      this.broadcastLobby();
    }
    switch (msg.t) {
      case 'race_config':
        return this.onRaceConfig(seat, msg);
      case 'cmd_submit':
        return this.onSubmit(seat, msg);
      case 'commit_turn':
        return this.onCommit(seat, msg.turn, true);
      case 'uncommit_turn':
        return this.onCommit(seat, msg.turn, false);
      case 'hash_report':
        return this.onHashReport(seat, msg);
      case 'resync_request':
        return this.sendResync(seat, msg.haveSeq);
      case 'chat_send':
        return this.onChat(seat, msg);
      case 'auction_commit':
        return this.onAuctionCommit(seat, msg.hash);
      case 'auction_reveal':
        return this.onAuctionReveal(seat, msg.bids, msg.nonce);
      default:
        return;
    }
  }

  private sendToChannel(channel: number, msg: HostToClient): void {
    const link = this.localLinks.get(channel);
    if (link) {
      link._deliver(msg);
      return;
    }
    void this.transport.send(channel, msg).catch(() => {
      // unreachable peer resyncs on rejoin
    });
  }

  private sendTo(seatId: number, msg: HostToClient): void {
    for (const [channel, seat] of this.seatMap) {
      if (seat === seatId) return this.sendToChannel(channel, msg);
    }
    // unclaimed seat (resumed game waiting for its player): nothing to send
  }

  /** Extra host-side channel for a locally driven session (a bot taking over
   * a seat). Its hello goes through normal seat matching by name. */
  createLocalLink(): LocalHostLink {
    const channel = this.nextLocalChannel++;
    const link = new LocalHostLink((msg) => this.route(channel, msg));
    this.localLinks.set(channel, link);
    return link;
  }

  /** Drop a seat's claim (e.g. removing a stand-in bot) so the next hello —
   * say the returning human — can take the empire back. */
  releaseSeat(seatId: number): void {
    for (const [channel, seat] of [...this.seatMap]) {
      if (seat !== seatId) continue;
      this.seatMap.delete(channel);
      if (channel >= 1000) this.localLinks.delete(channel);
    }
    const seat = this.seats.get(seatId);
    if (seat) seat.connected = false;
    this.broadcastLobby();
  }

  private broadcast(msg: HostToClient): void {
    for (const id of this.seats.keys()) this.sendTo(id, msg);
  }

  // ----- lobby -----

  private roster(): PlayerRoster[] {
    return [...this.seats.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, s]) => ({
        id,
        name: s.name,
        ready: s.ready,
        connected: s.connected,
        raceJson: s.raceJson,
      }));
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby_update', players: this.roster(), settings: this.settings });
  }

  /** Pick the empire seat a helloing channel plays. Prefers its existing
   * claim, then a name match among free (or abandoned) seats, then the lowest
   * free seat. Returns null when every seat is taken by a live connection. */
  private assignSeat(channel: number, name: string): number | null {
    const existing = this.seatMap.get(channel);
    if (existing !== undefined && this.seats.has(existing)) return existing;
    const claimedBy = new Map<number, number>(); // seat -> channel
    for (const [ch, s] of this.seatMap) claimedBy.set(s, ch);
    const available = [...this.seats.keys()]
      .filter((id) => !claimedBy.has(id) || !this.seats.get(id)!.connected)
      .sort((a, b) => a - b);
    if (!available.length) return null;
    const norm = (s: string) => s.trim().toLowerCase();
    const matches = available.filter((id) => norm(this.seats.get(id)!.name) === norm(name));
    // ties (duplicate names, no match) break toward the channel's own number
    // so reconnecting players keep stable seats
    const seat = matches.includes(channel)
      ? channel
      : (matches[0] ?? (available.includes(channel) ? channel : available[0]!));
    const prev = claimedBy.get(seat);
    if (prev !== undefined) this.seatMap.delete(prev);
    this.seatMap.set(channel, seat);
    return seat;
  }

  private onHello(from: number, msg: Extract<ClientToHost, { t: 'hello' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      return this.sendToChannel(from, {
        t: 'version_reject',
        reason: `protocol ${msg.protocolVersion} != ${PROTOCOL_VERSION}`,
      });
    }
    if (msg.dataVersion !== this.dataVersion) {
      return this.sendToChannel(from, {
        t: 'version_reject',
        reason: `data version mismatch (host ${this.dataVersion}, you ${msg.dataVersion})`,
      });
    }
    // engineVersion is bumped independently for logic changes: a mixed-build
    // table would silently diverge every turn (docs/save-compatibility.md
    // requires cross-version joining to be refused)
    if (msg.engineVersion !== this.engineVersion) {
      return this.sendToChannel(from, {
        t: 'version_reject',
        reason: `engine version mismatch (host ${this.engineVersion}, you ${msg.engineVersion})`,
      });
    }
    let seatId: number;
    if (this.started) {
      const assigned = this.assignSeat(from, msg.name);
      if (assigned === null) {
        return this.sendToChannel(from, {
          t: 'version_reject',
          reason: 'game already started; every empire seat is taken',
        });
      }
      seatId = assigned;
    } else {
      // Local AI channels are transport identities, not empire ids. Allocate
      // normal contiguous seats; remote peers retain their existing ids.
      seatId = from;
      if (from >= 1000) {
        seatId = this.seatMap.get(from) ?? 1;
        while (this.seats.has(seatId) && this.seatMap.get(from) !== seatId) seatId++;
      }
      this.seatMap.set(from, seatId);
    }
    const seat: Seat = this.seats.get(seatId) ?? {
      name: msg.name,
      ready: false,
      raceJson: null,
      connected: true,
      hello: true,
    };
    seat.name = msg.name || seat.name;
    seat.connected = true;
    seat.hello = true;
    this.seats.set(seatId, seat);
    this.sendTo(seatId, {
      t: 'welcome',
      gameId: this.gameId,
      settings: this.settings,
      players: this.roster(),
      lastSeq: this.lastSeq,
      started: this.started,
      seat: seatId,
    });
    if (this.started && msg.haveSeq < this.lastSeq) {
      this.sendResync(seatId, msg.haveSeq);
    } else if (this.started && msg.haveSeq > this.lastSeq) {
      // the client's local record is AHEAD of ours — a crash lost our tail
      // (reissued seqs), or its tab auto-resumed a stale/foreign branch for
      // this room. Silence here used to freeze that player forever (commits
      // dropped, every order rejected, no recovery); a desync notice makes
      // the session drop its state and refold our full log.
      this.sendTo(seatId, { t: 'desync_notice', turn: this.currentTurn(), expected: '' });
    } else if (!this.started && msg.haveSeq >= 0) {
      // an UNSTARTED room, yet the client resumed a local record for it: that
      // record is stale by definition (this lobby's game does not exist yet).
      // Reset now, or the eventual game_start (seq 0) would be dropped as a
      // "duplicate" of the stale log and the client would never fold it.
      this.sendTo(seatId, { t: 'desync_notice', turn: 0, expected: '' });
    }
    this.broadcastLobby();
    if (this.started) {
      // a (re)joining client must learn a live countdown too — realtime mode
      // never re-broadcasts the deadline until someone commits or it fires
      this.sendTo(
        seatId,
        this.commitStatusMsg(this.autoTurnTimer ? Math.max(0, this.autoTurnDeadline - Date.now()) : undefined),
      );
    }
  }

  private onRaceConfig(from: number, msg: Extract<ClientToHost, { t: 'race_config' }>): void {
    if (this.started) return;
    const seat = this.seats.get(from);
    if (!seat) return;
    seat.raceJson = msg.raceJson;
    seat.ready = msg.ready;
    if (msg.name) seat.name = msg.name;
    this.broadcastLobby();
  }

  updateSettings(settings: GameSettings): void {
    if (this.started) return;
    this.settings = settings;
    this.broadcastLobby();
  }

  /** Host-triggered game start; seq 0 is the game_start system command.
   * With pick bidding on, contested picks go to sealed-bid auction first. */
  startGame(seed: string): void {
    if (this.started) throw new Error('already started');
    // a re-entrant call mid-auction must not silently cancel the auction and
    // start with contested picks intact
    if (this.auction) throw new Error('pick auction in progress');
    if (this.settings.modes.pickBidding && !this.auction) {
      const contested = findContested(
        this.roster().map((p) => ({ id: p.id, raceJson: p.raceJson })),
        this.settings.pickPoints ?? 10,
      );
      const bidders = [...new Set(Object.values(contested).flat())].sort((a, b) => a - b);
      if (bidders.length > 0) {
        this.auction = {
          seed,
          contested,
          bidders,
          phase: 'commit',
          commits: new Map(),
          reveals: new Map(),
          timer: null,
        };
        this.broadcast({ t: 'auction_begin', contested, bidders, deadlineMs: AUCTION_PHASE_MS });
        this.armAuctionTimer();
        return;
      }
    }
    this.beginGame(seed, null);
  }

  private beginGame(seed: string, auctionOutcomes: AuctionOutcome[] | null): void {
    if (this.auction?.timer) clearTimeout(this.auction.timer);
    this.auction = null;
    const payload: GameStartPayload = {
      seed,
      settings: this.settings,
      players: this.roster().map((p) => ({ id: p.id, name: p.name, raceJson: p.raceJson })),
      dataVersion: this.dataVersion,
      ...(auctionOutcomes ? { auction: auctionOutcomes } : {}),
    };
    this.accept({ turn: 0, playerId: -1, kind: 'game_start', payload });
    // realtime turns: the very first clock starts at game start, before any
    // commit arrives (every later turn re-arms via broadcastCommitStatus)
    this.broadcastCommitStatus();
  }

  // ----- sealed-bid pick auction -----

  private armAuctionTimer(): void {
    if (!this.auction) return;
    if (this.auction.timer) clearTimeout(this.auction.timer);
    this.auction.timer = setTimeout(() => {
      if (!this.auction) return;
      this.auction.timer = null;
      if (this.auction.phase === 'commit') this.startRevealPhase();
      else this.finishAuction();
    }, AUCTION_PHASE_MS);
  }

  private onAuctionCommit(from: number, hash: string): void {
    if (!this.auction || this.auction.phase !== 'commit') return;
    if (!this.auction.bidders.includes(from) || this.auction.commits.has(from)) return;
    this.auction.commits.set(from, hash);
    if (this.auction.commits.size >= this.auction.bidders.length) this.startRevealPhase();
  }

  private startRevealPhase(): void {
    if (!this.auction) return;
    this.auction.phase = 'reveal';
    const hashes: Record<string, string> = {};
    for (const [id, h] of this.auction.commits) hashes[String(id)] = h;
    this.broadcast({ t: 'auction_commits', hashes, deadlineMs: AUCTION_PHASE_MS });
    this.armAuctionTimer();
  }

  private onAuctionReveal(from: number, bids: Record<string, number>, nonce: string): void {
    if (!this.auction || this.auction.phase !== 'reveal') return;
    if (!this.auction.commits.has(from) || this.auction.reveals.has(from)) return;
    this.auction.reveals.set(from, { bids, nonce });
    if (this.auction.reveals.size >= this.auction.commits.size) this.finishAuction();
  }

  private finishAuction(): void {
    if (!this.auction) return;
    const { seed, contested, commits, reveals } = this.auction;
    const result = resolveAuction({
      contested,
      pickPoints: this.settings.pickPoints ?? 10,
      players: this.roster().map((p) => ({ id: p.id, raceJson: p.raceJson })),
      reveals,
      commits,
    });
    // losers' race configs are rewritten before game_start records them
    for (const [idStr, raceJson] of Object.entries(result.players)) {
      const seat = this.seats.get(Number(idStr));
      if (seat) seat.raceJson = raceJson;
    }
    this.broadcast({ t: 'auction_result', outcomes: result.outcomes, players: result.players });
    this.beginGame(seed, result.outcomes);
  }

  // ----- sequencing -----

  private currentTurn(): number {
    return this.state ? this.engine.turnOf(this.state) : 0;
  }

  private fold(cmd: LogCommand): void {
    if (cmd.kind === 'game_start') {
      const start = cmd.payload as GameStartPayload;
      this.state = this.engine.init(start);
      this.settings = start.settings;
      this.gameId = gameIdFromSeed(start.seed); // authoritative for welcomes
      // Seat roster is part of game_start so a resumed host (fresh HostCore
      // folding the persisted log) still broadcasts to every player.
      for (const p of start.players) {
        const existing = this.seats.get(p.id);
        this.seats.set(p.id, {
          name: p.name,
          ready: true,
          raceJson: p.raceJson,
          connected: existing?.connected ?? p.id === 0,
          hello: existing?.hello ?? p.id === 0,
        });
      }
    } else if (this.state) {
      const turnBefore = this.engine.turnOf(this.state);
      this.state = this.engine.apply(this.state, cmd);
      // record the boundary hash only when the turn ACTUALLY advanced:
      // a battle-pausing advance_turn does not (resolve_combat finishes the
      // turn later). Hashing here regardless would (a) overwrite the previous
      // boundary's correct hash with a mid-battle one and (b) leave combat
      // turns with no entry at all — combat desyncs would go undetected and
      // every fresh-folding client would loop on false desync notices.
      if ((cmd.kind === 'advance_turn' || cmd.kind === 'resolve_combat') && this.state) {
        const turnAfter = this.engine.turnOf(this.state);
        if (turnAfter > turnBefore) {
          this.turnHashes.set(turnAfter - 1, this.engine.hash(this.state));
        }
      }
    }
    this.log.push(cmd);
    this.lastSeq = cmd.seq;
  }

  private accept(partial: Omit<LogCommand, 'seq'>, clientId?: string, submitter?: number): void {
    const cmd: LogCommand = { ...partial, seq: this.lastSeq + 1 };
    this.fold(cmd);
    // broadcasts drain through an ordered outbox: the host's own session (seat
    // 0) ingests first — enqueueing the write — and for TURN-ADVANCING
    // commands the drain awaits the persist barrier before any remote peer
    // sees the command. A crash between broadcast and persist used to resume
    // the host a turn behind its clients (reissued seqs, silent fork).
    this.outbox.push({ cmd, clientId, submitter });
    void this.drainOutbox();
    this.checkBattlePhase();
    // fast phase: any accepted command can create first contact (e.g. a
    // colonize at a star the other empire explored)
    if (this.fastEnabled() && !this.contactAnnounced && cmd.kind !== 'game_start') {
      this.maybeAnnounceContact();
    }
  }

  /** Ordered command broadcast with a persistence barrier for the commands
   * whose loss forks the table (turn boundaries + game_start). */
  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0 && !this.closed) {
        const { cmd, clientId, submitter } = this.outbox.shift()!;
        const accept = (id: number): HostToClient => ({
          t: 'cmd_accept',
          cmd,
          ...(id === submitter && clientId ? { clientId } : {}),
        });
        const seatIds = [...this.seats.keys()];
        // the host's own seat first: its session ingest enqueues persistence
        for (const id of seatIds) {
          if (id === 0) this.sendTo(id, accept(id));
        }
        if (this.persistBarrier && (cmd.kind === 'advance_turn' || cmd.kind === 'resolve_combat' || cmd.kind === 'game_start')) {
          try {
            // LocalHostLink delivers asynchronously. Let the host session
            // ingest and enqueue this command before capturing its flush chain.
            await Promise.resolve();
            await this.persistBarrier();
          } catch {
            // persistence failures are surfaced by the session's own chain;
            // the broadcast must not stall behind a broken store
          }
        }
        for (const id of seatIds) {
          if (id !== 0) this.sendTo(id, accept(id));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Wired by setup.ts to the host session's flush(): resolves once every
   * accepted command so far has reached durable storage. */
  setPersistBarrier(barrier: () => Promise<void>): void {
    this.persistBarrier = barrier;
  }

  /** battle_orders sub-phase driver: when resolution paused for orders, emit
   * resolve_combat once every battle has both sides' orders, or on timeout
   * (the engine substitutes defaults for missing orders). */
  private checkBattlePhase(): void {
    if (!this.state || !this.engine.pendingBattles || !this.engine.phaseOf) return;
    if (this.engine.phaseOf(this.state) !== 'battle_orders') {
      if (this.battleTimer) {
        clearTimeout(this.battleTimer);
        this.battleTimer = null;
      }
      return;
    }
    const battles = this.engine.pendingBattles(this.state);
    const allReady = battles.every((b) => b.ordersA !== null && b.ordersD !== null);
    if (allReady) {
      if (this.battleTimer) {
        clearTimeout(this.battleTimer);
        this.battleTimer = null;
      }
      this.accept({ turn: this.currentTurn(), playerId: -1, kind: 'resolve_combat', payload: {} });
      this.broadcastCommitStatus();
      return;
    }
    if (!this.battleTimer) {
      this.battleTimer = setTimeout(() => {
        this.battleTimer = null;
        if (this.state && this.engine.phaseOf && this.engine.phaseOf(this.state) === 'battle_orders') {
          this.accept({ turn: this.currentTurn(), playerId: -1, kind: 'resolve_combat', payload: {} });
          this.broadcastCommitStatus();
        }
      }, this.battleTimeoutMs());
    }
  }

  /** In realtime games the battle-orders clock is the SAME length as the
   * turn clock — a battle must never stall the cadence; missing orders fall
   * back to the engine defaults exactly like an uncommitted turn advances. */
  private battleTimeoutMs(): number {
    const rt = this.settings.realtimeTurnSeconds ?? 0;
    return rt > 0 ? rt * 1000 : this.battleOrdersTimeoutMs;
  }

  private onSubmit(from: number, msg: Extract<ClientToHost, { t: 'cmd_submit' }>): void {
    if (!this.started || !this.state) {
      return this.sendTo(from, { t: 'cmd_reject', clientId: msg.clientId, reason: 'not started' });
    }
    // fast phase: commands for turns the sim has not reached wait in the
    // buffer and are validated when their turn arrives
    if (msg.turn > this.currentTurn() && this.fastLive()) {
      return this.fastBuffer(from, msg);
    }
    const cmd: LogCommand = {
      seq: -1,
      turn: msg.turn,
      playerId: from,
      kind: msg.kind,
      payload: msg.payload,
    };
    const err = this.engine.validate(this.state, cmd);
    if (err) return this.sendTo(from, { t: 'cmd_reject', clientId: msg.clientId, reason: err });
    this.accept({ turn: msg.turn, playerId: from, kind: msg.kind, payload: msg.payload }, msg.clientId, from);
  }

  /** Seats currently committed for this turn (play-by-mail: persisted with
   * the save so commits survive between mail sessions). */
  getCommittedSeats(): number[] {
    if (this.fastLive()) {
      const turn = this.currentTurn();
      return [...this.seats.keys()].filter((id) => (this.fastCommitted.get(id) ?? -1) >= turn).sort((a, b) => a - b);
    }
    return [...this.committed].sort((a, b) => a - b);
  }

  /** Play-by-mail resume: mark seats committed (from the stored meta) so an
   * earlier player's commit still counts. Advances if that completes the
   * table. */
  seedCommitted(seatIds: number[]): void {
    if (this.fastLive()) {
      const turn = this.currentTurn();
      for (const id of seatIds) {
        if (this.seats.has(id)) this.fastCommitted.set(id, Math.max(this.fastCommitted.get(id) ?? -1, turn));
      }
      this.fastPump();
      return;
    }
    for (const id of seatIds) {
      if (this.seats.has(id)) this.committed.add(id);
    }
    this.broadcastCommitStatus();
    this.maybeAdvance();
  }

  private onCommit(from: number, turn: number, committed: boolean): void {
    if (!this.started) return;
    if (this.fastLive()) {
      // fast phase: ending a turn is final (the player's preview already
      // advanced past it) — uncommit has no meaning here
      if (!committed) return;
      if (turn > this.currentTurn() + FAST_MAX_AHEAD) return; // cap backstop
      this.fastCommitted.set(from, Math.max(this.fastCommitted.get(from) ?? -1, turn));
      this.fastPump();
      return;
    }
    if (turn !== this.currentTurn()) return;
    // during battle_orders the turn counter hasn't advanced yet: a commit
    // accepted here would survive resolve_combat and pre-commit the player
    // for a turn they never planned
    if (this.state && this.engine.phaseOf && this.engine.phaseOf(this.state) !== 'planning') return;
    if (committed) this.committed.add(from);
    else this.committed.delete(from);
    this.broadcastCommitStatus();
    this.maybeAdvance();
  }

  /** commit_status carries the auto-turn deadline when the timer is armed */
  private broadcastCommitStatus(): void {
    this.armAutoTurn();
    const remaining = this.autoTurnTimer ? Math.max(0, this.autoTurnDeadline - Date.now()) : undefined;
    this.broadcast(this.commitStatusMsg(remaining));
  }

  private commitStatusMsg(autoTurnInMs?: number): Extract<HostToClient, { t: 'commit_status' }> {
    const fast = this.fastLive();
    let fastTurns: Record<string, number> | undefined;
    if (fast && this.fastCommitted.size) {
      fastTurns = {};
      for (const [seat, t] of this.fastCommitted) fastTurns[String(seat)] = t;
    }
    return {
      t: 'commit_status',
      turn: this.currentTurn(),
      committed: this.getCommittedSeats(),
      ...(autoTurnInMs !== undefined ? { autoTurnInMs } : {}),
      ...(fastTurns ? { fastTurns } : {}),
    };
  }

  private maybeAdvance(): void {
    if (!this.state) return;
    if (this.fastLive()) return; // the fast pump owns advancement pre-contact
    if (this.engine.phaseOf && this.engine.phaseOf(this.state) !== 'planning') return;
    const seated = [...this.seats.keys()];
    if (seated.length < 1) return;
    if (!seated.every((id) => this.committed.has(id))) return;
    const turn = this.currentTurn();
    this.committed.clear();
    this.accept({
      turn,
      playerId: -1,
      kind: 'advance_turn',
      payload: this.engine.advancePayload(this.state),
    });
    this.broadcastCommitStatus();
  }

  // ----- fast start: async turns until first contact -----

  private fastEnabled(): boolean {
    return !!this.settings.fastStart;
  }

  /** True while the fast phase is running: game started, nobody has won, and
   * no two empires have met — the invariant that makes async turns sound. */
  private fastLive(): boolean {
    if (!this.fastEnabled() || !this.started || !this.state) return false;
    if (this.contactAnnounced) return false;
    if ((this.engine.winnerOf?.(this.state) ?? null) !== null) return false;
    return (this.engine.contactPairs?.(this.state) ?? []).length === 0;
  }

  /** Buffer a command for a turn the authoritative sim has not reached. */
  private fastBuffer(seat: number, msg: Extract<ClientToHost, { t: 'cmd_submit' }>): void {
    if (msg.turn > this.currentTurn() + FAST_MAX_AHEAD + 2) {
      return this.sendTo(seat, { t: 'cmd_reject', clientId: msg.clientId, reason: 'too far ahead of the slowest player' });
    }
    if (this.fastBufIds.has(msg.clientId)) return; // reconnect re-send
    this.fastBufIds.add(msg.clientId);
    const list = this.fastBuf.get(msg.turn) ?? [];
    list.push({ seat, clientId: msg.clientId, kind: msg.kind, payload: msg.payload });
    this.fastBuf.set(msg.turn, list);
  }

  /** Sequence the buffered commands for the turn the sim just reached, in
   * arrival order. Validation runs against the authoritative state; a command
   * that no longer applies (its player's preview diverged) is rejected back
   * to its submitter, never folded. */
  private drainFast(turn: number): void {
    const list = this.fastBuf.get(turn);
    if (!list || !this.state) return;
    this.fastBuf.delete(turn);
    for (const entry of list) {
      this.fastBufIds.delete(entry.clientId);
      const cmd: LogCommand = { seq: -1, turn, playerId: entry.seat, kind: entry.kind, payload: entry.payload };
      const err = this.engine.validate(this.state, cmd);
      if (err) {
        this.sendTo(entry.seat, { t: 'cmd_reject', clientId: entry.clientId, reason: err });
        continue;
      }
      this.accept({ turn, playerId: entry.seat, kind: entry.kind, payload: entry.payload }, entry.clientId, entry.seat);
    }
  }

  /** The fast-phase engine room: advance the authoritative sim as far as the
   * slowest player's commits allow, auto-resolving NPC battles, draining each
   * turn's buffered commands as the sim arrives there, and stopping cold the
   * moment two empires meet (or someone wins). */
  private fastPump(): void {
    if (!this.state) return;
    let guard = 0;
    while (guard++ < 1000) {
      if (!this.fastLive()) break;
      if (this.engine.phaseOf && this.engine.phaseOf(this.state) === 'battle_orders') {
        // pre-contact battles only ever involve NPCs on one side: resolve
        // immediately with default orders (the engine substitutes them)
        this.accept({ turn: this.currentTurn(), playerId: -1, kind: 'resolve_combat', payload: {} });
        continue; // re-check contact/victory after the resolution folds
      }
      const turn = this.currentTurn();
      this.drainFast(turn);
      if (!this.fastLive()) break; // a drained command can create contact
      const seated = [...this.seats.keys()];
      if (!seated.length || !seated.every((id) => (this.fastCommitted.get(id) ?? -1) >= turn)) break;
      this.accept({
        turn,
        playerId: -1,
        kind: 'advance_turn',
        payload: this.engine.advancePayload(this.state),
      });
    }
    this.maybeAnnounceContact();
    this.broadcastCommitStatus();
  }

  /** One-time CONTACT transition: discard everything speculative (the rewind)
   * and hand the table back to classic lockstep at the current turn. */
  private maybeAnnounceContact(): void {
    if (this.contactAnnounced || !this.fastEnabled() || !this.state || !this.started) return;
    const pairs = this.engine.contactPairs?.(this.state) ?? [];
    const winner = this.engine.winnerOf?.(this.state) ?? null;
    if (!pairs.length && winner === null) return;
    this.contactAnnounced = true;
    this.fastBuf.clear();
    this.fastBufIds.clear();
    this.fastCommitted.clear();
    this.committed.clear();
    if (pairs.length) {
      this.broadcast({ t: 'contact_notice', turn: this.currentTurn(), pairs });
    }
  }

  /** Auto-turn timer: once every seat except one has committed, the table
   * only waits settings.autoTurnSeconds for the laggard — then the host
   * advances the turn without them (their next-turn planning is unharmed;
   * turns always advance ONE at a time). */
  private armAutoTurn(): void {
    // realtime mode: the clock starts the moment the turn opens and waits
    // for nobody (bugs.md); otherwise the classic laggard timer arms only
    // once every seat except one has committed
    const realtimeSecs = this.settings.realtimeTurnSeconds ?? 0;
    const realtime = realtimeSecs > 0;
    const secs = realtime ? realtimeSecs : (this.settings.autoTurnSeconds ?? 0);
    const seats = [...this.seats.keys()];
    const committed = seats.filter((id) => this.committed.has(id)).length;
    const eligible =
      secs > 0 &&
      // fast phase: nobody waits on anybody, so force-advancing a laggard
      // would only corrupt their own-turn planning
      !this.fastLive() &&
      !!this.state &&
      // a decided game must not keep ticking: realtime re-arms after every
      // advance, so without this a finished game would advance forever
      (this.engine.winnerOf?.(this.state!) ?? null) === null &&
      (!this.engine.phaseOf || this.engine.phaseOf(this.state) === 'planning') &&
      seats.length >= 2 &&
      (realtime || committed >= seats.length - 1) &&
      committed < seats.length;
    if (!eligible) {
      if (this.autoTurnTimer) {
        clearTimeout(this.autoTurnTimer);
        this.autoTurnTimer = null;
      }
      return;
    }
    // already armed THIS turn: a committed player re-sending commit_turn must
    // NOT keep pushing the deadline out. A leftover timer from the previous
    // turn (realtime re-arms every turn) restarts fresh instead.
    if (this.autoTurnTimer) {
      if (this.autoTurnArmedTurn === this.currentTurn()) return;
      clearTimeout(this.autoTurnTimer);
      this.autoTurnTimer = null;
    }
    this.autoTurnArmedTurn = this.currentTurn();
    this.autoTurnDeadline = Date.now() + secs * 1000;
    this.autoTurnTimer = setTimeout(() => {
      this.autoTurnTimer = null;
      if (!this.state) return;
      if ((this.engine.winnerOf?.(this.state) ?? null) !== null) return; // game ended meanwhile
      if (this.engine.phaseOf && this.engine.phaseOf(this.state) !== 'planning') return;
      const now = [...this.seats.keys()];
      const done = now.filter((id) => this.committed.has(id)).length;
      // classic mode advances only if the table is still one short;
      // realtime advances regardless — the deadline is the deadline
      if (!realtime && done < now.length - 1) return;
      if (done >= now.length) return; // everyone committed: normal advance already ran
      const turn = this.currentTurn();
      this.committed.clear();
      this.accept({
        turn,
        playerId: -1,
        kind: 'advance_turn',
        payload: this.engine.advancePayload(this.state!),
      });
      this.broadcastCommitStatus();
    }, secs * 1000);
  }

  private onHashReport(from: number, msg: Extract<ClientToHost, { t: 'hash_report' }>): void {
    // a report for a turn we have not completed means the client runs a
    // different (longer) history — the fork tripwire the freeze bugs lacked.
    // In-sync clients always report turn-1 of a boundary we folded FIRST.
    if (this.state && msg.turn >= this.currentTurn()) {
      this.sendTo(from, { t: 'desync_notice', turn: msg.turn, expected: '' });
      return;
    }
    const expected = this.turnHashes.get(msg.turn);
    if (expected && expected !== msg.hash) {
      this.sendTo(from, { t: 'desync_notice', turn: msg.turn, expected });
    }
  }

  private sendResync(to: number, haveSeq: number): void {
    // Phase 2: command tail only; snapshot-based fast resync arrives with the
    // real engine (session snapshots exist; host serves tail which is correct
    // regardless, just less efficient for very long games).
    const commands = this.log.filter((c) => c.seq > haveSeq);
    this.sendTo(to, { t: 'resync_data', snapshot: null, commands });
  }

  private onChat(from: number, msg: Extract<ClientToHost, { t: 'chat_send' }>): void {
    const text = msg.text.slice(0, 2000);
    if (!text) return;
    const deliver: HostToClient = {
      t: 'chat_deliver',
      id: ++this.chatSeq,
      turn: this.currentTurn(),
      from,
      to: msg.to,
      text,
    };
    if (msg.to === -1) this.broadcast(deliver);
    else {
      this.sendTo(msg.to, deliver);
      if (msg.to !== from) this.sendTo(from, deliver);
    }
  }
}
