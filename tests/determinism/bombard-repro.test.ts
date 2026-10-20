// Regression for bugs/moo2v2-314-turn204.moo2save: a beam fleet (6 destroyers
// + scout) wins a walkover at Indi with bombard ordered. Under the MOO2
// strategic model the beams now land real bombardment damage (half strength
// vs planets), but the target colonies hold exactly 1 pop unit and no
// buildings — the documented never-below-1-pop rule means the barrage still
// destroys nothing, and the report must say so (bombDamage > 0, popKilled 0).
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { resolveBattle, fleetBombardDamage } from '@engine/battles';
import type { GameState, PendingBattle, TurnEvent } from '@engine/types';

// The upstream bug save was never committed. A small synthetic scenario
// reproduces the same 6 beam destroyers versus an undefended 1-pop colony.
function loadState(): GameState {
  const state = createGameEngine().init({
    seed: '0123456789abcdef0123456789abcdef',
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', playerCount: 2 },
    players: [0, 1].map((id) => ({ id, name: `Empire ${id}`, raceJson: null })),
    dataVersion: 'test',
  });
  state.turn = 204;
  const target = state.colonies.find((c) => c.owner === 1)!;
  const planet = state.planets.find((p) => p.id === target.planetId)!;
  // Use the historic star ids expected by the reproduction below.
  for (const p of state.planets) if (p.starId === 8) p.starId = planet.starId;
  planet.starId = 8;
  target.groups = [{ race: 1, popK: 1000, farmers: 1, workers: 0, scientists: 0, unrest: false }];
  target.buildings = [];
  state.empires[0]!.designs = [{ id: 100, name: 'Beam destroyer', hull: 'destroyer', computer: 1, shield: 0,
    specials: [], obsolete: false,
    weapons: [{ weapon: 'laser_cannon', count: 3, mods: [] }, { weapon: 'fusion_beam', count: 1, mods: [] }],
  }];
  state.ships = Array.from({ length: 6 }, (_, i) => ({ id: 9000 + i, owner: 0, shipKind: 'design', designId: 100,
    location: { kind: 'star', starId: 12 }, cargoPopUnits: 0, cargoRace: 0, dmgStructure: 0, dmgArmor: 0,
  }));
  return state;
}

describe('bombardment by a beam-only fleet', () => {
  it('lands strategic beam damage but cannot reduce a minimum-pop colony', () => {
    const state = loadState();
    // place the Regulus fleet (6 destroyers, scout, transports) at Indi
    for (const s of state.ships) {
      if (s.owner === 0 && s.location.kind === 'star' && s.location.starId === 12) {
        s.location = { kind: 'star', starId: 8 };
      }
    }
    // 6 destroyers, each 3 lasers (avg 2.5 -> 1 vs planet after halving,
    // 2 half-points) + 1 fusion beam (avg 4 -> 2): 5 points per ship
    expect(fleetBombardDamage(state, 0, 8, 0)).toBe(30);
    const popBefore = state.colonies
      .filter((c) => state.planets.some((p) => p.id === c.planetId && p.starId === 8))
      .map((c) => c.groups.reduce((a, g) => a + g.popK, 0));
    const battle: PendingBattle = {
      id: `b${state.turn}-8-0v1`,
      starId: 8,
      attacker: 0,
      defender: 1,
      ordersA: { stance: 'charge', priority: 'nearest', retreatThresholdPct: 0, bombard: true },
      ordersD: { stance: 'hold_range', priority: 'nearest', retreatThresholdPct: 0, bombard: false },
    };
    const events: TurnEvent[] = [];
    const resolved = resolveBattle(state, battle, events);
    expect(resolved.summary.winner).toBe(0);
    const bomb = resolved.summary.bombardment as Record<string, unknown>;
    expect(bomb.bombDamage).toBe(30);
    expect(bomb.popKilled).toBe(0); // last pop unit is safe from orbit
    expect(bomb.buildingsDestroyed).toEqual([]);
    const popAfter = state.colonies
      .filter((c) => state.planets.some((p) => p.id === c.planetId && p.starId === 8))
      .map((c) => c.groups.reduce((a, g) => a + g.popK, 0));
    expect(popAfter).toEqual(popBefore);
  });
});
