import type { AiCommand, EmpireObservation } from './types';
import type { StrategicAssessment } from './assessment';
import { attackRequirement, fleetStrength, hostileStrength } from './strength';
import { planFleets } from './strategy';

type Fleet = EmpireObservation['fleets'][number];
const canReach = (f: Fleet, id: number) => f.atStarId === id || f.moves.some((m) => m.starId === id && m.reachable);
const eta = (f: Fleet, id: number) => f.atStarId === id ? 0 : f.moves.find((m) => m.starId === id)?.turns ?? 10000;

export function planOperations(o: EmpireObservation, a: StrategicAssessment): AiCommand[] {
  const out: AiCommand[] = [];
  const available = new Map(o.fleets.filter((f) => f.atStarId !== null && (f.kind === 'design'
    || (f.kind === 'transport' && (f.ship.marines ?? 0) > 0))).map((f) => [f.ship.id, f]));
  const move = (ships: Fleet[], destStarId: number) => {
    const moving = ships.filter((f) => f.atStarId !== destStarId && canReach(f, destStarId));
    // A command can only combine ships parked at the same origin.
    const origins = [...new Set(moving.map((f) => f.atStarId!))].sort((x, y) => x - y);
    for (const origin of origins) {
      const shipIds = moving.filter((f) => f.atStarId === origin).map((f) => f.ship.id).sort((x, y) => x - y);
      out.push({ kind: 'move_ships', payload: { shipIds, destStarId } });
    }
    ships.forEach((f) => available.delete(f.ship.id));
  };
  // Reserve defenders, count accepted in-flight reinforcements, then send the
  // nearest available groups. A ship is allocated to at most one operation.
  for (const id of a.threatened) {
    const s = o.systems.find((s) => s.id === id)!;
    let strength = o.fleets.filter((f) => f.transit?.toStarId === id).reduce((n, f) => n + fleetStrength(o, f), 0);
    const needed = Math.ceil(hostileStrength(o, s) * 3 / 2);
    const candidates = [...available.values()].filter((f) => f.kind === 'design' && canReach(f, id))
      .sort((x, y) => eta(x, id) - eta(y, id) || x.ship.id - y.ship.id);
    const defenders: Fleet[] = [];
    for (const f of candidates) {
      if (strength >= needed && f.atStarId !== id) break;
      defenders.push(f); strength += fleetStrength(o, f);
    }
    move(defenders, id);
  }

  const target = o.systems.find((s) => s.id === a.target);
  if (target && !a.threatened.length && a.goal !== 'recover') {
    const required = attackRequirement(o, target);
    const forces = [...available.values()].filter((f) => canReach(f, target.id));
    const atTarget = o.fleets.filter((f) => f.atStarId === target.id).reduce((n, f) => n + fleetStrength(o, f), 0);
    const origins = [...new Set(forces.map((f) => f.atStarId!))].map((id) => ({
      id, ships: forces.filter((f) => f.atStarId === id),
      strength: forces.filter((f) => f.atStarId === id).reduce((n, f) => n + fleetStrength(o, f), 0),
    })).sort((x, y) => y.strength - x.strength || x.id - y.id);
    // Keep the expedition together until a conservative escort and three full
    // marine squads can depart in one order. Never use civilian cargo as troops.
    const launch = origins.find((g) => g.id !== target.id && g.strength + atTarget >= required
      && g.ships.reduce((n, f) => n + (f.ship.marines ?? 0), 0) >= 12);
    if (launch) move(launch.ships, target.id);
    else {
      const anchor = origins.find((g) => g.id !== target.id && !o.systems.find((s) => s.id === g.id)?.guarded
        && !hostileStrength(o, o.systems.find((s) => s.id === g.id)!));
      if (anchor) move(forces.filter((f) => f.atStarId !== target.id && canReach(f, anchor.id)), anchor.id);
    }
  }

  // Civilian destinations are reserved by existing transit orders too; two
  // settlers should not spend several turns chasing the same single planet.
  const reserved = new Set(o.fleets.filter((f) => f.transit && ['scout', 'colony_ship', 'outpost_ship'].includes(f.kind))
    .map((f) => f.transit!.toStarId));
  const civilians = o.fleets.filter((f) => ['scout', 'colony_ship', 'outpost_ship'].includes(f.kind))
    .sort((x, y) => x.ship.id - y.ship.id)
    .map((f) => {
      const unsafe = o.systems.some((s) => s.id === f.atStarId && (s.guarded || hostileStrength(o, s) > 0));
      return { ...f, canColonizeHere: unsafe ? [] : f.canColonizeHere,
        canOutpostHere: unsafe ? [] : f.canOutpostHere,
        moves: f.moves.filter((m) => !reserved.has(m.starId)) };
    });
  out.push(...planFleets({ ...o, fleets: civilians }));
  return out;
}
