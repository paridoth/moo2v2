import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@engine/adapter';
import { DEFAULT_SETTINGS } from '@protocol/messages';
import { observeEmpire } from '@ai/observation';
import { assessEmpire } from '@ai/assessment';
import { planStrategicResearch } from '@ai/research';
import { planStrategicEconomy } from '@ai/economy';
import { planOperations } from '@ai/operations';
import { strategistStrategy, planWar } from '@ai/strategist';
import { policyFor } from '@ai/policies';
import { expanderStrategy } from '@ai/strategy';
import type { EmpireObservation, StrategyContext } from '@ai/types';
import { fieldByNum } from '@engine/data/index';

const ctx: StrategyContext = { difficulty: 'normal', personality: 'balanced' };
function world() {
  const state = createGameEngine().init({ seed: '0123456789abcdef0123456789abcdef',
    settings: { ...DEFAULT_SETTINGS, galaxySize: 'small', playerCount: 2 },
    players: [0, 1].map((id) => ({ id, name: `Empire ${id}`, raceJson: null })), dataVersion: 'test' });
  const o = observeEmpire(state, 0);
  o.turn = 60; o.self.bc = 500;
  o.summary.bcDelta = 10; o.summary.cpSources = 20; o.summary.cpUsage = 0;
  o.summary.foodNet = 5; o.summary.researchPerTurn = 10;
  o.colonies = o.colonies.slice(0, 1);
  o.colonies[0]!.planet.starId = 1; o.colonies[0]!.foodLack = 0;
  o.colonies[0]!.output.prodLack = 0;
  o.systems = [1, 2, 3, 4].map((id) => ({ id, inRange: true, explored: true, guarded: false,
    colonies: id === 1 ? [{ id: o.colonies[0]!.id, owner: 0, outpost: false }]
      : id === 4 ? [{ id: 900, owner: 1, outpost: false }] : [], ships: [], planets: [] }));
  o.self.designs = [{ id: 101, name: 'Escort', hull: 'destroyer', computer: 0, shield: 0,
    specials: [], weapons: [{ weapon: 'laser_cannon', count: 2, mods: [] }], obsolete: false }];
  o.designs = [{ id: 101, hull: 'destroyer', cost: 60, cp: 1, strength: 24 }];
  o.contacts = [{ id: 1, name: 'Neighbor' }]; o.enemies = [1]; o.protectedContacts = [];
  o.fleets = []; o.battles = []; o.proposals = [];
  return o;
}
function ship(o: EmpireObservation, id: number, star: number, marines?: number) {
  const kind = marines === undefined ? 'design' : 'transport';
  const f: EmpireObservation['fleets'][number] = { ship: { id, owner: 0, shipKind: kind,
    designId: kind === 'design' ? 101 : null, location: { kind: 'star', starId: star },
    cargoPopUnits: 0, cargoRace: 0, dmgStructure: 0, dmgArmor: 0, ...(marines === undefined ? {} : { marines }) },
    kind, name: kind, location: 'Here', atStarId: star, etaTurns: null, transit: null, reroutable: false,
    canColonizeHere: [], canOutpostHere: [], canConstructHere: [], canLoadFromColonyId: null, canUnloadToColonyId: null,
    moves: o.systems.filter((s) => s.id !== star).map((s) => ({ starId: s.id, name: 'There', distanceCp: 100,
      turns: 1, reachable: true })) };
  o.fleets.push(f);
  return f;
}
const moves = (o: EmpireObservation) => planOperations(o, assessEmpire(o, ctx)).filter((c) => c.kind === 'move_ships');

