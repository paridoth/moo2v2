import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import type { GameState } from '@engine/types';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { observeEmpire } from '@ai/observation';
import { assessEmpire } from '@ai/assessment';
import { planNavalDesigns, planNavalRefits, navalProductionView } from '@ai/modernization';
import { admiralStrategy } from '@ai/admiral';
import { policyFor } from '@ai/policies';
import type { AiCommand, StrategyContext } from '@ai/types';
import { designLoadoutKey } from '@engine/shipdesign';

const ctx: StrategyContext = { difficulty: 'normal', personality: 'militarist' };
const engine = createGameEngine();
function scenario(startMode: 'pre_warp' | 'average' | 'advanced' = 'average') {
  const s = engine.init({ seed: '0123456789abcdef0123456789abcdef',
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', playerCount: 2, startMode },
    players: [0, 1].map((id) => ({ id, name: `Empire ${id}`, raceJson: JSON.stringify({ presetId: 'solari' }) })), dataVersion: 'test' });
  s.empires[0]!.bc = 500;
  return s;
}
function apply(s: GameState, c: AiCommand) {
  const command = { ...c, playerId: 0, seq: 1, turn: s.turn };
  expect(engine.validate(s, command)).toBeNull();
  return engine.apply(s, command);
}
function createDesigns(state: GameState) {
  for (let i = 0; i < 12; i++) {
    const o = observeEmpire(state, 0);
    const c = planNavalDesigns(o, ctx, assessEmpire(o, ctx))[0];
    if (!c) return state;
    state = apply(state, c);
  }
  throw new Error('design planning failed to settle');
}
function refitScenario() {
  const s = scenario();
  const o = observeEmpire(s, 0);
  const t = o.naval.templates.find((t) => t.role === 'escort')!;
  const old = { ...structuredClone(s.empires[0]!.designs.find((d) => d.hull === 'frigate')!),
    id: 91000, name: 'Old escort', auto: false };
  const upgrade = { ...structuredClone(t.design), id: 91001, obsolete: false };
  s.empires[0]!.designs.push(old, upgrade);
  const c = s.colonies.find((c) => c.owner === 0)!;
  c.buildings.push('automated_factory'); c.queue = []; c.storedProd = 0;
  const starId = s.planets.find((p) => p.id === c.planetId)!.starId;
  s.ships.push({ id: 92000, owner: 0, shipKind: 'design', designId: old.id, location: { kind: 'star', starId },
    cargoPopUnits: 0, cargoRace: 0, dmgArmor: 0, dmgStructure: 0 });
  return { state: s, colonyId: c.id, shipId: 92000, upgradeId: upgrade.id, starId };
}

