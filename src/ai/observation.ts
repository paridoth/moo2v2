import * as selectors from '@engine/selectors';
import { ANDROID_RACE, NATIVE_RACE, type GameState } from '@engine/types';
import type { EmpireObservation, JobGroups } from './types';
import { itemCost } from '@engine/items';
import { CP_USAGE } from '@engine/data/index';
import { designStats } from '@engine/shipdesign';
import { hullStrength } from './strength';
import { colonyOutput } from '@engine/economy';
import { observeNavy } from './naval-observation';

/** Own-colony forecast only. Keep a small food buffer for growth/arrivals and
 * avoid drafting cybernetic upkeep workers into farming or research. V1 keeps
 * its original lean recommendations for campaign compatibility. */
function strategicJobs(work: GameState, empireId: number, lean: Map<number, JobGroups>): Map<number, JobGroups> {
  const colonies = work.colonies.filter((c) => c.owner === empireId && !c.outpost).sort((a, b) => a.id - b.id);
  for (const c of colonies) {
    for (const g of lean.get(c.id) ?? []) Object.assign(c.groups.find((x) => x.race === g.race)!, g);
    for (let step = 0; step < 100 && colonyOutput(work, c).prodLack > 0; step++) {
      const g = c.groups.find((g) => g.race >= 0 && g.scientists > 0);
      if (!g) break;
      g.scientists--; g.workers++;
    }
  }
  const margin = Math.max(2, Math.ceil(colonies.reduce((n, c) => n + c.groups.reduce((sum, g) => sum + g.popK, 0), 0) / 15000));
  let food = colonies.reduce((n, c) => n + colonyOutput(work, c).foodNet, 0);
  for (let step = 0; step < 100 && food < margin; step++) {
    let best: { colony: typeof colonies[number]; race: number; job: 'workers' | 'scientists'; gain: number } | null = null;
    for (const c of colonies) {
      const before = colonyOutput(work, c);
      for (const g of c.groups.filter((g) => g.race >= 0)) for (const job of ['scientists', 'workers'] as const) {
        if (!g[job]) continue;
        g[job]--; g.farmers++;
        const after = colonyOutput(work, c);
        g[job]++; g.farmers--;
        const gain = after.foodNet - before.foodNet;
        if (after.prodLack <= before.prodLack && gain > (best?.gain ?? 0)) best = { colony: c, race: g.race, job, gain };
      }
    }
    if (!best) break;
    const g = best.colony.groups.find((g) => g.race === best.race)!;
    g[best.job]--; g.farmers++; food += best.gain;
  }
  return new Map(colonies.map((c) => [c.id, c.groups.filter((g) => g.race !== ANDROID_RACE)
    .map((g) => ({ race: g.race, farmers: g.farmers, workers: g.workers, scientists: g.scientists }))]));
}

/** The only AI entrypoint allowed to read authoritative state. Derived own
 * economy and movement values are legitimate; enemy internals never leave it.
 * galaxyView's raw Star/Planet objects are intentionally not forwarded. */
