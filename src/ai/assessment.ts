import type { EmpireObservation, StrategyContext } from './types';
import { attackRequirement, fleetStrength, hostileStrength } from './strength';

export interface StrategicAssessment {
  goal: 'recover' | 'defend' | 'expand' | 'conquer' | 'develop';
  threatened: number[];
  target: number | null;
  reserve: number;
  desiredStrength: number;
  desiredTransports: number;
  preparingWar: boolean;
}

/** Derived entirely from the current observation. No runtime-only memory is
 * needed to resume a partial turn: queues and own transit orders are durable. */
export function assessEmpire(o: EmpireObservation, ctx: StrategyContext): StrategicAssessment {
  const threatened = o.systems.filter((s) => s.colonies.some((c) => c.owner === o.self.id)
    && hostileStrength(o, s) > 0).sort((a, b) => hostileStrength(o, b) - hostileStrength(o, a) || a.id - b.id);
  const reserve = Math.max(100, o.colonies.length * 25, -o.summary.bcDelta * 6);
  const recovering = o.self.bc + o.summary.bcDelta * 4 < 0 || o.colonies.some((c) => c.foodLack > 0 || c.output.prodLack > 0);
  const targets = o.systems.filter((s) => s.inRange && !s.guarded && s.colonies.some((c) => o.enemies.includes(c.owner)));
  const score = (s: typeof targets[number]) => {
    const committed = o.fleets.filter((f) => f.transit?.toStarId === s.id).reduce((n, f) => n + fleetStrength(o, f), 0);
    const eta = Math.min(100, ...o.fleets.flatMap((f) => f.atStarId === s.id ? [0]
      : f.moves.filter((m) => m.starId === s.id && m.reachable).map((m) => m.turns)));
    return committed * 5 + s.colonies.filter((c) => o.enemies.includes(c.owner)).length * 60 - attackRequirement(o, s) - eta * 3;
  };
  targets.sort((a, b) => score(b) - score(a) || a.id - b.id);
  const target = targets[0] ?? null;
  const expansion = o.systems.some((s) => s.inRange && !s.guarded && !hostileStrength(o, s)
    && (!s.explored || s.planets.some((p) => !p.occupied)));
  const aggressive = ctx.personality === 'militarist' || ctx.personality === 'rusher';
  const prospective = !target && !o.enemies.length && aggressive && ctx.difficulty !== 'easy' && o.turn >= 40
    ? o.systems.filter((s) => s.inRange && !s.guarded).flatMap((s) => s.colonies
      .filter((c) => c.owner !== o.self.id && !o.protectedContacts.includes(c.owner)
        && o.contacts.some((p) => p.id === c.owner))
      .map((c) => attackRequirement(o, s, c.owner))).sort((x, y) => x - y)[0] : undefined;
  const desiredStrength = Math.max(ctx.difficulty === 'easy' ? 0 : o.colonies.length * (aggressive ? 30 : 16),
    ...threatened.map((s) => Math.ceil(hostileStrength(o, s) * 3 / 2)), target ? attackRequirement(o, target) * 2 : (prospective ?? 0) * 2);
  return {
    goal: threatened.length ? 'defend' : recovering ? 'recover' : target ? 'conquer' : expansion ? 'expand' : 'develop',
    threatened: threatened.map((s) => s.id), target: target?.id ?? null, reserve, desiredStrength,
    // Enemy ground strength is private. Plan a bounded expedition rather than
    // tailoring marine counts to a hidden garrison/population.
    desiredTransports: target ? Math.min(6, Math.max(3, target.colonies.filter((c) => o.enemies.includes(c.owner)).length * 3)) : prospective === undefined ? 0 : 3,
    preparingWar: prospective !== undefined,
  };
}
