import { canonicalStringify } from '@engine/canonical';
import type { GameState, SinglePlayerConfig } from '@engine/types';
import { GameSession } from '@protocol/session';
import type { LogCommand } from '@protocol/messages';
import { observeEmpire } from './observation';
import { policyFor } from './policies';
import type { AiCommand, StrategicPolicy } from './types';

/** One locally hosted seat. Event-driven, one in-flight command, no timers.
 * Both GameSession and HostCore validate every order. The policy only sees DTOs.
 * Completion is logged before committing, so reload only needs to recommit. */
export class LocalAiController {
  readonly seatId: number;
  readonly diagnostics = { accepted: 0, rejected: 0, bounded: 0 };
  private closed = false;
  private queued = false;
  private turn = -1;
  private committedTurn = -1;
  private attempted = new Set<string>();
  private waiting: string | null = null;
  private readonly unsub: () => void;

  constructor(
    private readonly session: GameSession<GameState>,
    private readonly config: SinglePlayerConfig,
    private readonly opponent: SinglePlayerConfig['opponents'][number],
    private readonly policy: StrategicPolicy = policyFor(opponent.strategy),
    private readonly resumeLog: readonly LogCommand[] = [],
  ) {
    this.seatId = opponent.seat;
    // Reuse command identities after an interrupted, partly submitted plan.
    const currentTurn = session.getState()?.turn;
    if (currentTurn !== undefined) {
      this.turn = currentTurn;
      for (const c of resumeLog) {
        if (c.playerId === opponent.seat && c.turn === currentTurn) this.attempted.add(this.key(c));
      }
    }
    this.unsub = session.subscribe((ev) => {
      if (ev.type === 'rejected') { this.diagnostics.rejected++; this.waiting = null; }
      this.schedule();
    });
    session.setRaceConfig(opponent.raceJson, true);
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsub();
  }

  private key(c: AiCommand): string { return `${c.kind}:${canonicalStringify(c.payload)}`; }

  private schedule(): void {
    if (this.closed || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.closed) this.pump();
    });
  }

  private send(c: AiCommand): void {
    const key = this.key(c);
    this.attempted.add(key); // before submit, which emits a synchronous state event
    const result = this.session.submit(c.kind, c.payload);
    if (result.error) {
      this.diagnostics.rejected++;
      this.schedule(); // skip the rejected intent; never retry it in this turn
    } else this.waiting = result.clientId;
  }

  private pump(): void {
    const auction = this.session.getAuction();
    if (auction?.phase === 'commit' && !auction.committed) this.session.submitBids({});
    const state = this.session.getState();
    if (!state || state.winner !== null || this.session.playerId !== this.seatId) return;
    const self = state.empires.find((e) => e.id === this.seatId);
    if (!self) return;
    if (this.session.getPendingCount() > 0) return;
    if (this.waiting) {
      this.waiting = null;
      this.diagnostics.accepted++;
    }
    if (this.turn !== state.turn) {
      this.turn = state.turn;
      this.attempted.clear();
      for (const c of this.resumeLog) {
        if (c.playerId === this.seatId && c.turn === state.turn) this.attempted.add(this.key(c));
      }
    }
    const context = { difficulty: this.config.difficulty, personality: this.opponent.personality };
    const observation = observeEmpire(state, this.seatId);
    if (state.phase === 'battle_orders') {
      const battle = observation.battles.find((b) => !b.ordered && !this.attempted.has(`battle:${b.id}`));
      if (battle) {
        this.attempted.add(`battle:${battle.id}`);
        this.send({ kind: 'battle_orders', payload: { battleId: battle.id, orders: this.policy.battleOrders(observation, context, battle.id) } });
      }
      return;
    }
    const votes = state.timelapseVotes ?? [];
    if (votes.length && !votes.includes(this.seatId) && !this.attempted.has('timelapse')) {
      this.attempted.add('timelapse');
      this.send({ kind: 'timelapse_vote', payload: {} });
      return;
    }
    if (this.committedTurn === state.turn) return;
    // Classic flow: the human finishes first, then the computers act. A
    // completed saved plan can recommit immediately after a host restart.
    if (self.aiTurnCompleted === state.turn || self.eliminated) {
      this.committedTurn = state.turn;
      this.session.commitTurn();
      return;
    }
    if (!this.session.getCommitted().includes(this.config.humanSeat)
      && (this.session.getFastTurns()[String(this.config.humanSeat)] ?? 0) < state.turn) return;
    const maxOrders = Math.min(512, 32 + observation.colonies.length * 8 + observation.fleets.length * 3);
    const commands = this.attempted.size >= maxOrders ? [] : this.policy.plan(observation, context);
    if (this.opponent.shipStyle && self.shipStyle !== this.opponent.shipStyle) {
      commands.unshift({ kind: 'set_ship_style', payload: { style: this.opponent.shipStyle } });
    }
    const next = commands.find((c) => !this.attempted.has(this.key(c)));
    if (next) this.send(next);
    else {
      if (this.attempted.size >= maxOrders) this.diagnostics.bounded++;
      const marker = { kind: 'ai_turn_complete', payload: {} };
      if (!this.attempted.has(this.key(marker))) this.send(marker);
      else {
        // If even the marker was rejected, don't spin or stall the human.
        this.committedTurn = state.turn;
        this.session.commitTurn();
      }
    }
  }
}