describe('Orion strategist v2', () => {
  it('keeps the saved v1 policy and selects v2 explicitly', () => {
    expect(policyFor('expander-v1')).toBe(expanderStrategy);
    expect(policyFor('strategist-v2')).toBe(strategistStrategy);
  });

  it('rallies an insufficient expedition, then sends escorts and marine squads in one order', () => {
    const o = world();
    ship(o, 1, 1); ship(o, 2, 1); ship(o, 3, 2);
    for (const id of [4, 5, 6]) ship(o, id, 2, 4);
    expect(moves(o)).toEqual([{ kind: 'move_ships', payload: { shipIds: [3, 4, 5, 6], destStarId: 1 } }]);
    for (const f of o.fleets) { f.atStarId = 1; f.ship.location = { kind: 'star', starId: 1 }; }
    expect(moves(o)).toEqual([{ kind: 'move_ships', payload: { shipIds: [1, 2, 3, 4, 5, 6], destStarId: 4 } }]);
  });

  it('holds an outmatched force and never treats civilian cargo as marine squads', () => {
    const o = world(); ship(o, 1, 1);
    for (const id of [2, 3, 4]) ship(o, id, 1, 4);
    expect(moves(o)).toEqual([]); // 24 hull strength versus 40 assumed defense
    ship(o, 5, 1); ship(o, 6, 1);
    for (const f of o.fleets.filter((f) => f.kind === 'transport')) {
      f.ship.marines = 0; f.ship.cargoPopUnits = 2;
    }
    expect(moves(o)).toEqual([]);
  });

  it('reserves defenders and counts in-flight reinforcements before sending another group', () => {
    const o = world();
    o.systems[0]!.ships = [{ id: 99, owner: 1, kind: 'design', hull: 'destroyer' }];
    ship(o, 1, 1); ship(o, 2, 2); ship(o, 3, 3);
    expect(moves(o)).toEqual([{ kind: 'move_ships', payload: { shipIds: [2], destStarId: 1 } }]);
    const f = o.fleets[1]!;
    f.atStarId = null; f.moves = []; f.transit = { fromStarId: 2, toStarId: 1, departedTurn: 59, arrivalTurn: 61 };
    expect(moves(o)).toEqual([]);
  });

  it('requires economic readiness, visible targets, trained troops and no agreements for a new war', () => {
    const o = world(); o.enemies = [];
    const military: StrategyContext = { ...ctx, personality: 'militarist' };
    for (let id = 1; id <= 4; id++) ship(o, id, 1);
    for (let id = 5; id <= 7; id++) ship(o, id, 1, 4);
    expect(planWar(o, military)).toEqual([{ kind: 'declare_war', payload: { target: 1 } }]);
    expect(assessEmpire(o, military).desiredTransports).toBe(3);
    expect(planWar(o, { ...military, difficulty: 'easy' })).toEqual([]);
    o.protectedContacts = [1]; expect(planWar(o, military)).toEqual([]);
    o.protectedContacts = []; o.enemies = [2]; expect(planWar(o, military)).toEqual([]);
    o.enemies = []; o.summary.bcDelta = -1; expect(planWar(o, military)).toEqual([]);
    o.summary.bcDelta = 10; o.systems[3]!.colonies = []; expect(planWar(o, military)).toEqual([]);
  });

  it('uses utility and listed research cost and retains an active research investment', () => {
    const o = world(); o.self.research.fieldNum = null;
    const field = o.research[0]!.field;
    o.research = [
      { field: { ...field, num: 999 }, subject: 'computers', cost: 20, grantsAll: false,
        apps: [{ id: 'unimportant', name: 'Other', known: false, dead: false }] },
      { field: { ...field, num: 998 }, subject: 'construction', cost: 60, grantsAll: false,
        apps: [{ id: 'automated_factory', name: 'Factory', known: false, dead: false }] },
    ];
    expect(planStrategicResearch(o, ctx, assessEmpire(o, ctx))).toEqual([
      { kind: 'set_research', payload: { fieldNum: 998, targetApp: 'automated_factory' } },
    ]);
    o.self.research.fieldNum = 999;
    expect(planStrategicResearch(o, ctx, assessEmpire(o, ctx))).toEqual([]);
  });

  it('values a useful descendant when choosing between otherwise equal prerequisites', () => {
    const o = world(); o.self.research.fieldNum = null;
    o.research = [
      { field: { ...o.research[0]!.field, num: 999 }, subject: 'construction', cost: 80, grantsAll: false,
        apps: [{ id: 'unknown_prerequisite', name: 'Other', known: false, dead: false }] },
      { field: fieldByNum.get(4)!, subject: 'construction', cost: 80, grantsAll: false,
        apps: [{ id: 'unknown_prerequisite', name: 'Other', known: false, dead: false }] },
    ];
    // Field 4 unlocks Advanced Construction and its automated factory.
    expect(planStrategicResearch(o, ctx, assessEmpire(o, ctx))).toEqual([
      { kind: 'set_research', payload: { fieldNum: 4, targetApp: 'unknown_prerequisite' } },
    ]);
  });

  it('backs its own council candidacy and otherwise abstains without repeat votes', () => {
    const o = world(); o.council = { candidates: [0, 1], voted: false };
    expect(strategistStrategy.plan(o, ctx)[0]).toEqual({ kind: 'cast_vote', payload: { candidate: 0 } });
    o.council.candidates = [1, 2];
    expect(strategistStrategy.plan(o, ctx)[0]).toEqual({ kind: 'cast_vote', payload: { candidate: -1 } });
    o.council.voted = true;
    expect(strategistStrategy.plan(o, ctx).some((c) => c.kind === 'cast_vote')).toBe(false);
  });

  it('allocates military work to the strongest yard and reserves command points for queued hulls', () => {
    const o = world();
    const yard = o.colonies[0]!;
    yard.output.prod = 40; yard.buildable = ['design:101', 'research_lab', 'trade_goods'];
    yard.buildCosts = { 'design:101': 60, research_lab: 100, trade_goods: 0 };
    yard.queue = []; yard.suggestedJobs = [];
    const small = structuredClone(yard); small.id += 1; small.output.prod = 2;
    o.colonies.push(small);
    const queues = () => planStrategicEconomy(o, ctx, assessEmpire(o, ctx)).filter((c) => c.kind === 'set_build_queue');
    expect(queues()).toEqual([
      { kind: 'set_build_queue', payload: { colonyId: yard.id, items: ['design:101'] } },
      { kind: 'set_build_queue', payload: { colonyId: small.id, items: ['research_lab'] } },
    ]);
    o.summary.cpSources = 1; small.queue = ['design:101'];
    expect(queues().some((c) => (c.payload as { items: string[] }).items[0] === 'design:101')).toBe(false);
  });

  it('orders invasion only for an attacking force with marine squads at that battle', () => {
    const o = world(); for (const id of [1, 2, 3]) ship(o, id, 4, 4);
    o.battles = [{ id: 'attack', starId: 4, attacking: true, ordered: false },
      { id: 'defend', starId: 4, attacking: false, ordered: false },
      { id: 'other', starId: 3, attacking: true, ordered: false }];
    expect(strategistStrategy.battleOrders(o, ctx, 'attack').invade).toBe(true);
    expect(strategistStrategy.battleOrders(o, ctx, 'defend').invade).toBe(false);
    expect(strategistStrategy.battleOrders(o, ctx, 'other').invade).toBe(false);
    expect(strategistStrategy.battleOrders(o, ctx, 'attack').bombard).toBe(false);
    o.systems[3]!.colonies[0]!.outpost = true;
    expect(strategistStrategy.battleOrders(o, ctx, 'attack').bombard).toBe(true);
    expect(strategistStrategy.battleOrders(o, ctx, 'defend').bombard).toBe(false);
  });

  it('makes identical decisions when unordered observation lists are permuted', () => {
    const o = world(); ship(o, 1, 1); ship(o, 2, 2);
    for (const id of [3, 4, 5]) ship(o, id, 2, 4);
    const reversed = structuredClone(o);
    reversed.systems.reverse(); reversed.fleets.reverse(); reversed.colonies.reverse(); reversed.research.reverse(); reversed.designs.reverse();
    expect(strategistStrategy.plan(reversed, ctx)).toEqual(strategistStrategy.plan(o, ctx));
  });
});