export function observeEmpire(state: GameState, empireId: number): EmpireObservation {
  const self = state.empires.find((e) => e.id === empireId);
  if (!self) throw new Error(`no empire ${empireId}`);
  const work = structuredClone(state);
  const mine = work.colonies.filter((c) => c.owner === empireId && !c.outpost);
  for (const c of mine) {
    const groups = selectors.presetJobs(work, c.id, 'industry');
    if (!groups) continue;
    for (const g of groups) {
      if (g.race === NATIVE_RACE) {
        g.farmers += g.workers + g.scientists;
        g.workers = g.scientists = 0;
      } else if (g.workers >= 2) {
        g.scientists = Math.max(1, Math.floor(g.workers / 3));
        g.workers -= g.scientists;
      }
      Object.assign(c.groups.find((x) => x.race === g.race)!, g);
    }
  }
  const foodJobs = selectors.fixFoodJobs(work, mine.map((c) => c.id));
  // Native jobs are fixed; leave them untouched by the flexible food solver.
  const jobs = new Map<number, JobGroups>();
  for (const c of mine) {
    jobs.set(c.id, (foodJobs.get(c.id) ?? c.groups).filter((g) => g.race !== ANDROID_RACE).map((g) => {
      if (g.race === NATIVE_RACE) {
        const original = c.groups.find((x) => x.race === NATIVE_RACE)!;
        return { race: g.race, farmers: Math.floor(original.popK / 1000), workers: 0, scientists: 0 };
      }
      return { race: g.race, farmers: g.farmers, workers: g.workers, scientists: g.scientists };
    }));
  }
  const forecast = strategicJobs(work, empireId, jobs);
  const galaxy = selectors.galaxyView(state, empireId);
  const visibleColonies = (v: typeof galaxy[number]) => v.colonies.filter((c) => c.owner === empireId || v.scanned);
  const visibleShips = (v: typeof galaxy[number]) => v.ships.filter((s) => s.owner === empireId || v.scanned);
  // Upstream explored-star views expose current foreign activity even outside
  // scanners. Do not pass that live hidden information to strategic policies.
  const met = new Set<number>([empireId]);
  for (const v of galaxy) {
    for (const c of visibleColonies(v)) met.add(c.owner);
    for (const s of visibleShips(v)) if (s.owner >= 0) met.add(s.owner);
  }
  for (const r of state.relations) {
    if (r.a === empireId) met.add(r.b);
    if (r.b === empireId) met.add(r.a);
  }
  for (const p of state.proposals) {
    if (p.to === empireId) met.add(p.from);
    if (p.from === empireId) met.add(p.to);
  }
  return structuredClone({
    turn: state.turn,
    self,
    naval: observeNavy(state, self),
    summary: selectors.empireSummary(state, empireId),
    colonies: selectors.colonyRows(state, empireId).map((r) => ({ ...r, suggestedJobs: jobs.get(r.id) ?? [], strategicJobs: forecast.get(r.id) ?? [],
      buildCosts: Object.fromEntries(r.buildable.map((item) => [item, itemCost(state, empireId, item) ?? 0])),
    })),
    designs: self.designs.filter((d) => !d.obsolete).flatMap((d) => {
      const stats = designStats(state, self, d);
      if (typeof stats === 'string') return [];
      return [{ id: d.id, hull: d.hull, cost: stats.cost, cp: CP_USAGE[d.hull] ?? 1,
        strength: d.weapons.some((w) => w.count > 0) ? hullStrength(d.hull) : 0 }];
    }),
    research: selectors.researchChoices(state, empireId),
    fleets: selectors.fleetRows(state, empireId).map((f) => ({
      ...f, moves: f.atStarId === null ? [] : selectors.moveOptions(state, empireId, f.atStarId),
    })),
    systems: galaxy.map((v) => ({
      id: v.star.id, explored: v.explored, inRange: v.inRange,
      guarded: v.scanned && state.monsters.some((m) => m.starId === v.star.id),
      planets: v.planets.filter((p) => p.body === 'planet').map((p) => ({
        id: p.id,
        quality: p.sizeClass * 10 + (p.climate === 'gaia' ? 40 : p.climate === 'terran' ? 30 : p.climate === 'ocean' ? 20 : 0)
          + (p.minerals === 'ultra_rich' ? 20 : p.minerals === 'rich' ? 10 : 0),
        occupied: visibleColonies(v).some((c) => state.colonies.find((x) => x.id === c.id)?.planetId === p.id),
      })),
      colonies: visibleColonies(v).map((c) => ({ id: c.id, owner: c.owner, outpost: c.outpost })),
      ships: visibleShips(v),
    })),
    contacts: state.empires.filter((e) => e.id !== empireId && met.has(e.id)).map((e) => ({ id: e.id, name: e.name })),
    protectedContacts: state.relations.filter((r) => (r.a === empireId || r.b === empireId)
      && Object.values(r.treaties).some(Boolean)).map((r) => r.a === empireId ? r.b : r.a),
    council: state.council.pending ? { candidates: state.council.pending.candidates,
      voted: Object.hasOwn(state.council.pending.votes, String(empireId)) } : null,
    enemies: state.relations.filter((r) => r.status === 'war' && (r.a === empireId || r.b === empireId))
      .map((r) => r.a === empireId ? r.b : r.a),
    proposals: state.proposals.filter((p) => p.to === empireId).map((p) => ({ id: p.id, from: p.from, kind: p.kind })),
    battles: state.pendingBattles.filter((b) => b.attacker === empireId || b.defender === empireId).map((b) => ({
      id: b.id, starId: b.starId, attacking: b.attacker === empireId,
      ordered: (b.attacker === empireId ? b.ordersA : b.ordersD) !== null,
    })),
  });
}
