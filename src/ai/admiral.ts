import { parseRefitItem } from '@engine/items';
import { assessEmpire } from './assessment';
import { planStrategicResearch } from './research';
import { planStrategicEconomy } from './economy';
import { planOperations } from './operations';
import { planDiplomacy } from './strategy';
import { planWar, strategistStrategy } from './strategist';
import { navalProductionView, planNavalDesigns, planNavalRefits, refittingShips } from './modernization';
import type { AiCommand, StrategicPolicy } from './types';

export const admiralStrategy: StrategicPolicy = {
  id: 'strategist-v3',
  plan(o, ctx) {
    const a = assessEmpire(o, ctx);
    const refits = planNavalRefits(o, ctx, a);
    const held = refittingShips(o);
    const reservedYards = new Set<number>();
    for (const command of refits) {
      const p = command.payload as { colonyId: number; items: string[] };
      reservedYards.add(p.colonyId);
      for (const item of p.items) { const r = parseRefitItem(item); if (r) held.add(r.shipId); }
    }
    const economy = planStrategicEconomy(navalProductionView(o), ctx, a).filter((c) =>
      !['set_build_queue', 'buy_production'].includes(c.kind)
      || !reservedYards.has((c.payload as { colonyId: number }).colonyId));
    const vote: AiCommand[] = o.council && !o.council.voted ? [{ kind: 'cast_vote', payload: {
      candidate: o.council.candidates.includes(o.self.id) ? o.self.id : -1,
    } }] : [];
    return [...vote, ...planNavalDesigns(o, ctx, a), ...planStrategicResearch(o, ctx, a), ...refits, ...economy,
      ...planWar({ ...o, fleets: o.fleets.filter((f) => !held.has(f.ship.id)) }, ctx),
      ...planOperations({ ...o, fleets: o.fleets.filter((f) => !held.has(f.ship.id)) }, a), ...planDiplomacy(o)];
  },
  battleOrders: strategistStrategy.battleOrders,
};
