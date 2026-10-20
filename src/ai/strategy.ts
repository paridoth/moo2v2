// Expander baseline adapted from headless/bots.ts: feed -> build -> research
// -> explore/colonize. Components consume only the observation DTO.
import type { AiCommand, EmpireObservation, StrategicPolicy, StrategyContext } from './types';

const BUILDINGS = ['automated_factory', 'research_lab', 'hydroponic_farm', 'soil_enrichment',
  'pollution_processor', 'population_growth_center', 'star_base', 'supercomputer',
  'robo_miner_plant', 'holo_simulator', 'stock_exchange', 'habitat_domes'];

export function planResearch(o: EmpireObservation): AiCommand[] {
  const current = o.research.find((r) => r.field.num === o.self.research.fieldNum);
  if (current?.apps.some((a) => !a.known && !a.dead)) return [];
  const choice = o.research.filter((r) => r.apps.some((a) => !a.known && !a.dead))
    .sort((a, b) => a.cost - b.cost || a.field.num - b.field.num)[0];
  if (!choice) return [];
  const priorities = ['automated_factory', 'research_lab', 'hydroponic_farm', 'deuterium_fuel_cells', 'reinforced_hull'];
  const apps = choice.apps.filter((a) => !a.known && !a.dead).sort((a, b) => {
    const rank = (id: string) => priorities.includes(id) ? priorities.indexOf(id) : priorities.length;
    return rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return [{ kind: 'set_research', payload: { fieldNum: choice.field.num, targetApp: choice.grantsAll ? null : apps[0]!.id } }];
}

export function planEconomy(o: EmpireObservation, ctx: StrategyContext): AiCommand[] {
  const out: AiCommand[] = [];
  const colonies = o.colonies.filter((c) => !c.outpost);
  const settlers = o.fleets.filter((f) => f.kind === 'colony_ship').length
    + colonies.reduce((n, c) => n + c.queue.filter((q) => q === 'colony_ship').length, 0);
  const navy = o.fleets.filter((f) => f.kind === 'design').length
    + colonies.reduce((n, c) => n + c.queue.filter((q) => q.startsWith('design:')).length, 0);
  const threat = o.systems.some((s) => s.colonies.some((c) => c.owner === o.self.id)
    && s.ships.some((ship) => o.enemies.includes(ship.owner)));
  const targetFleet = Math.max(threat ? 3 : 1, Math.ceil(colonies.length * (ctx.personality === 'militarist' || ctx.personality === 'rusher' ? 1.5 : 0.5)));
  const canExpand = o.systems.some((s) => s.inRange && !s.guarded && (!s.explored || s.planets.some((p) => !p.occupied)));
  for (const c of colonies) {
    const groups = c.suggestedJobs.map((g) => {
      if (ctx.personality !== 'techer' || g.race < 0 || g.workers < 2) return g;
      return { ...g, workers: g.workers - 1, scientists: g.scientists + 1 };
    });
    const jobsChanged = groups.some((g) => {
      const old = c.groups.find((x) => x.race === g.race);
      return old && (old.farmers !== g.farmers || old.workers !== g.workers || old.scientists !== g.scientists);
    });
    if (jobsChanged) out.push({ kind: 'set_jobs', payload: { colonyId: c.id, groups } });
    if (c.queue.length === 0 || c.queue[0] === 'trade_goods' || c.queue[0] === 'housing') {
      const design = c.buildable.filter((i) => i.startsWith('design:')).sort()[0];
      const foundations = BUILDINGS.slice(0, 3).find((i) => c.buildable.includes(i));
      const building = BUILDINGS.find((i) => c.buildable.includes(i))
        ?? c.buildable.filter((i) => !i.startsWith('design:') && !['colony_ship', 'outpost_ship', 'transport', 'scout', 'spy', 'freighter_fleet', 'housing', 'trade_goods'].includes(i)).sort()[0];
      let item: string | undefined;
      if (o.summary.bcDelta < -5 && o.self.bc < 100) item = 'trade_goods';
      else if (threat && navy < targetFleet && design && o.summary.cpUsage < o.summary.cpSources) item = design;
      else if (foundations) item = foundations;
      else if (ctx.difficulty !== 'easy' && navy < Math.min(2, targetFleet) && design && o.summary.cpUsage < o.summary.cpSources) item = design;
      else if (canExpand && settlers < (ctx.personality === 'expander' ? 3 : 2) && c.buildable.includes('colony_ship')) item = 'colony_ship';
      else if (ctx.difficulty !== 'easy' && navy < targetFleet && design && o.summary.cpUsage < o.summary.cpSources) item = design;
      else item = building ?? 'trade_goods';
      if (c.buildable.includes(item) && c.queue[0] !== item) out.push({ kind: 'set_build_queue', payload: { colonyId: c.id, items: [item] } });
    }
    if (ctx.difficulty === 'normal' && c.canBuy && c.buyPrice !== null && c.buyPrice > 0
      && c.storedProd > 0 && o.self.bc - c.buyPrice >= (ctx.personality === 'industrialist' ? 100 : 150) && c.turnsLeft !== null && c.turnsLeft > 2) {
      out.push({ kind: 'buy_production', payload: { colonyId: c.id } });
    }
  }
  // Taxes and freighters use the same budget and commands as a human.
  const tax = o.self.bc < 50 && o.summary.bcDelta < 0 ? 20 : o.self.bc > 200 ? 0 : o.self.taxRatePct ?? 0;
  if (tax !== (o.self.taxRatePct ?? 0)) out.push({ kind: 'set_tax_rate', payload: { pct: tax } });
  const freightersQueued = colonies.some((c) => c.queue.includes('freighter_fleet'));
  if (o.summary.freightersNeeded > o.summary.freightersFree && !freightersQueued) {
    const yard = colonies.find((c) => c.buildable.includes('freighter_fleet'));
    if (yard) out.unshift({ kind: 'set_build_queue', payload: { colonyId: yard.id, items: ['freighter_fleet'] } });
  }
  return out;
}

export function planFleets(o: EmpireObservation): AiCommand[] {
  const out: AiCommand[] = [];
  const assigned = new Set<number>();
  for (const f of o.fleets) {
    if (f.atStarId === null) continue;
    if (f.kind === 'design' && o.systems.some((s) => s.id === f.atStarId
      && s.colonies.some((c) => c.owner === o.self.id)
      && s.ships.some((ship) => o.enemies.includes(ship.owner)))) continue;
    if (f.canColonizeHere.length) {
      const here = o.systems.find((s) => s.id === f.atStarId);
      const target = [...(here?.planets ?? [])].filter((p) => f.canColonizeHere.includes(p.id))
        .sort((a, b) => b.quality - a.quality || a.id - b.id)[0];
      if (target) out.push({ kind: 'colonize', payload: { shipId: f.ship.id, planetId: target.id } });
      continue;
    }
    if (f.canOutpostHere.length) {
      out.push({ kind: 'build_outpost', payload: { shipId: f.ship.id, planetId: f.canOutpostHere[0] } });
      continue;
    }
    const candidates = f.moves.filter((m) => m.reachable && !assigned.has(m.starId)).map((m) => ({ m, s: o.systems.find((s) => s.id === m.starId)! }))
      .filter(({ s }) => !s.guarded && (f.kind === 'design' || !s.ships.some((ship) => o.enemies.includes(ship.owner))));
    let targets = candidates.filter(({ s }) => !s.explored);
    if (f.kind === 'colony_ship') {
      const habitable = candidates.filter(({ s }) => s.planets.some((p) => !p.occupied));
      if (habitable.length) targets = habitable;
    } else if (f.kind === 'design') {
      // Defend known threatened colonies first; then attack discovered enemy systems.
      const threatened = candidates.filter(({ s }) => s.colonies.some((c) => c.owner === o.self.id)
        && s.ships.some((ship) => o.enemies.includes(ship.owner)));
      const enemy = candidates.filter(({ s }) => s.colonies.some((c) => o.enemies.includes(c.owner)));
      targets = threatened.length ? threatened : enemy;
    } else if (f.kind !== 'scout' && f.kind !== 'outpost_ship') continue;
    targets.sort((a, b) => {
      const quality = (s: typeof a.s) => Math.max(0, ...s.planets.filter((p) => !p.occupied).map((p) => p.quality));
      return (f.kind === 'colony_ship' ? quality(b.s) - quality(a.s) : 0) || a.m.turns - b.m.turns || a.m.starId - b.m.starId;
    });
    const target = targets[0];
    if (target) {
      assigned.add(target.m.starId);
      out.push({ kind: 'move_ships', payload: { shipIds: [f.ship.id], destStarId: target.m.starId } });
    }
  }
  return out;
}

export function planDiplomacy(o: EmpireObservation): AiCommand[] {
  return o.proposals.map((p) => ({ kind: 'diplo_respond', payload: {
    proposalId: p.id, accept: ['peace', 'non_aggression', 'trade', 'research', 'gift_bc'].includes(p.kind),
  } }));
}

export const expanderStrategy: StrategicPolicy = {
  id: 'expander-v1',
  plan: (o, ctx) => [...planResearch(o), ...planEconomy(o, ctx), ...planFleets(o), ...planDiplomacy(o)],
  battleOrders: (o, _ctx, battleId) => ({ stance: o.battles.find((b) => b.id === battleId)?.attacking ? 'charge' : 'hold_range',
    priority: 'nearest', retreatThresholdPct: 25, bombard: false, invade: false }),
};
