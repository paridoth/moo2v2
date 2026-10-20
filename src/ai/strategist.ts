import type { AiCommand, EmpireObservation, StrategicPolicy, StrategyContext } from './types';
import { assessEmpire } from './assessment';
import { planStrategicResearch } from './research';
import { planStrategicEconomy } from './economy';
import { planOperations } from './operations';
import { planDiplomacy } from './strategy';
import { attackRequirement, fleetStrength } from './strength';

export function planWar(o: EmpireObservation, ctx: StrategyContext): AiCommand[] {
  // Deliberate, bounded expansion wars. Never break an agreement, open a
  // second front, or declare on an empire known only by its contact name.
  if (ctx.difficulty === 'easy' || !['militarist', 'rusher'].includes(ctx.personality)
    || o.turn < 40 || o.enemies.length || o.summary.bcDelta < 0 || o.self.bc < 150
    || o.colonies.some((c) => c.foodLack > 0)) return [];
  const troops = o.fleets.reduce((n, f) => n + (f.ship.marines ?? 0), 0);
  if (troops < 12) return [];
  const strength = o.fleets.reduce((n, f) => n + fleetStrength(o, f), 0);
  const targets = o.systems.filter((s) => s.inRange && !s.guarded).flatMap((s) => s.colonies
    .filter((c) => c.owner !== o.self.id && o.contacts.some((p) => p.id === c.owner)
      && !o.protectedContacts.includes(c.owner))
    .map((c) => ({ s, owner: c.owner, required: attackRequirement(o, s, c.owner) })))
    .filter((t) => strength >= t.required * 2 && o.fleets.some((f) => f.kind === 'design'
      && f.moves.some((m) => m.starId === t.s.id && m.reachable)))
    .sort((x, y) => x.required - y.required || x.owner - y.owner || x.s.id - y.s.id);
  return targets[0] ? [{ kind: 'declare_war', payload: { target: targets[0].owner } }] : [];
}

export const strategistStrategy: StrategicPolicy = {
  id: 'strategist-v2',
  plan(o, ctx) {
    const a = assessEmpire(o, ctx);
    const vote: AiCommand[] = o.council && !o.council.voted ? [{ kind: 'cast_vote', payload: {
      candidate: o.council.candidates.includes(o.self.id) ? o.self.id : -1,
    } }] : [];
    return [...vote, ...planStrategicResearch(o, ctx, a), ...planStrategicEconomy(o, ctx, a),
      ...planWar(o, ctx), ...planOperations(o, a), ...planDiplomacy(o)];
  },
  battleOrders(o, _ctx, id) {
    const battle = o.battles.find((b) => b.id === id);
    const troops = o.fleets.filter((f) => f.atStarId === battle?.starId).reduce((n, f) => n + (f.ship.marines ?? 0), 0);
    const colonies = o.systems.find((s) => s.id === battle?.starId)?.colonies.filter((c) => o.enemies.includes(c.owner)) ?? [];
    return { stance: battle?.attacking ? 'charge' : 'hold_range', priority: 'nearest', retreatThresholdPct: 30,
      bombard: battle?.attacking === true && colonies.length > 0 && colonies.every((c) => c.outpost),
      invade: battle?.attacking === true && troops >= 12 };
  },
};