describe('Orion naval modernization', () => {
  it.each(['pre_warp', 'average', 'advanced'] as const)('generates legal researched designs and settles without duplicate slots: %s', (mode) => {
    let s = scenario(mode);
    if (mode === 'pre_warp') {
      expect(observeEmpire(s, 0).naval.templates).toEqual([]);
      return;
    }
    s.empires[0]!.knownApps.push('reinforced_hull', 'battle_pods', 'ecm_jammer', 'heavy_armor');
    s = createDesigns(s);
    const managed = s.empires[0]!.designs.filter((d) => !d.auto && !d.obsolete);
    expect(managed.map((d) => d.name).sort()).toEqual(['Orion Assault', 'Orion Escort']);
    expect(managed.every((d) => d.weapons.length > 0 && d.specials.includes('reinforced_hull'))).toBe(true);
    const o = observeEmpire(s, 0);
    expect(planNavalDesigns(o, ctx, assessEmpire(o, ctx))).toEqual([]);
    expect(policyFor('strategist-v3')).toBe(admiralStrategy);
  });

  it('refreshes managed fits without cancelling a queued hull or touching unrelated designs', () => {
    let s = createDesigns(scenario());
    const old = s.empires[0]!.designs.find((d) => d.name === 'Orion Escort')!;
    const c = s.colonies.find((c) => c.owner === 0)!;
    c.queue = [{ item: `design:${old.id}` }]; c.storedProd = 20;
    s.empires[0]!.knownApps.push('reinforced_hull');
    s = createDesigns(s);
    expect(s.empires[0]!.designs.find((d) => d.id === old.id)!.obsolete).toBe(false);
    expect(s.colonies.find((x) => x.id === c.id)!.queue).toEqual([{ item: `design:${old.id}` }]);
    expect(s.colonies.find((x) => x.id === c.id)!.storedProd).toBe(20);
    s.colonies.find((x) => x.id === c.id)!.queue = [];
    s = createDesigns(s);
    expect(s.empires[0]!.designs.find((d) => d.id === old.id)!.obsolete).toBe(true);
  });

  it('respects the twelve-design limit without obsoleting unrelated designs', () => {
    const s = scenario();
    const d = s.empires[0]!.designs[0]!;
    for (let i = 0; i < 12; i++) s.empires[0]!.designs.push({ ...structuredClone(d), id: 9000 + i, auto: false, name: `Custom ${i}` });
    const o = observeEmpire(s, 0);
    expect(planNavalDesigns(o, ctx, assessEmpire(o, ctx))).toEqual([]);
  });

  it('queues a useful paid refit and holds the ship at its yard across replanning', () => {
    const f = refitScenario();
    let o = observeEmpire(f.state, 0);
    const refits = planNavalRefits(o, ctx, assessEmpire(o, ctx));
    expect(refits).toContainEqual({ kind: 'set_build_queue', payload: {
      colonyId: f.colonyId, items: [`refit:${f.shipId}:${f.upgradeId}`],
    } });
    const s = apply(f.state, refits[0]!); o = observeEmpire(s, 0);
    expect(planNavalRefits(o, ctx, assessEmpire(o, ctx))).toEqual([]);
    expect(admiralStrategy.plan(o, ctx).filter((c) => c.kind === 'move_ships').some((c) =>
      (c.payload as { shipIds: number[] }).shipIds.includes(f.shipId))).toBe(false);
    // Queuing a refit never upgrades a ship or grants repairs for free.
    expect(s.ships.find((x) => x.id === f.shipId)!.designId).not.toBe(f.upgradeId);
  });

  it('does not refit under threat, in deficit, in Easy mode, or over an active project', () => {
    const f = refitScenario();
    const plans = () => { const o = observeEmpire(f.state, 0); return planNavalRefits(o, ctx, assessEmpire(o, ctx)); };
    expect(plans()).not.toEqual([]);
    f.state.empires[0]!.bc = 0; expect(plans()).toEqual([]);
    f.state.empires[0]!.bc = 500;
    const o = observeEmpire(f.state, 0);
    expect(planNavalRefits(o, { ...ctx, difficulty: 'easy' }, assessEmpire(o, ctx))).toEqual([]);
    f.state.colonies.find((c) => c.id === f.colonyId)!.queue = [{ item: 'colony_ship' }];
    expect(plans()).toEqual([]);
    f.state.colonies.find((c) => c.id === f.colonyId)!.queue = [];
    f.state.relations = [{ a: 0, b: 1, status: 'war', peaceOfferedBy: [], treaties: { nap: false, alliance: false, trade: false, research: false } }];
    f.state.ships.find((s) => s.owner === 1)!.location = { kind: 'star', starId: f.starId };
    expect(plans()).toEqual([]);
  });

  it('uses another legal yard at the same system when the first yard is busy', () => {
    const f = refitScenario();
    const c = f.state.colonies.find((c) => c.id === f.colonyId)!;
    const planet = f.state.planets.find((p) => p.id === c.planetId)!;
    f.state.planets.push({ ...structuredClone(planet), id: 93000 });
    f.state.colonies.push({ ...structuredClone(c), id: 93001, planetId: 93000 });
    c.queue = [{ item: 'colony_ship' }];
    const o = observeEmpire(f.state, 0);
    const plan = planNavalRefits(o, ctx, assessEmpire(o, ctx));
    expect(plan).toEqual([{ kind: 'set_build_queue', payload: { colonyId: 93001,
      items: [`refit:${f.shipId}:${f.upgradeId}`] } }]);
    apply(f.state, plan[0]!);
  });

  it('skips cosmetic and too-slow refits and commissions the strongest fit per hull', () => {
    const f = refitScenario();
    const o = observeEmpire(f.state, 0);
    const preferred = navalProductionView(o).colonies.find((c) => c.id === f.colonyId)!;
    expect(preferred.buildable).toContain(`design:${f.upgradeId}`);
    expect(preferred.buildable).not.toContain('design:91000');
    const old = f.state.empires[0]!.designs.find((d) => d.id === 91000)!;
    const upgrade = f.state.empires[0]!.designs.find((d) => d.id === f.upgradeId)!;
    const original = structuredClone(old);
    Object.assign(old, structuredClone(upgrade), { id: old.id });
    expect(designLoadoutKey(old)).toBe(designLoadoutKey(upgrade));
    let current = observeEmpire(f.state, 0);
    expect(planNavalRefits(current, ctx, assessEmpire(current, ctx))).toEqual([]);
    Object.assign(old, original);
    current = observeEmpire(f.state, 0);
    current.colonies.find((c) => c.id === f.colonyId)!.output.prod = 0;
    expect(planNavalRefits(current, ctx, assessEmpire(current, ctx))).toEqual([]);
  });
});
