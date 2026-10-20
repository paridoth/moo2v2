import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { observeEmpire } from '@ai/observation';
import { expanderStrategy } from '@ai/strategy';
import { strategistStrategy } from '@ai/strategist';
import { admiralStrategy } from '@ai/admiral';
import { galaxyView } from '@engine/selectors';

function scenario() {
  return createGameEngine().init({ seed: '0123456789abcdef0123456789abcdef',
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'large', playerCount: 3 },
    players: [0, 1, 2].map((id) => ({ id, name: `Empire ${id}`, raceJson: null })), dataVersion: 'test' });
}

describe('AI empire observation privacy', () => {
  it('contains only discovered colony identities and scanned/visited ships, never private enemy economy or research', () => {
    const state = scenario();
    const view = galaxyView(state, 0);
    const enemyHome = state.colonies.find((c) => c.owner === 1)!;
    const homeStar = state.planets.find((p) => p.id === enemyHome.planetId)!.starId;
    expect(view.find((v) => v.star.id === homeStar)!.explored).toBe(false);
    expect(view.find((v) => v.star.id === homeStar)!.scanned).toBe(false);
    const before = observeEmpire(state, 0);
    const hidden = before.systems.find((s) => s.id === homeStar)!;
    expect(hidden.planets).toEqual([]);
    expect(hidden.colonies).toEqual([]);
    expect(hidden.ships).toEqual([]);
    const changed = structuredClone(state);
    const enemy = changed.empires.find((e) => e.id === 1)!;
    enemy.bc = 999999;
    enemy.knownApps.push('death_ray');
    enemy.designs[0]!.name = 'SECRET DESIGN';
    const colony = changed.colonies.find((c) => c.id === enemyHome.id)!;
    colony.groups[0]!.popK += 9000;
    colony.queue = [{ item: 'spy' }];
    colony.buildings.push('robo_miner_plant');
    changed.ships.push({ ...structuredClone(changed.ships.find((s) => s.owner === 1)!), id: 99999 });
    expect(observeEmpire(changed, 0)).toEqual(before);
    expect(expanderStrategy.plan(observeEmpire(changed, 0), { difficulty: 'normal', personality: 'balanced' }))
      .toEqual(expanderStrategy.plan(before, { difficulty: 'normal', personality: 'balanced' }));
    expect(strategistStrategy.plan(observeEmpire(changed, 0), { difficulty: 'normal', personality: 'balanced' }))
      .toEqual(strategistStrategy.plan(before, { difficulty: 'normal', personality: 'balanced' }));
    expect(admiralStrategy.plan(observeEmpire(changed, 0), { difficulty: 'normal', personality: 'balanced' }))
      .toEqual(admiralStrategy.plan(before, { difficulty: 'normal', personality: 'balanced' }));
  });

  it('withholds live enemy activity at explored systems outside current scanners', () => {
    const state = scenario();
    const enemyHome = state.colonies.find((c) => c.owner === 1)!;
    const starId = state.planets.find((p) => p.id === enemyHome.planetId)!.starId;
    state.empires[0]!.exploredStars.push(starId);
    const o = observeEmpire(state, 0);
    const system = o.systems.find((s) => s.id === starId)!;
    expect(system.explored).toBe(true);
    expect(system.planets.length).toBeGreaterThan(0);
    expect(system.colonies).toEqual([]);
    expect(system.ships).toEqual([]);
    expect(o.contacts.some((c) => c.id === 1)).toBe(false);
    // Even a newly founded enemy colony in a previously surveyed system must
    // not change the policy's knowledge without a new scan.
    const changed = structuredClone(state);
    changed.colonies = changed.colonies.filter((c) => c.id !== enemyHome.id);
    changed.ships = changed.ships.filter((s) => s.owner !== 1);
    expect(observeEmpire(changed, 0)).toEqual(o);
  });

  it('reveals discovered identities, withholds colony internals and enemy ships in transit, and detaches all references', () => {
    const state = scenario();
    const enemyHome = state.colonies.find((c) => c.owner === 1)!;
    const starId = state.planets.find((p) => p.id === enemyHome.planetId)!.starId;
    state.empires[0]!.exploredStars.push(starId);
    state.ships.find((s) => s.owner === 0)!.location = { kind: 'star', starId };
    const ship = state.ships.find((s) => s.owner === 1)!;
    ship.location = { kind: 'transit', from: starId, to: state.stars[0]!.id, departedTurn: 1, arrivalTurn: 9 };
    const o = observeEmpire(state, 0);
    const visible = o.systems.find((s) => s.id === starId)!;
    expect(visible.colonies).toContainEqual({ id: enemyHome.id, owner: 1, outpost: false });
    expect(visible.ships.some((s) => s.id === ship.id)).toBe(false);
    expect(o.contacts.some((c) => c.id === 1)).toBe(true);
    expect(JSON.stringify(o)).not.toContain('SECRET');
    const bc = state.empires[0]!.bc;
    o.self.bc = -100;
    o.colonies[0]!.buildings.push('TEST');
    expect(state.empires[0]!.bc).toBe(bc);
    expect(state.colonies.some((c) => c.buildings.includes('TEST'))).toBe(false);
    expect(visible).not.toHaveProperty('wormholeTo');
    expect(visible.colonies[0]).not.toHaveProperty('groups');
  });

  it('keeps v2 strength and decisions invariant to private internals even for scanned enemy hulls', () => {
    const state = scenario();
    const enemyHome = state.colonies.find((c) => c.owner === 1)!;
    const starId = state.planets.find((p) => p.id === enemyHome.planetId)!.starId;
    state.ships.find((s) => s.owner === 0)!.location = { kind: 'star', starId };
    state.empires[0]!.exploredStars.push(starId);
    const before = observeEmpire(state, 0);
    const changed = structuredClone(state);
    const enemy = changed.empires.find((e) => e.id === 1)!;
    enemy.bc = 999999; enemy.knownApps.push('death_ray');
    for (const d of enemy.designs) { d.name = 'SECRET'; d.weapons = []; d.computer = 5; }
    const c = changed.colonies.find((c) => c.id === enemyHome.id)!;
    c.groups[0]!.popK = 30000; c.marines = 100; c.buildings = ['star_fortress']; c.queue = [{ item: 'spy' }];
    for (const f of changed.ships.filter((f) => f.owner === 1)) f.dmgStructure = 999;
    expect(observeEmpire(changed, 0)).toEqual(before);
    expect(strategistStrategy.plan(observeEmpire(changed, 0), { difficulty: 'normal', personality: 'militarist' }))
      .toEqual(strategistStrategy.plan(before, { difficulty: 'normal', personality: 'militarist' }));
    expect(admiralStrategy.plan(observeEmpire(changed, 0), { difficulty: 'normal', personality: 'militarist' }))
      .toEqual(admiralStrategy.plan(before, { difficulty: 'normal', personality: 'militarist' }));
  });
});
