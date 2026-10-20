import { designLoadoutKey } from '@engine/shipdesign';
import { parseDesignItem, parseRefitItem } from '@engine/items';
import type { AiCommand, EmpireObservation, StrategyContext } from './types';
import type { StrategicAssessment } from './assessment';

export function planNavalDesigns(o: EmpireObservation, ctx: StrategyContext, a: StrategicAssessment): AiCommand[] {
  if (ctx.difficulty === 'easy' || a.goal === 'recover') return [];
  const used = new Set(o.colonies.flatMap((c) => c.queue.flatMap((item) => {
    const id = parseDesignItem(item) ?? parseRefitItem(item)?.designId;
    return id === null || id === undefined ? [] : [id];
  })));
  const active = o.self.designs.filter((d) => !d.obsolete);
  const out: AiCommand[] = [];
  let slots = active.filter((d) => !d.auto).length;
  for (const t of o.naval.templates) {
    const key = designLoadoutKey(t.design);
    const matched = active.find((d) => d.name === t.design.name && designLoadoutKey(d) === key);
    const superseded = active.filter((d) => !d.auto && d.name === t.design.name && d.id !== matched?.id && !used.has(d.id))
      .sort((x, y) => x.id - y.id);
    // Existing builds/refits keep their exact target until completion. Old
    // ships may retain obsolete fits and upgrade later through paid refits.
    for (const d of superseded) { out.push({ kind: 'obsolete_design', payload: { designId: d.id } }); slots--; }
    if (!matched && slots < 12) { out.push({ kind: 'save_design', payload: t.design }); slots++; }
  }
  return out;
}

export function refittingShips(o: EmpireObservation): Set<number> {
  return new Set(o.colonies.flatMap((c) => c.queue.flatMap((item) => {
    const refit = parseRefitItem(item); return refit ? [refit.shipId] : [];
  })));
}

/** Prefer the strongest useful fit of each hull when commissioning a ship.
 * Keep all design records for queued CP accounting and old-ship inspection. */
export function navalProductionView(o: EmpireObservation): EmpireObservation {
  const allowed = new Set<number>();
  for (const hull of [...new Set(o.designs.map((d) => d.hull))]) {
    const designs = o.designs.filter((d) => d.hull === hull).sort((x, y) => {
      const power = (id: number) => o.naval.designs.find((d) => d.id === id)?.power ?? 0;
      return power(y.id) - power(x.id) || x.cost - y.cost || x.id - y.id;
    });
    if (designs[0]) allowed.add(designs[0].id);
  }
  return { ...o, colonies: o.colonies.map((c) => ({ ...c, buildable: c.buildable.filter((item) => {
    const id = parseDesignItem(item); return id === null || allowed.has(id);
  }) })) };
}

export function planNavalRefits(o: EmpireObservation, ctx: StrategyContext, a: StrategicAssessment): AiCommand[] {
  if (ctx.difficulty === 'easy' || a.goal === 'recover' || a.threatened.length || o.self.bc < a.reserve) return [];
  const queued = refittingShips(o);
  let capacity = Math.max(1, Math.floor(o.fleets.filter((f) => f.kind === 'design').length / 3)) - queued.size;
  if (capacity <= 0) return [];
  const choices = o.naval.refits.flatMap((r) => {
    const c = o.colonies.find((c) => c.id === r.colonyId);
    const f = o.fleets.find((f) => f.ship.id === r.shipId);
    const old = o.naval.designs.find((d) => d.id === f?.ship.designId);
    const upgraded = o.naval.designs.find((d) => d.id === r.designId);
    if (!c || !f || !old || !upgraded || queued.has(r.shipId) || f.atStarId === null
      || c.queue.some((item) => !['trade_goods', 'housing'].includes(item))) return [];
    const turns = Math.max(1, Math.ceil((r.cost - c.storedProd) / Math.max(1, c.output.prod)));
    if (turns > 6 || r.cost * 5 > upgraded.cost * 3 || upgraded.power * 4 < old.power * 5 || upgraded.power <= old.power) return [];
    return [{ ...r, score: Math.floor((upgraded.power - old.power) * 1000 / turns) }];
  }).sort((x, y) => y.score - x.score || x.cost - y.cost || x.shipId - y.shipId || x.designId - y.designId || x.colonyId - y.colonyId);
  const yards = new Set<number>();
  const out: AiCommand[] = [];
  for (const r of choices) {
    if (!capacity) break;
    if (yards.has(r.colonyId) || queued.has(r.shipId)) continue;
    out.push({ kind: 'set_build_queue', payload: { colonyId: r.colonyId, items: [`refit:${r.shipId}:${r.designId}`] } });
    yards.add(r.colonyId); queued.add(r.shipId); capacity--;
  }
  return out;
}

