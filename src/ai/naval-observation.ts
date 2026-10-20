import type { Empire, GameState } from '@engine/types';
import { availableHulls, bestComputer, bestShield, designStats, fitWeapon, knownWeapons,
  type DesignStats, type DesignWeapon } from '@engine/shipdesign';
import { canQueue } from '@engine/items';
import { refitOptions } from '@engine/selectors';
import type { DesignPayload, NavalObservation } from './types';

/** Own-design comparison only, never enemy strength or claimed win odds.
 * Prefer meaningful firepower/survivability gains over cosmetic refits. */
function designPower(stats: DesignStats): number {
  const attack = stats.weapons.reduce((n, w) => {
    if (w.row.classId !== 0 && w.row.classId !== 1) return n;
    const hit = w.row.classId === 0 ? Math.min(95, Math.max(5, 50 + stats.beamAttack)) : 65;
    const endurance = w.row.classId === 1 && w.row.ammo > 0 ? Math.min(100, w.row.ammo * 25) : 100;
    return n + Math.floor(w.count * (w.row.tacticalDamage.min + w.row.tacticalDamage.max) * hit * endurance / 2000);
  }, 0);
  if (attack <= 0) return 0;
  return attack + Math.floor((stats.armorHp + stats.structureHp + stats.shieldPool * 2) / 4)
    + stats.shieldFlat * 5 + Math.max(0, stats.beamDefense);
}

function template(state: GameState, self: Empire, hull: string, role: 'escort' | 'assault'): NavalObservation['templates'][number] | null {
  const design: DesignPayload = { name: role === 'escort' ? 'Orion Escort' : 'Orion Assault', hull,
    computer: bestComputer(self), shield: bestShield(self), specials: [], weapons: [] };
  // A small, explicit role vocabulary. All parts and every final fit are
  // checked by the same designer and save_design validator as human ships.
  for (const id of ['battle_pods', 'reinforced_hull', ...(role === 'assault' ? ['heavy_armor'] : ['ecm_jammer'])]) {
    if (!self.knownApps.includes(id)) continue;
    const proposed = { ...design, specials: [...design.specials, id] };
    if (typeof designStats(state, self, proposed) !== 'string') design.specials.push(id);
  }
  const empty = designStats(state, self, design);
  if (typeof empty === 'string') return null;
  let space = empty.spaceTotal - empty.spaceUsed;
  const weapons = knownWeapons(self).filter((w) => w.classId === 0 || w.classId === 1).flatMap((w) => {
    const mount: DesignWeapon = { weapon: w.id, count: 1, mods: [] };
    const fitted = fitWeapon(self, mount);
    return typeof fitted === 'string' ? [] : [{ w, fitted, mount }];
  }).sort((x, y) => {
    const value = (v: typeof x) => Math.floor((v.w.tacticalDamage.min + v.w.tacticalDamage.max) * 1000 / v.fitted.spaceEach);
    return value(y) - value(x) || (x.w.id < y.w.id ? -1 : x.w.id > y.w.id ? 1 : 0);
  });
  const beam = weapons.find((x) => x.w.classId === 0 && x.fitted.spaceEach <= space);
  const missile = weapons.find((x) => x.w.classId === 1 && x.fitted.spaceEach <= space);
  const mount = (x: typeof beam, budget: number) => {
    if (!x) return;
    const count = Math.min(200, Math.floor(Math.min(space, budget) / x.fitted.spaceEach));
    if (!count) return;
    design.weapons.push({ ...x.mount, count });
    space -= count * x.fitted.spaceEach;
  };
  mount(beam, missile ? Math.floor(space * (role === 'escort' ? 80 : 60) / 100) : space);
  mount(missile, space);
  if (!design.weapons.length) mount(beam, space);
  if (!design.weapons.length) return null; // pre-warp grants no free weapon knowledge
  const stats = designStats(state, self, design);
  if (typeof stats === 'string') return null;
  return { role, design, power: designPower(stats), cost: stats.cost };
}

/** Trusted observation-builder helper. Reads only own designs/ships/yards;
 * policies receive detached payloads and legal choices, never GameState. */
export function observeNavy(state: GameState, self: Empire): NavalObservation {
  const designs = self.designs.flatMap((d) => {
    const stats = designStats(state, self, d);
    return typeof stats === 'string' ? [] : [{ id: d.id, power: designPower(stats), cost: stats.cost }];
  });
  const hulls = availableHulls(self);
  const templates = ([['frigate', 'escort'], [hulls[hulls.length - 1]!, 'assault']] as const)
    .flatMap(([hull, role]) => { const t = template(state, self, hull, role); return t ? [t] : []; });
  const refits = state.ships.filter((s) => s.owner === self.id && s.shipKind === 'design').flatMap((s) => {
    const choices = refitOptions(state, self.id, s.id);
    if (s.location.kind !== 'star') return [];
    const starId = s.location.starId;
    const yards = state.colonies.filter((c) => c.owner === self.id && state.planets.some((p) => p.id === c.planetId && p.starId === starId));
    return yards.flatMap((colony) => choices.options.filter((x) => canQueue(state, colony, `refit:${s.id}:${x.designId}`) === null)
      .map((x) => ({ shipId: s.id, colonyId: colony.id, designId: x.designId, cost: x.cost })));
  });
  return { designs, templates, refits };
}
