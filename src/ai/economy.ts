import type { AiCommand, EmpireObservation, StrategyContext } from './types';
import type { StrategicAssessment } from './assessment';
import { fleetStrength } from './strength';

const INFRASTRUCTURE = ['automated_factory', 'research_lab', 'hydroponic_farm', 'soil_enrichment',
  'pollution_processor', 'robo_miner_plant', 'supercomputer', 'population_growth_center',
  'stock_exchange', 'holo_simulator', 'habitat_domes'];

export function planStrategicEconomy(o: EmpireObservation, ctx: StrategyContext, a: StrategicAssessment): AiCommand[] {
  const out: AiCommand[] = [];
  const colonies = o.colonies.filter((c) => !c.outpost).sort((x, y) => y.output.prod - x.output.prod || x.id - y.id);
  const yards = new Set(colonies.slice(0, Math.max(1, Math.ceil(colonies.length / 3))).map((c) => c.id));
  let headroom = o.summary.cpSources - o.summary.cpUsage;
  let navy = o.fleets.reduce((n, f) => n + fleetStrength(o, f), 0);
  let settlers = o.fleets.filter((f) => f.kind === 'colony_ship').length;
  let transports = o.fleets.filter((f) => f.kind === 'transport' && (f.ship.marines ?? 0) > 0).length;
  let freighters = 0;
  for (const c of colonies) for (const item of c.queue) {
    const d = o.designs.find((d) => item === `design:${d.id}`);
    if (d) { headroom -= d.cp; navy += d.strength; }
    if (item === 'colony_ship') settlers++;
    if (item === 'transport') transports++;
    if (item === 'freighter_fleet') freighters++;
  }
  let budget = o.self.bc - a.reserve;
  for (const c of colonies) {
    // The trusted forecast respects native/android restrictions and preserves
    // food reserves plus cybernetic production upkeep before research jobs.
    const groups = c.strategicJobs;
    if (groups.some((g) => {
      const old = c.groups.find((x) => x.race === g.race);
      return old && (old.farmers !== g.farmers || old.workers !== g.workers || old.scientists !== g.scientists);
    })) out.push({ kind: 'set_jobs', payload: { colonyId: c.id, groups } });

    if (c.queue.length === 0 || ['trade_goods', 'housing'].includes(c.queue[0]!)) {
      const eta = (item: string) => Math.max(1, Math.ceil(((c.buildCosts[item] ?? 10000) - c.storedProd) / Math.max(1, c.output.prod)));
      const candidates: Array<{ item: string; score: number }> = [];
      const add = (item: string, value: number) => {
        if (c.buildable.includes(item)) candidates.push({ item, score: Math.floor(value * 1000 / (eta(item) + 4)) });
      };
      for (const [i, item] of INFRASTRUCTURE.entries()) add(item, 180 - i * 7);
      if (c.output.pollution > c.output.prod / 3) add('pollution_processor', 350);
      if (c.foodLack > 0 || o.summary.foodNet < 1) { add('hydroponic_farm', 500); add('soil_enrichment', 400); }
      if (headroom < 2) add('star_base', 350);
      if (yards.has(c.id) && transports < a.desiredTransports) {
        add('marine_barracks', 240);
        if (navy >= a.desiredStrength / 2) add('transport', 600);
      }
      if (o.summary.freightersNeeded > o.summary.freightersFree && !freighters) add('freighter_fleet', 1500);
      if (a.goal === 'expand' && settlers < (ctx.personality === 'expander' ? 3 : 2)) {
        // Mature industry launches settlers; small colonies develop first.
        add('colony_ship', c.buildings.includes('automated_factory') ? 650 : 120);
      }
      if (yards.has(c.id) && navy < a.desiredStrength && (ctx.difficulty !== 'easy' || a.threatened.length)) {
        const designs = o.designs.filter((d) => d.cp <= headroom && d.strength > 0 && c.buildable.includes(`design:${d.id}`))
          .sort((x, y) => {
            const efficiency = (d: typeof x) => Math.floor(d.strength * 1000 / (eta(`design:${d.id}`) + 4));
            return efficiency(y) - efficiency(x) || x.id - y.id;
          });
        const d = designs[0];
        if (d) add(`design:${d.id}`, a.threatened.length ? 2200 : a.target !== null || a.preparingWar ? 1100 : 500);
      }
      if (a.goal === 'recover' && o.summary.bcDelta < 0) add('trade_goods', 5000);
      candidates.sort((x, y) => y.score - x.score || (x.item < y.item ? -1 : x.item > y.item ? 1 : 0));
      const item = candidates[0]?.item ?? 'trade_goods';
      if (c.buildable.includes(item) && c.queue[0] !== item) {
        out.push({ kind: 'set_build_queue', payload: { colonyId: c.id, items: [item] } });
        const d = o.designs.find((d) => item === `design:${d.id}`);
        if (d) { headroom -= d.cp; navy += d.strength; }
        if (item === 'colony_ship') settlers++;
        if (item === 'transport') transports++;
        if (item === 'freighter_fleet') freighters++;
      }
    }
    if (ctx.difficulty === 'normal' && a.goal !== 'recover' && c.canBuy && c.buyPrice !== null
      && c.buyPrice > 0 && c.buyPrice <= budget && c.storedProd > 0 && (c.turnsLeft ?? 0) > 3) {
      out.push({ kind: 'buy_production', payload: { colonyId: c.id } });
      budget -= c.buyPrice;
    }
  }
  const tax = o.self.bc + o.summary.bcDelta * 4 < a.reserve / 2 && o.summary.bcDelta < 0 ? 20
    : o.self.bc > a.reserve * 2 ? 0 : o.self.taxRatePct ?? 0;
  if (tax !== (o.self.taxRatePct ?? 0)) out.push({ kind: 'set_tax_rate', payload: { pct: tax } });
  return out;
}
