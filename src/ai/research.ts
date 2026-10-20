import { APPLICATION_ROWS, FIELD_SUBJECTS, fieldById, fieldByNum } from '@engine/data/index';
import type { AiCommand, EmpireObservation, StrategyContext } from './types';
import type { StrategicAssessment } from './assessment';

const ECONOMY: Record<string, number> = { automated_factory: 500, research_lab: 400,
  robo_miner_plant: 110, supercomputer: 110, pollution_processor: 90, stock_exchange: 75,
  hydroponic_farm: 95, soil_enrichment: 90, biospheres: 55 };
const EXPANSION: Record<string, number> = { colony_ship: 150, deuterium_fuel_cells: 120,
  iridium_fuel_cells: 115, uridium_fuel_cells: 100, fusion_drive: 90, ion_drive: 85 };
const MILITARY: Record<string, number> = { reinforced_hull: 100, battle_pods: 100,
  tritanium_armor: 100, zortrium_armor: 110, class_i_shield: 90, class_iii_shield: 100,
  fusion_beam: 90, mass_driver: 100, neutron_blaster: 110, ion_pulse_cannon: 100,
  electronic_computer: 75, optronic_computer: 85, marine_barracks: 75 };

/** Utility per expected research turn, with discounted utility for useful
 * descendants in the same subject. This pursues research paths through weak
 * prerequisites, using only public tech data and listed (never hidden) costs. */
export function planStrategicResearch(o: EmpireObservation, ctx: StrategyContext, a: StrategicAssessment): AiCommand[] {
  const current = o.research.find((r) => r.field.num === o.self.research.fieldNum);
  if (current?.apps.some((app) => !app.known && !app.dead)) return [];
  const utility = (id: string, subject: string) => {
    let value = 25 + (ECONOMY[id] ?? 0);
    if (id === 'colony_ship' && !o.self.knownApps.includes('colony_ship')) value += 600;
    value += (EXPANSION[id] ?? 0) * (a.goal === 'expand' || ctx.personality === 'expander' ? 2 : 1);
    value += (MILITARY[id] ?? 0) * (a.goal === 'conquer' || a.goal === 'defend' ? 3 : ctx.personality === 'militarist' ? 2 : 1);
    if (o.summary.foodNet < 2 && ['hydroponic_farm', 'soil_enrichment'].includes(id)) value += 180;
    if (ctx.personality === 'techer' && subject === 'computers') value += 80;
    return value;
  };
  const choices = o.research.flatMap((r) => {
    const apps = r.apps.filter((app) => !app.known && !app.dead)
      .map((app) => ({ app, value: utility(app.id, r.subject) }))
      .sort((x, y) => y.value - x.value || (x.app.id < y.app.id ? -1 : x.app.id > y.app.id ? 1 : 0));
    if (!apps.length) return [];
    let future = 0;
    for (const app of APPLICATION_ROWS) {
      if (o.self.knownApps.includes(app.id)) continue;
      let field = fieldById.get(app.fieldId);
      let depth = 0;
      while (field && depth < 3 && field.previous !== 0) {
        depth++;
        if (field.previous === r.field.num) {
          future = Math.max(future, Math.floor(utility(app.id, FIELD_SUBJECTS[field.id] ?? '') / (depth + 2)));
          break;
        }
        field = fieldByNum.get(field.previous);
      }
    }
    const value = r.grantsAll ? apps.reduce((n, x) => n + x.value, 0) : apps[0]!.value;
    const turns = Math.max(1, Math.ceil(r.cost * 3 / (2 * Math.max(1, o.summary.researchPerTurn))));
    return [{ r, app: apps[0]!.app.id, score: Math.floor((value + future) * 1000 / (turns + 3)) }];
  }).sort((x, y) => y.score - x.score || x.r.cost - y.r.cost || x.r.field.num - y.r.field.num);
  const chosen = choices[0];
  return chosen ? [{ kind: 'set_research', payload: { fieldNum: chosen.r.field.num,
    targetApp: chosen.r.grantsAll ? null : chosen.app } }] : [];
}
