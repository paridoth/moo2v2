import type { EmpireObservation } from './types';

/** Deliberately coarse hull estimates, identical for friend and foe. Enemy
 * designs, damage, weapons and research are never inspected. Safety margins
 * in operations cover some of this uncertainty; these are not combat odds. */
export function hullStrength(hull: string | null): number {
  return ({ frigate: 10, destroyer: 24, cruiser: 60, battleship: 140,
    titan: 320, doomstar: 700 } as Record<string, number>)[hull ?? ''] ?? 10;
}

export function fleetStrength(o: EmpireObservation, f: EmpireObservation['fleets'][number]): number {
  if (f.kind === 'scout') return 3;
  if (f.kind !== 'design') return 0;
  const d = o.self.designs.find((d) => d.id === f.ship.designId);
  if (!d?.weapons.some((w) => w.count > 0)) return 0;
  // Carry-over damage is own information. Do not pretend damaged ships are fresh.
  return Math.max(1, hullStrength(d.hull) - Math.floor((f.ship.dmgArmor + f.ship.dmgStructure) / 5));
}

export function hostileStrength(o: EmpireObservation, s: EmpireObservation['systems'][number], owner?: number): number {
  return s.ships.filter((f) => owner === undefined ? o.enemies.includes(f.owner) : f.owner === owner)
    .reduce((n, f) => n + (f.kind === 'design' ? hullStrength(f.hull) : f.kind === 'scout' ? 3 : 0), 0);
}

/** Bases and garrisons are hidden. Assume a defense allowance per colony,
 * even when no defending ships can currently be seen. */
export function attackRequirement(o: EmpireObservation, s: EmpireObservation['systems'][number], owner?: number): number {
  const colonies = s.colonies.filter((c) => owner === undefined ? o.enemies.includes(c.owner) : c.owner === owner);
  return Math.max(24, Math.ceil(hostileStrength(o, s, owner) * 3 / 2) + colonies.length * 40);
}
