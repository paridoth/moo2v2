// Player command validation + application. Commands mutate ORDERS/intents on a
// structuredClone of the state; the world itself changes only during turn
// resolution (pipeline.ts). Validation runs both client-side (optimistic UX)
// and host-side (authoritative).

import {
  applicationById,
  fieldById,
  fieldByNum,
  applicationsOfField,
  pickById,
  GOVERNMENTS,
  PICK_EXCLUSIVE_GROUPS,
} from './data/index';
import { areAtWar, relationKey, setRelation } from './battles';
import { anyEmpireContact, metEmpireIds } from './contact';
import { buyCost, colonyMaxPop, colonyPopUnits as popUnitsOf, empireOf, farmingViable, freeFreighters, organicUnitsOf, traitsOf } from './economy';
import { allocId, allocWorldId } from './ids';
import { constructAsBarren } from './terraform';
import { canQueue, itemCost, parseRefitItem } from './items';
import { inRange, settlerTravelTurns, shipStar, supportStars, travelTurns } from './movement';
import { starDistance } from './galaxy';
import { appPickableBy, availableFields, fieldGrantsAll } from './research';
import { availableHulls, designStats, knownWeapons } from './shipdesign';
import { isShipStyle } from './shipstyles';
import type { BattleOrders, Stance, TargetPriority } from './combat';
import { ANDROID_RACE, NATIVE_RACE } from './types';
import type { Colony, GameState, Planet, PopGroup, Ship, Star, TurnEvent } from './types';

export interface EngineCommand {
  turn: number;
  playerId: number;
  kind: string;
  payload: unknown;
}

type Validator = (state: GameState, cmd: EngineCommand) => string | null;
type Applier = (state: GameState, cmd: EngineCommand, events?: TurnEvent[]) => void;

function colony(state: GameState, id: unknown): Colony | null {
  return state.colonies.find((c) => c.id === id) ?? null;
}

function ownColony(state: GameState, cmd: EngineCommand, id: unknown): Colony | string {
  const c = colony(state, id);
  if (!c) return `no colony ${id}`;
  if (c.owner !== cmd.playerId) return `colony ${id} not yours`;
  if (c.outpost) return `colony ${id} is an outpost`;
  return c;
}

function ownShips(state: GameState, cmd: EngineCommand, ids: unknown): Ship[] | string {
  if (!Array.isArray(ids) || ids.length === 0) return 'no ships listed';
  const out: Ship[] = [];
  for (const id of ids) {
    const s = state.ships.find((x) => x.id === id);
    if (!s) return `no ship ${id}`;
    if (s.owner !== cmd.playerId) return `ship ${id} not yours`;
    out.push(s);
  }
  return out;
}

// ---------- set_jobs ----------

interface SetJobsPayload {
  colonyId: number;
  groups: Array<{ race: number; farmers: number; workers: number; scientists: number }>;
}

const validateSetJobs: Validator = (state, cmd) => {
  const p = cmd.payload as SetJobsPayload;
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  if (!Array.isArray(p.groups)) return 'groups required';
  for (const g of p.groups) {
    const grp = c.groups.find((x) => x.race === g.race);
    if (!grp) return `no pop group for race ${g.race}`;
    const units = Math.floor(grp.popK / 1000);
    for (const key of ['farmers', 'workers', 'scientists'] as const) {
      if (!Number.isSafeInteger(g[key]) || g[key] < 0) return `bad ${key}`;
    }
    if (g.farmers + g.workers + g.scientists !== units) {
      return `jobs must total ${units} for race ${g.race}`;
    }
    // androids are hardwired at the factory: the group's job split may only
    // ever be restated verbatim, never changed (bugs.md)
    if (g.race === ANDROID_RACE) {
      if (g.farmers !== grp.farmers || g.workers !== grp.workers || g.scientists !== grp.scientists) {
        return 'androids are hardwired to the job they were built for';
      }
      continue;
    }
    // natives only ever farm (planet_specials.md); their idle-farming on a
    // spoiled world is fine — the viability guard is for the owner's citizens
    if (g.race === NATIVE_RACE) {
      if (g.workers > 0 || g.scientists > 0) return 'natives only work the farms';
    } else if (g.farmers > 0 && !farmingViable(state, c)) {
      return 'nothing grows here — farmers would produce no food on this world';
    }
  }
  return null;
};

const applySetJobs: Applier = (state, cmd) => {
  const p = cmd.payload as SetJobsPayload;
  const c = colony(state, p.colonyId)!;
  for (const g of p.groups) {
    const grp = c.groups.find((x) => x.race === g.race)!;
    grp.farmers = g.farmers;
    grp.workers = g.workers;
    grp.scientists = g.scientists;
  }
};

// ---------- set_build_queue ----------

interface SetQueuePayload {
  colonyId: number;
  items: string[];
}

const validateSetQueue: Validator = (state, cmd) => {
  const p = cmd.payload as SetQueuePayload;
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  if (!Array.isArray(p.items) || p.items.length > 12) return 'items must be a list (max 12)';
  if (p.items.some((i) => typeof i !== 'string')) return 'items must be strings';
  // buying locks the active item for the turn (no buy-then-switch exploit)
  if (c.boughtThisTurn && c.queue[0] && p.items[0] !== c.queue[0].item) {
    return 'production was bought this turn — the active item is locked until next turn';
  }
  const probe: Colony = { ...c, queue: [] };
  for (const item of p.items) {
    const err = canQueue(state, probe, item);
    if (err) return err;
    probe.queue = [...probe.queue, { item }];
  }
  return null;
};

const applySetQueue: Applier = (state, cmd) => {
  const p = cmd.payload as SetQueuePayload;
  const c = colony(state, p.colonyId)!;
  const oldActive = c.queue[0]?.item;
  c.queue = p.items.map((item) => ({ item }));
  const newActive = c.queue[0]?.item;
  if (oldActive && oldActive !== newActive) {
    if (state.settings.modes.stickyBuild) {
      // park progress on the switched-away item
      if (c.storedProd > 0) {
        c.stickyInvested[oldActive] = (c.stickyInvested[oldActive] ?? 0) + c.storedProd;
        c.storedProd = 0;
      }
    }
    // normal mode: storedProd carries to the new item (classic behavior)
  }
  if (newActive && state.settings.modes.stickyBuild && c.stickyInvested[newActive]) {
    c.storedProd += c.stickyInvested[newActive]!;
    delete c.stickyInvested[newActive];
  }
};

// ---------- buy_production ----------

interface BuyPayload {
  colonyId: number;
}

const validateBuy: Validator = (state, cmd) => {
  const p = cmd.payload as BuyPayload;
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  const active = c.queue[0]?.item;
  if (!active) return 'nothing being built';
  if (active === 'housing' || active === 'trade_goods') return `cannot buy ${active}`;
  if (c.boughtThisTurn) return 'already bought this turn';
  const cost = itemCost(state, c.owner, active, c);
  if (cost === null) return `unknown item ${active}`;
  if (c.storedProd >= cost) return 'already complete';
  const price = buyCost(cost, c.storedProd);
  const empire = empireOf(state, cmd.playerId);
  if (empire.bc < price) return `need ${price} BC (have ${empire.bc})`;
  return null;
};

const applyBuy: Applier = (state, cmd) => {
  const p = cmd.payload as BuyPayload;
  const c = colony(state, p.colonyId)!;
  const active = c.queue[0]!.item;
  const cost = itemCost(state, c.owner, active, c) ?? 0;
  const price = buyCost(cost, c.storedProd);
  const empire = empireOf(state, cmd.playerId);
  empire.bc -= price;
  c.storedProd = cost;
  c.boughtThisTurn = true;
};

// ---------- set_research ----------

interface SetResearchPayload {
  fieldNum: number;
  targetApp: string | null;
}

const validateSetResearch: Validator = (state, cmd) => {
  const p = cmd.payload as SetResearchPayload;
  const empire = state.empires.find((e) => e.id === cmd.playerId);
  if (!empire) return 'no empire';
  const field = fieldByNum.get(p?.fieldNum);
  if (!field) return `no field ${p?.fieldNum}`;
  if (!availableFields(empire).some((f) => f.num === field.num)) {
    return `${field.id} not available`;
  }
  if (p.targetApp !== null) {
    const apps = applicationsOfField(field.id);
    if (!apps.some((a) => a.id === p.targetApp)) return `${p.targetApp} not in ${field.id}`;
    if (empire.knownApps.includes(p.targetApp)) return `${p.targetApp} already known`;
  }
  const traits = traitsOf(empire);
  if (!traits.uncreative && !(traits.creative && !state.settings.modes.creativeVariant)) {
    if (p.targetApp === null && !field.id.startsWith('advf_') && !fieldGrantsAll(field)) {
      return 'target application required';
    }
    // only when the target actually decides the grant: dead picks (morale
    // tech under Unification) are refused unless the field offers nothing else
    if (p.targetApp !== null && !appPickableBy(empire, p.targetApp)) {
      const others = applicationsOfField(field.id).some(
        (a) => !empire.knownApps.includes(a.id) && appPickableBy(empire, a.id),
      );
      if (others) return `${p.targetApp} is pointless under Unification (morale-immune)`;
    }
  }
  return null;
};

const applySetResearch: Applier = (state, cmd) => {
  const p = cmd.payload as SetResearchPayload;
  const empire = empireOf(state, cmd.playerId);
  empire.research.fieldNum = p.fieldNum;
  empire.research.targetApp = p.targetApp;
};

// ---------- queue_extra_research (creative-variant) ----------

interface ExtraResearchPayload {
  appId: string;
  remove?: boolean;
}

const validateExtraResearch: Validator = (state, cmd) => {
  const p = cmd.payload as ExtraResearchPayload;
  const empire = state.empires.find((e) => e.id === cmd.playerId);
  if (!empire) return 'no empire';
  const traits = traitsOf(empire);
  const creativePath = state.settings.modes.creativeVariant && traits.creative;
  const outOfBoxPath = state.settings.modes.outOfBoxThinking === true && traits.outOfBoxThinking;
  if (!creativePath && !outOfBoxPath) {
    return 'buying skipped applications needs creative (creative-variant mode) or out-of-the-box thinking (its game option)';
  }
  if (p.remove) {
    return empire.research.extraQueue.includes(p.appId) ? null : `${p.appId} not queued`;
  }
  const found = applicationById.get(p.appId);
  if (!found) return `no application ${p.appId}`;
  const field = fieldById.get(found.fieldId);
  if (!field) return 'field missing';
  if (!empire.completedFields.includes(field.num)) return `${field.id} not completed`;
  if (empire.knownApps.includes(p.appId)) return `${p.appId} already known`;
  if (empire.research.extraQueue.includes(p.appId)) return `${p.appId} already queued`;
  if (!appPickableBy(empire, p.appId)) return `${p.appId} is pointless under Unification (morale-immune)`;
  return null;
};

const applyExtraResearch: Applier = (state, cmd) => {
  const p = cmd.payload as ExtraResearchPayload;
  const empire = empireOf(state, cmd.playerId);
  if (p.remove) {
    empire.research.extraQueue = empire.research.extraQueue.filter((a) => a !== p.appId);
    if (empire.research.extraQueue.length === 0) empire.research.extraAccumRP = 0;
  } else {
    empire.research.extraQueue.push(p.appId);
  }
};

// ---------- move_ships ----------

interface MovePayload {
  shipIds: number[];
  destStarId: number;
}

const validateMove: Validator = (state, cmd) => {
  const p = cmd.payload as MovePayload;
  const ships = ownShips(state, cmd, p?.shipIds);
  if (typeof ships === 'string') return ships;
  const dest = state.stars.find((s) => s.id === p.destStarId);
  if (!dest) return `no star ${p.destStarId}`;
  for (const ship of ships) {
    // orders placed this turn are still re-routable until the turn resolves
    if (ship.location.kind === 'transit' && ship.location.departedTurn !== state.turn) {
      return `ship ${ship.id} is in transit`;
    }
    const origin = moveOrigin(state, ship);
    if (origin.id === dest.id && ship.location.kind === 'star') return `ship ${ship.id} already there`;
  }
  // per-ship fuel gate. A ship whose ORIGIN is inside the supply network flies
  // anywhere the network reaches (classic rule). A fleet stranded OUTSIDE the
  // network can only limp back TOWARD it — the old code required the
  // destination to be in network range first, which made the stranded clause
  // unreachable and let stranded ships warp anywhere adjacent to the network.
  const support = supportStars(state, cmd.playerId);
  const toNet = (s: Star) => support.reduce((m, sup) => Math.min(m, starDistance(sup, s)), Infinity);
  for (const ship of ships) {
    const origin = moveOrigin(state, ship);
    // wormholes carry ships regardless of fuel range (outposts on the far
    // side can then extend the network)
    if (origin.wormholeTo === dest.id) continue;
    if (inRange(state, cmd.playerId, origin)) {
      if (!inRange(state, cmd.playerId, dest)) return `${dest.name} is out of fuel range`;
      continue;
    }
    if (support.length === 0) continue; // no network at all: free movement
    if (toNet(dest) >= toNet(origin)) {
      return 'out of fuel: stranded ships can only move back toward supply range';
    }
  }
  return null;
};

/** Where a move order departs from: the current star, or — for an order placed
 * earlier this same turn — the star the pending order departs from. */
function moveOrigin(state: GameState, ship: Ship): Star {
  if (ship.location.kind === 'star') return shipStar(state, ship)!;
  return state.stars.find((s) => s.id === (ship.location as { from: number }).from)!;
}

const applyMove: Applier = (state, cmd) => {
  const p = cmd.payload as MovePayload;
  const empire = empireOf(state, cmd.playerId);
  for (const id of p.shipIds) {
    const ship = state.ships.find((s) => s.id === id)!;
    const from = moveOrigin(state, ship);
    const dest = state.stars.find((s) => s.id === p.destStarId)!;
    if (from.id === dest.id) {
      // re-ordered back home: cancel the pending order entirely
      ship.location = { kind: 'star', starId: from.id };
      continue;
    }
    const turns = travelTurns(state, empire, from, dest);
    ship.location = {
      kind: 'transit',
      from: from.id,
      to: dest.id,
      departedTurn: state.turn,
      arrivalTurn: state.turn + turns,
    };
  }
};

// ---------- colonize / build_outpost ----------

interface ColonizePayload {
  shipId: number;
  planetId: number;
}

function validateSettle(state: GameState, cmd: EngineCommand, wantKind: 'colony_ship' | 'outpost_ship'): string | null {
  const p = cmd.payload as ColonizePayload;
  const ships = ownShips(state, cmd, [p?.shipId]);
  if (typeof ships === 'string') return ships;
  const ship = ships[0]!;
  if (ship.shipKind !== wantKind) return `ship ${ship.id} is not a ${wantKind}`;
  if (ship.location.kind !== 'star') return 'ship is in transit';
  const planet = state.planets.find((x) => x.id === p.planetId);
  if (!planet) return `no planet ${p.planetId}`;
  if (planet.starId !== ship.location.starId) return 'ship is not at that system';
  if (wantKind === 'colony_ship' && planet.body !== 'planet') return 'cannot colonize that body';
  if (state.colonies.some((c) => c.planetId === planet.id)) return 'already settled';
  if (hostileMonsterAt(state, planet.starId)) return 'the system is guarded — destroy its keeper first';
  return null;
}

/** One-time planet specials consumed when a real colony is FOUNDED there
 * (colonize command, colony_base completion, developed starts): space-debris
 * salvage, a splinter colony rejoining, and native integration
 * (planet_specials.md). Shared so every founding path behaves identically. */
export function applyFoundingSpecials(
  state: GameState,
  planet: Planet,
  colony: Colony,
  events?: TurnEvent[],
): void {
  if (planet.special === 'space_debris') {
    // the wreckage is salvaged on arrival (one-time +50 BC)
    empireOf(state, colony.owner).bc += 50;
    planet.special = null;
  }
  if (planet.special === 'splinter_colony') {
    // normally a splinter colony joins its DISCOVERER outright (pipeline
    // s6b_discoveries). This branch is the fallback for founding paths that
    // land directly on the planet (developed starts at init): the splinter
    // folk integrate as up to 3 farm-only native units — same deal, no free
    // labor force of the owner's race
    const units = Math.min(3, Math.max(0, colonyMaxPop(state, colony) - popUnitsOf(colony)));
    if (units > 0) {
      colony.groups.push({ race: NATIVE_RACE, popK: units * 1000, farmers: units, workers: 0, scientists: 0, unrest: false });
      colony.groups.sort((a, b) => a.race - b.race);
      events?.push({ visibleTo: colony.owner, kind: 'splinter_joined', payload: { colonyId: colony.id, starId: planet.starId, units } });
    }
    planet.special = null;
  }
  if (planet.special === 'natives') {
    // humanoid natives integrate into the colony: they only ever farm, gain
    // no racial bonuses, and never leave the planet (NATIVE_RACE group rules)
    const units = Math.min(2, Math.max(0, colonyMaxPop(state, colony) - popUnitsOf(colony)));
    if (units > 0) {
      colony.groups.push({ race: NATIVE_RACE, popK: units * 1000, farmers: units, workers: 0, scientists: 0, unrest: false });
      colony.groups.sort((a, b) => a.race - b.race);
      events?.push({ visibleTo: colony.owner, kind: 'natives_joined', payload: { colonyId: colony.id, units } });
    }
    planet.special = null;
  }
}

const applyColonize: Applier = (state, cmd, events) => {
  const p = cmd.payload as ColonizePayload;
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const planet = state.planets.find((x) => x.id === p.planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  state.ships = state.ships.filter((s) => s.id !== ship.id);
  const romans = ['I', 'II', 'III', 'IV', 'V'];
  state.colonies.push({
    id: allocId(state, cmd.playerId),
    planetId: planet.id,
    owner: cmd.playerId,
    name: `${star.name} ${romans[planet.orbit - 1] ?? planet.orbit}`,
    groups: [{ race: cmd.playerId, popK: 1000, farmers: 1, workers: 0, scientists: 0, unrest: false }],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  });
  // on worlds where farming is impossible the sole colonist works instead of
  // farming for 0 food (the "wasted farmer" trap validateSetJobs guards against)
  const settled = state.colonies[state.colonies.length - 1]!;
  if (!farmingViable(state, settled)) {
    settled.groups[0]!.farmers = 0;
    settled.groups[0]!.workers = 1;
  }
  applyFoundingSpecials(state, planet, settled, events);
  state.colonies.sort((a, b) => a.id - b.id);
};

const applyOutpost: Applier = (state, cmd) => {
  const p = cmd.payload as ColonizePayload;
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const planet = state.planets.find((x) => x.id === p.planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  state.ships = state.ships.filter((s) => s.id !== ship.id);
  state.colonies.push({
    id: allocId(state, cmd.playerId),
    planetId: planet.id,
    owner: cmd.playerId,
    name: `${star.name} Outpost`,
    groups: [],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: true,
  });
  state.colonies.sort((a, b) => a.id - b.id);
};

// ---------- construct_planet (planetary construction ship) ----------

const validateConstructPlanet: Validator = (state, cmd) => {
  if (state.settings.modes.constructionShip !== true) return 'the construction-ship game option is off';
  const p = cmd.payload as ColonizePayload;
  const ships = ownShips(state, cmd, [p?.shipId]);
  if (typeof ships === 'string') return ships;
  const ship = ships[0]!;
  if (ship.shipKind !== 'construction_ship') return `ship ${ship.id} is not a construction ship`;
  if (ship.location.kind !== 'star') return 'ship is in transit';
  const planet = state.planets.find((x) => x.id === p.planetId);
  if (!planet) return `no planet ${p.planetId}`;
  if (planet.starId !== ship.location.starId) return 'ship is not at that system';
  if (planet.body !== 'asteroids' && planet.body !== 'gas_giant') return 'only asteroid belts and gas giants can be constructed';
  if (hostileMonsterAt(state, planet.starId)) return 'the system is guarded — destroy its keeper first';
  return null;
};

const applyConstructPlanet: Applier = (state, cmd, events) => {
  const p = cmd.payload as ColonizePayload;
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const planet = state.planets.find((x) => x.id === p.planetId)!;
  // outposts on the old body (asteroid anchors) survive on the new world
  state.ships = state.ships.filter((s) => s.id !== ship.id); // consumed by the build
  constructAsBarren(planet);
  events?.push({
    visibleTo: cmd.playerId,
    kind: 'planet_constructed',
    payload: { planetId: planet.id, orbit: planet.orbit, starId: planet.starId },
  });
};

// ---------- scrap_ship ----------

const validateScrap: Validator = (state, cmd) => {
  const p = cmd.payload as { shipId: number };
  const ships = ownShips(state, cmd, [p?.shipId]);
  return typeof ships === 'string' ? ships : null;
};

const applyScrap: Applier = (state, cmd) => {
  const p = cmd.payload as { shipId: number };
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const empire = empireOf(state, cmd.playerId);
  // MOO2 scrap value: a quarter of the ship's production cost, in BC —
  // designed warships use their design's real cost
  const costs: Record<string, number> = { colony_ship: 500, outpost_ship: 100, transport: 100, scout: 10, construction_ship: 400 };
  const cost =
    ship.shipKind === 'design' && ship.designId !== null
      ? (itemCost(state, cmd.playerId, `design:${ship.designId}`) ?? 0)
      : (costs[ship.shipKind] ?? 0);
  empire.bc += Math.floor(cost / 4);
  state.ships = state.ships.filter((s) => s.id !== p.shipId);
};

// ---------- scrap_outpost ----------

const validateScrapOutpost: Validator = (state, cmd) => {
  const p = cmd.payload as { colonyId: number };
  const colony = state.colonies.find((c) => c.id === p?.colonyId);
  if (!colony) return `no colony ${p?.colonyId}`;
  if (colony.owner !== cmd.playerId) return 'not your outpost';
  if (!colony.outpost) return 'only outposts can be scrapped (colonies must be abandoned by their people)';
  return null;
};

const applyScrapOutpost: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number };
  // same salvage rule as ships: a quarter of the outpost ship's cost back
  empireOf(state, cmd.playerId).bc += 25;
  state.colonies = state.colonies.filter((c) => c.id !== p.colonyId);
};

// ---------- set_tax_rate ----------

const validateSetTax: Validator = (state, cmd) => {
  const p = cmd.payload as { pct: number };
  if (!Number.isSafeInteger(p?.pct) || p.pct < 0 || p.pct > 50) return 'tax rate must be 0-50%';
  return null;
};

const applySetTax: Applier = (state, cmd) => {
  const p = cmd.payload as { pct: number };
  empireOf(state, cmd.playerId).taxRatePct = p.pct;
};

// ---------- set_ship_style (cosmetic: fleet appearance in battle replays) ----------

const validateSetShipStyle: Validator = (_state, cmd) => {
  const p = cmd.payload as { style: string };
  return isShipStyle(p?.style) ? null : `unknown ship style ${String(p?.style)}`;
};

const applySetShipStyle: Applier = (state, cmd) => {
  const p = cmd.payload as { style: string };
  empireOf(state, cmd.playerId).shipStyle = p.style;
};

// ---------- sell_building ----------

interface SellBuildingPayload {
  colonyId: number;
  buildingId: string;
}

const validateSellBuilding: Validator = (state, cmd) => {
  const p = cmd.payload as SellBuildingPayload;
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  if (!c.buildings.includes(p.buildingId)) return `${p.buildingId} not built there`;
  if (c.soldThisTurn) return 'already sold a building there this turn';
  const cost = itemCost(state, cmd.playerId, p.buildingId);
  if (cost === null) return `unknown building ${p.buildingId}`;
  return null;
};

const applySellBuilding: Applier = (state, cmd) => {
  const p = cmd.payload as SellBuildingPayload;
  const c = colony(state, p.colonyId)!;
  const cost = itemCost(state, cmd.playerId, p.buildingId) ?? 0;
  c.buildings = c.buildings.filter((b) => b !== p.buildingId);
  c.soldThisTurn = true;
  empireOf(state, cmd.playerId).bc += Math.floor(cost / 2);
};

// ---------- ship designs ----------

interface SaveDesignPayload {
  name: string;
  hull: string;
  computer: number;
  shield: number;
  specials: string[];
  weapons: Array<{ weapon: string; count: number; mods: string[]; arc?: 'F' | 'FX' | 'R' | '360' }>;
  /** cosmetic model variant within the hull class (optional; small index) */
  modelIdx?: number;
}

const validateSaveDesign: Validator = (state, cmd) => {
  const p = cmd.payload as SaveDesignPayload;
  const empire = empireOf(state, cmd.playerId);
  if (typeof p?.name !== 'string' || !p.name.trim() || p.name.length > 30) return 'bad design name';
  if (p.modelIdx !== undefined && (!Number.isSafeInteger(p.modelIdx) || p.modelIdx < 0 || p.modelIdx > 31)) return 'bad model variant';
  // engine-maintained defaults (design.auto) don't consume player slots
  if (empire.designs.filter((d) => !d.obsolete && !d.auto).length >= 12) return 'design limit reached (obsolete one first)';
  // players may only design MOBILE hulls they have researched. designStats
  // deliberately exempts base hulls from the availability check (baseDesign
  // auto-designs stations with them) — without this gate a modified client
  // could field tech-free, zero-command-point star-fortress "ships" on turn 1
  if (typeof p.hull !== 'string' || !availableHulls(empire).includes(p.hull)) {
    return `${String(p?.hull)} hull not yet available`;
  }
  // payloads arrive as raw network JSON: field types are hostile until proven
  if (p.specials !== undefined && !Array.isArray(p.specials)) return 'bad specials';
  if (p.weapons !== undefined && !Array.isArray(p.weapons)) return 'bad weapons';
  for (const w of p.weapons ?? []) {
    if (typeof w?.weapon !== 'string' || !Array.isArray(w.mods) || w.mods.some((m) => typeof m !== 'string')) return 'bad weapon entry';
  }
  if ((p.specials ?? []).some((s) => typeof s !== 'string')) return 'bad specials';
  const stats = designStats(state, empire, {
    name: p.name,
    hull: p.hull,
    computer: p.computer,
    shield: p.shield,
    specials: p.specials ?? [],
    weapons: p.weapons ?? [],
  });
  if (typeof stats === 'string') return stats;
  // the weapon itself must be researched, not just its mods (a modified client
  // could otherwise field endgame/monster weapons on turn 1)
  const known = new Set(knownWeapons(empire).map((w) => w.id));
  for (const w of p.weapons ?? []) {
    if (!known.has(w.weapon)) return `${w.weapon} not researched`;
  }
  return null;
};

const applySaveDesign: Applier = (state, cmd) => {
  const p = cmd.payload as SaveDesignPayload;
  const empire = empireOf(state, cmd.playerId);
  empire.designs.push({
    id: allocId(state, cmd.playerId),
    name: p.name.trim(),
    hull: p.hull,
    computer: p.computer,
    shield: p.shield,
    specials: [...(p.specials ?? [])].sort(),
    weapons: (p.weapons ?? []).map((w) => ({
      weapon: w.weapon,
      count: w.count,
      mods: [...w.mods].sort(),
      ...(w.arc && w.arc !== 'F' ? { arc: w.arc } : {}),
    })),
    obsolete: false,
    ...(p.modelIdx !== undefined ? { modelIdx: p.modelIdx } : {}),
  });
};

const validateObsoleteDesign: Validator = (state, cmd) => {
  const p = cmd.payload as { designId: number };
  const empire = empireOf(state, cmd.playerId);
  return empire.designs.some((d) => d.id === p?.designId) ? null : `no design ${p?.designId}`;
};

const applyObsoleteDesign: Applier = (state, cmd) => {
  const p = cmd.payload as { designId: number };
  const empire = empireOf(state, cmd.playerId);
  const d = empire.designs.find((x) => x.id === p.designId)!;
  d.obsolete = true;
  // drop it from any build queues — both new builds AND refits toward it
  // (canQueue refuses new refits to an obsolete design; queued ones must not
  // slip through and complete)
  for (const c of state.colonies) {
    if (c.owner !== cmd.playerId) continue;
    c.queue = c.queue.filter(
      (q) => q.item !== `design:${p.designId}` && parseRefitItem(q.item)?.designId !== p.designId,
    );
  }
};

// ---------- diplomacy (minimal war/peace; full diplomacy in Phase 6) ----------

const validateDeclareWar: Validator = (state, cmd) => {
  const p = cmd.payload as { target: number };
  if (!state.empires.some((e) => e.id === p?.target)) return `no empire ${p?.target}`;
  if (p.target === cmd.playerId) return 'cannot declare war on yourself';
  if (areAtWar(state, cmd.playerId, p.target)) return 'already at war';
  return null;
};

const applyDeclareWar: Applier = (state, cmd) => {
  const p = cmd.payload as { target: number };
  setRelation(state, cmd.playerId, p.target, 'war');
  breakTreaties(state, cmd.playerId, p.target);
  // war also voids open proposals between the two
  state.proposals = state.proposals.filter(
    (x) => !((x.from === cmd.playerId && x.to === p.target) || (x.from === p.target && x.to === cmd.playerId)),
  );
};

const validateOfferPeace: Validator = (state, cmd) => {
  const p = cmd.payload as { target: number };
  if (!state.empires.some((e) => e.id === p?.target)) return `no empire ${p?.target}`;
  if (!areAtWar(state, cmd.playerId, p.target)) return 'not at war';
  return null;
};

const applyOfferPeace: Applier = (state, cmd) => {
  const p = cmd.payload as { target: number };
  const [x, y] = relationKey(cmd.playerId, p.target);
  const rel = state.relations.find((r) => r.a === x && r.b === y)!;
  if (!rel.peaceOfferedBy.includes(cmd.playerId)) {
    rel.peaceOfferedBy.push(cmd.playerId);
    rel.peaceOfferedBy.sort((a, b) => a - b);
  }
};

// ---------- battle orders (battle_orders sub-phase) ----------

const STANCES: Stance[] = ['charge', 'hold_range', 'standoff', 'evade_retreat', 'formation', 'passthrough'];
const PRIORITIES: TargetPriority[] = ['nearest', 'biggest', 'smallest', 'warships', 'bases', 'deadliest'];

const validateBattleOrders: Validator = (state, cmd) => {
  if (state.phase !== 'battle_orders') return 'no battle awaiting orders';
  const p = cmd.payload as { battleId: string; orders: BattleOrders };
  const battle = state.pendingBattles.find((b) => b.id === p?.battleId);
  if (!battle) return `no pending battle ${p?.battleId}`;
  if (battle.attacker !== cmd.playerId && battle.defender !== cmd.playerId) return 'not your battle';
  const o = p.orders;
  if (!o || !STANCES.includes(o.stance) || !PRIORITIES.includes(o.priority)) return 'bad orders';
  if (!Number.isSafeInteger(o.retreatThresholdPct) || o.retreatThresholdPct < 0 || o.retreatThresholdPct > 90) {
    return 'bad retreat threshold';
  }
  if (typeof o.bombard !== 'boolean') return 'bad bombard flag';
  if (o.invade !== undefined && typeof o.invade !== 'boolean') return 'bad invade flag';
  if (o.spareNoncombatants !== undefined && typeof o.spareNoncombatants !== 'boolean') return 'bad spare flag';
  return null;
};

const applyBattleOrders: Applier = (state, cmd) => {
  const p = cmd.payload as { battleId: string; orders: BattleOrders };
  const battle = state.pendingBattles.find((b) => b.id === p.battleId);
  // raw fold paths (log replay after an engine fix, resumed rooms) can carry
  // orders for a battle that no longer forms — a stale order must be inert,
  // never a crash that bricks the whole load
  if (!battle) return;
  const orders: BattleOrders = {
    stance: p.orders.stance,
    priority: p.orders.priority,
    retreatThresholdPct: p.orders.retreatThresholdPct,
    bombard: cmd.playerId === battle.attacker ? p.orders.bombard : false,
    invade: cmd.playerId === battle.attacker && p.orders.invade === true,
    spareNoncombatants: p.orders.spareNoncombatants === true,
  };
  if (cmd.playerId === battle.attacker) battle.ordersA = orders;
  else battle.ordersD = orders;
};

// ---------- transports (invasion logistics) ----------

const validateLoadTransports: Validator = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; shipId: number };
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  const ships = ownShips(state, cmd, [p?.shipId]);
  if (typeof ships === 'string') return ships;
  const ship = ships[0]!;
  if (ship.shipKind !== 'transport') return 'not a transport';
  if (ship.cargoPopUnits > 0) return 'transport already loaded';
  if (ship.location.kind !== 'star') return 'transport in transit';
  const planet = state.planets.find((x) => x.id === c.planetId)!;
  if (ship.location.starId !== planet.starId) return 'transport is not at that colony';
  const own = c.groups.find((g) => g.race === cmd.playerId && !g.unrest);
  if (!own || Math.floor(own.popK / 1000) <= 2) return 'colony needs more than 2 of your own colonists';
  return null;
};

const applyLoadTransports: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; shipId: number };
  const c = colony(state, p.colonyId)!;
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const own = c.groups.find((g) => g.race === cmd.playerId && !g.unrest)!;
  own.popK -= 2000;
  normalizeJobsForGroup(own);
  ship.cargoPopUnits = 2;
  ship.cargoRace = cmd.playerId;
};

const validateUnloadTransports: Validator = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; shipId: number };
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  const ships = ownShips(state, cmd, [p?.shipId]);
  if (typeof ships === 'string') return ships;
  const ship = ships[0]!;
  if (ship.shipKind !== 'transport' || ship.cargoPopUnits <= 0) return 'no loaded transport';
  if (ship.location.kind !== 'star') return 'transport in transit';
  const planet = state.planets.find((x) => x.id === c.planetId)!;
  if (ship.location.starId !== planet.starId) return 'transport is not at that colony';
  // same cap as move_colonists: no packing a colony past its climate ceiling
  if (organicUnitsOf(c) + ship.cargoPopUnits > colonyMaxPop(state, c)) {
    return 'colony is at its population limit';
  }
  return null;
};

const applyUnloadTransports: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; shipId: number };
  const c = colony(state, p.colonyId)!;
  const ship = state.ships.find((s) => s.id === p.shipId)!;
  const grp = c.groups.find((g) => g.race === ship.cargoRace);
  if (grp) {
    grp.popK += ship.cargoPopUnits * 1000;
    normalizeJobsForGroup(grp);
  } else {
    c.groups.push({
      race: ship.cargoRace,
      popK: ship.cargoPopUnits * 1000,
      farmers: 0,
      workers: ship.cargoPopUnits,
      scientists: 0,
      unrest: false,
    });
    c.groups.sort((a, b) => a.race - b.race);
  }
  ship.cargoPopUnits = 0;
};

// ---------- espionage ----------

const validateSpyOrders: Validator = (state, cmd) => {
  const p = cmd.payload as { target: number | null; mode: 'steal' | 'sabotage' };
  if (p.target !== null) {
    if (p.target === cmd.playerId) return 'cannot spy on yourself';
    if (!state.empires.some((e) => e.id === p.target && !e.eliminated)) return `no empire ${p.target}`;
    // you can only infiltrate an empire you have MET — espionage against
    // strangers would mutate their state without ever tripping the fast-start
    // contact wire (the invariant that lets pre-contact turns resolve async)
    if (!metEmpireIds(state, cmd.playerId).has(p.target)) return 'you have not met that empire';
  }
  if (p.mode !== 'steal' && p.mode !== 'sabotage') return 'bad mode';
  return null;
};

const applySpyOrders: Applier = (state, cmd) => {
  const p = cmd.payload as { target: number | null; mode: 'steal' | 'sabotage' };
  const empire = empireOf(state, cmd.playerId);
  empire.spies.target = p.target;
  empire.spies.mode = p.mode;
};

// ---------- diplomacy proposals ----------

import { acceptProposal, breakTreaties, peekRelation } from './diplomacy';
import type { ProposalKind } from './types';

const PROPOSAL_KINDS: ProposalKind[] = ['peace', 'non_aggression', 'alliance', 'trade', 'research', 'gift_bc', 'tech_exchange', 'surrender'];

const validatePropose: Validator = (state, cmd) => {
  const p = cmd.payload as { to: number; kind: ProposalKind; giveBc?: number; giveApp?: string; wantApp?: string };
  if (!state.empires.some((e) => e.id === p?.to && !e.eliminated)) return `no empire ${p?.to}`;
  if (p.to === cmd.playerId) return 'cannot propose to yourself';
  if (!PROPOSAL_KINDS.includes(p.kind)) return 'bad proposal kind';
  // rider fields are typed for EVERY kind, not just the kinds that read them:
  // applyPropose stores them verbatim into hashed state, so a fractional/NaN
  // giveBc smuggled on e.g. a trade proposal would poison every peer's
  // canonical hash (the applier also kind-gates them — belt and braces)
  if (p.giveBc !== undefined && (!Number.isSafeInteger(p.giveBc) || p.giveBc < 0)) return 'bad gift amount';
  if (p.giveApp !== undefined && p.giveApp !== null && typeof p.giveApp !== 'string') return 'bad offered tech';
  if (p.wantApp !== undefined && p.wantApp !== null && typeof p.wantApp !== 'string') return 'bad requested tech';
  const rel = peekRelation(state, cmd.playerId, p.to);
  if (p.kind === 'peace' && rel.status !== 'war') return 'not at war';
  if (['non_aggression', 'alliance', 'trade', 'research'].includes(p.kind) && rel.status === 'war') {
    return 'make peace first';
  }
  // repulsive races cannot sustain treaty relations — peace, gifts, and
  // surrender terms are the only table they will sit at
  if (['non_aggression', 'alliance', 'trade', 'research', 'tech_exchange'].includes(p.kind)) {
    const me = empireOf(state, cmd.playerId);
    const them = empireOf(state, p.to);
    if (traitsOf(me).repulsive) return 'your race is repulsive — no treaties';
    if (traitsOf(them).repulsive) return `${them.name} is repulsive — they refuse all treaties`;
  }
  if (p.kind === 'gift_bc') {
    if (!Number.isSafeInteger(p.giveBc) || (p.giveBc ?? 0) <= 0) return 'bad gift amount';
    const me = empireOf(state, cmd.playerId);
    if (me.bc < (p.giveBc ?? 0)) return 'not enough BC';
  }
  if (p.kind === 'tech_exchange') {
    const me = empireOf(state, cmd.playerId);
    const them = empireOf(state, p.to);
    if (!p.giveApp || !me.knownApps.includes(p.giveApp)) return 'offered tech unknown to you';
    if (!p.wantApp || !them.knownApps.includes(p.wantApp)) return 'requested tech unknown to them';
  }
  if (state.proposals.filter((x) => x.from === cmd.playerId).length >= 5) return 'too many open proposals';
  return null;
};

const applyPropose: Applier = (state, cmd) => {
  const p = cmd.payload as { to: number; kind: ProposalKind; giveBc?: number; giveApp?: string; wantApp?: string };
  // total applier: rider fields are stored ONLY for the kinds that read them —
  // stray payload fields on other kinds must never reach hashed state
  state.proposals.push({
    id: allocId(state, cmd.playerId),
    from: cmd.playerId,
    to: p.to,
    kind: p.kind,
    giveBc: p.kind === 'gift_bc' ? (p.giveBc ?? 0) : 0,
    giveApp: p.kind === 'tech_exchange' ? (p.giveApp ?? null) : null,
    wantApp: p.kind === 'tech_exchange' ? (p.wantApp ?? null) : null,
    expiresTurn: state.turn + 5,
  });
};

const validateRespond: Validator = (state, cmd) => {
  const p = cmd.payload as { proposalId: number; accept: boolean };
  const prop = state.proposals.find((x) => x.id === p?.proposalId);
  if (!prop) return `no proposal ${p?.proposalId}`;
  if (prop.to !== cmd.playerId) return 'not addressed to you';
  return null;
};

const applyRespond: Applier = (state, cmd, events = []) => {
  const p = cmd.payload as { proposalId: number; accept: boolean };
  const prop = state.proposals.find((x) => x.id === p.proposalId)!;
  state.proposals = state.proposals.filter((x) => x.id !== p.proposalId);
  if (p.accept) {
    // surface the outcome: signing an alliance / accepting a surrender must
    // notify players, and an accept that became infeasible (war broke out,
    // gift funds spent) must not silently no-op
    const err = acceptProposal(state, prop, events);
    if (err) {
      events.push({
        visibleTo: prop.from,
        kind: 'proposal_failed',
        payload: { kind: prop.kind, a: prop.from, b: prop.to, reason: err },
      });
      events.push({
        visibleTo: prop.to,
        kind: 'proposal_failed',
        payload: { kind: prop.kind, a: prop.from, b: prop.to, reason: err },
      });
    }
  }
};

// ---------- leaders ----------

import { countKind, leaderById, MAX_LEADERS_PER_KIND } from './leaders';

const validateHireLeader: Validator = (state, cmd) => {
  const p = cmd.payload as { leaderId: string };
  const offer = state.leaderOffers.find((o) => o.empireId === cmd.playerId && o.leaderId === p?.leaderId);
  if (!offer) return `no offer for ${p?.leaderId}`;
  if (offer.expiresTurn <= state.turn) return 'offer expired';
  const row = leaderById.get(p.leaderId);
  if (!row) return `unknown leader ${p.leaderId}`;
  // pre-contact the leader market is per-empire (leadersUpkeep): another
  // stranger's hire must not invalidate mine, or empires would couple before
  // they ever meet (fast-start invariant). Once ANY contact exists the pool
  // is global again and a leader can serve only one empire.
  const hiredElsewhere = anyEmpireContact(state)
    ? state.empires.some((e) => e.leaders.some((l) => l.leaderId === p.leaderId))
    : empireOf(state, cmd.playerId).leaders.some((l) => l.leaderId === p.leaderId);
  if (hiredElsewhere) return 'already hired';
  const empire = empireOf(state, cmd.playerId);
  if (countKind(empire, row.kind) >= MAX_LEADERS_PER_KIND) return `no free ${row.kind} leader slot`;
  if (empire.bc < offer.priceBc) return `need ${offer.priceBc} BC`;
  return null;
};

const applyHireLeader: Applier = (state, cmd) => {
  const p = cmd.payload as { leaderId: string };
  const offer = state.leaderOffers.find((o) => o.empireId === cmd.playerId && o.leaderId === p.leaderId)!;
  const empire = empireOf(state, cmd.playerId);
  empire.bc -= offer.priceBc;
  empire.leaders.push({ leaderId: p.leaderId, level: 1, xp: 0, colonyId: null });
  empire.leaders.sort((a, b) => (a.leaderId < b.leaderId ? -1 : 1));
  // post-contact the hire consumes every open offer for this leader (any
  // empire); pre-contact only my own offer — strangers' offer books must not
  // move because of my commands (fast-start invariant)
  state.leaderOffers = anyEmpireContact(state)
    ? state.leaderOffers.filter((o) => o.leaderId !== p.leaderId)
    : state.leaderOffers.filter((o) => !(o.leaderId === p.leaderId && o.empireId === cmd.playerId));
};

const validateDismissLeader: Validator = (state, cmd) => {
  const p = cmd.payload as { leaderId: string };
  const empire = empireOf(state, cmd.playerId);
  return empire.leaders.some((l) => l.leaderId === p?.leaderId) ? null : `not employing ${p?.leaderId}`;
};

const applyDismissLeader: Applier = (state, cmd) => {
  const p = cmd.payload as { leaderId: string };
  const empire = empireOf(state, cmd.playerId);
  empire.leaders = empire.leaders.filter((l) => l.leaderId !== p.leaderId);
};

const validateAssignLeader: Validator = (state, cmd) => {
  const p = cmd.payload as { leaderId: string; colonyId: number | null };
  const empire = empireOf(state, cmd.playerId);
  const hired = empire.leaders.find((l) => l.leaderId === p?.leaderId);
  if (!hired) return `not employing ${p?.leaderId}`;
  const row = leaderById.get(p.leaderId)!;
  if (row.kind === 'ship') return 'ship officers command fleet-wide (no assignment)';
  if (p.colonyId !== null) {
    const c = ownColony(state, cmd, p.colonyId);
    if (typeof c === 'string') return c;
    if (empire.leaders.some((l) => l.colonyId === p.colonyId && l.leaderId !== p.leaderId)) {
      return 'another leader already governs that colony';
    }
  }
  return null;
};

const applyAssignLeader: Applier = (state, cmd) => {
  const p = cmd.payload as { leaderId: string; colonyId: number | null };
  const empire = empireOf(state, cmd.playerId);
  empire.leaders.find((l) => l.leaderId === p.leaderId)!.colonyId = p.colonyId;
};

// ---------- resign (concession) ----------

const validateResign: Validator = () => null; // any live empire may concede

const applyResign: Applier = (state, cmd) => {
  const empire = empireOf(state, cmd.playerId);
  empire.eliminated = true;
  empire.leaders = [];
  empire.spies = { count: 0, target: null, mode: 'steal' };
  // the realm dissolves: fleets scatter, colonies fall silent, planets free up
  state.ships = state.ships.filter((s) => s.owner !== cmd.playerId);
  state.colonies = state.colonies.filter((c) => c.owner !== cmd.playerId);
  state.proposals = state.proposals.filter((p) => p.from !== cmd.playerId && p.to !== cmd.playerId);
  state.leaderOffers = state.leaderOffers.filter((o) => o.empireId !== cmd.playerId);
};

// ---------- Antaran assault (dimensional portal) ----------

import { MONSTER_SPECS, hostileMonsterAt } from './npc';

const validateAttackAntarans: Validator = (state, cmd) => {
  if (!state.settings.modes.antarans) return 'Antarans mode is off';
  if (state.antarans.assaultBy !== null) return 'an assault is already underway';
  const p = cmd.payload as { colonyId: number };
  const c = ownColony(state, cmd, p?.colonyId);
  if (typeof c === 'string') return c;
  if (!c.buildings.includes('dimensional_portal')) return 'colony has no dimensional portal';
  const planet = state.planets.find((x) => x.id === c.planetId)!;
  const hasFleet = state.ships.some(
    (s) => s.owner === cmd.playerId && s.shipKind === 'design' && s.location.kind === 'star' && s.location.starId === planet.starId,
  );
  return hasFleet ? null : 'assemble warships at the portal first';
};

const applyAttackAntarans: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number };
  const c = colony(state, p.colonyId)!;
  const planet = state.planets.find((x) => x.id === c.planetId)!;
  state.antarans.assaultBy = cmd.playerId;
  // the home garrison materializes on the far side of the portal
  const garrison: Array<keyof typeof MONSTER_SPECS> = ['antaran_fortress', 'antaran_intruder', 'antaran_intruder', 'antaran_marauder'];
  for (const kind of garrison) {
    state.monsters.push({ id: allocWorldId(state), kind: kind as never, starId: planet.starId, dmgStructure: 0 });
  }
  state.monsters.sort((a, b) => a.id - b.id);
};

// ---------- move_colonists (in-system, freighter-lifted) ----------

interface MoveColonistsPayload {
  fromColonyId: number;
  toColonyId: number;
  race: number;
  count: number;
  /** the job the moved colonists vacate at the source (the UI drags SPECIFIC
   * citizens; without this the renormalizer always sheds scientists first) */
  fromJob?: 'farmers' | 'workers' | 'scientists';
}

/** Colonists move on freighters: free and instant between planets of the
 * SAME system (MOO2's in-system exception); BETWEEN systems each colonist
 * unit ties up one freighter fleet (5 freighters) for the whole trip and
 * arrives after normal travel time (wormholes: 1 turn). The source keeps at
 * least one unit, and the destination must have room. */
const validateMoveColonists: Validator = (state, cmd) => {
  const p = cmd.payload as MoveColonistsPayload;
  const from = ownColony(state, cmd, p?.fromColonyId);
  if (typeof from === 'string') return from;
  const to = colony(state, p?.toColonyId);
  if (!to) return `no colony ${p?.toColonyId}`;
  if (to.owner !== cmd.playerId) return `colony ${p?.toColonyId} not yours`;
  if (to.outpost) return 'outposts cannot take colonists';
  if (from.id === to.id) return 'already there';
  if (!Number.isSafeInteger(p.count) || p.count < 1) return 'bad count';
  if (p.race === NATIVE_RACE) return 'natives never leave their world';
  if (p.race === ANDROID_RACE) return 'androids are wired into this colony and never leave';
  const fromStarId = state.planets.find((x) => x.id === from.planetId)!.starId;
  const toStarId = state.planets.find((x) => x.id === to.planetId)!.starId;
  if (fromStarId !== toStarId) {
    const fromStar = state.stars.find((s) => s.id === fromStarId)!;
    const toStar = state.stars.find((s) => s.id === toStarId)!;
    if (!inRange(state, cmd.playerId, toStar) && fromStar.wormholeTo !== toStar.id) {
      return `${toStar.name} is out of fuel range for freighters`;
    }
    const empire = empireOf(state, cmd.playerId);
    const free = freeFreighters(state, empire);
    if (free < 5 * p.count) {
      return `moving ${p.count} colonist(s) between systems needs ${5 * p.count} free freighters (5 per colonist; ${free} free)`;
    }
  }
  const group = from.groups.find((g) => g.race === p.race);
  if (!group) return `no pop group for race ${p.race}`;
  const groupUnits = Math.floor(group.popK / 1000);
  const totalUnits = popUnitsOf(from);
  if (groupUnits < p.count) return `only ${groupUnits} unit(s) of that group`;
  if (totalUnits - p.count < 1) return 'the last colonist cannot leave';
  const cap = colonyMaxPop(state, to);
  const there = organicUnitsOf(to);
  const incoming = (state.popTransits ?? []).reduce((n, t) => n + (t.toColonyId === to.id ? t.units : 0), 0);
  if (there + incoming + p.count > cap) return `destination full (${there + incoming}/${cap} incl. en route)`;
  return null;
};

const applyMoveColonists: Applier = (state, cmd) => {
  const p = cmd.payload as MoveColonistsPayload;
  const from = colony(state, p.fromColonyId)!;
  const to = colony(state, p.toColonyId)!;
  const moveK = p.count * 1000;
  const src = from.groups.find((g) => g.race === p.race)!;
  src.popK -= moveK;
  // vacate the job the player actually grabbed from, then renormalize
  if (p.fromJob === 'farmers' || p.fromJob === 'workers' || p.fromJob === 'scientists') {
    src[p.fromJob] = Math.max(0, src[p.fromJob] - p.count);
  }
  normalizeJobsForGroup(src);
  if (src.popK <= 0) {
    from.groups = from.groups.filter((g) => g !== src);
  }
  const fromStarId = state.planets.find((x) => x.id === from.planetId)!.starId;
  const toStarId = state.planets.find((x) => x.id === to.planetId)!.starId;
  if (fromStarId === toStarId) {
    let dst = to.groups.find((g) => g.race === p.race);
    if (!dst) {
      dst = { race: p.race, popK: 0, farmers: 0, workers: 0, scientists: 0, unrest: false };
      to.groups.push(dst);
      to.groups.sort((a, b) => a.race - b.race);
    }
    dst.popK += moveK;
    dst.workers += p.count; // arrivals pick up tools first; reassign as you like
    return;
  }
  // between systems: colonists board freighters and sail
  const empire = empireOf(state, cmd.playerId);
  const fromStar = state.stars.find((s) => s.id === fromStarId)!;
  const toStar = state.stars.find((s) => s.id === toStarId)!;
  const turns = settlerTravelTurns(state, empire, fromStar, toStar);
  (state.popTransits ??= []).push({
    id: allocId(state, cmd.playerId),
    empireId: cmd.playerId,
    race: p.race,
    fromColonyId: from.id,
    toColonyId: to.id,
    units: p.count,
    departedTurn: state.turn,
    arrivalTurn: state.turn + turns,
  });
};

// ---------- UI telemetry (aggregate screen-time, shared via the log) ----------

interface TelemetryPayload {
  screens: Record<string, number>;
}

// ---- campaign-timelapse opt-in (types.ts timelapseVotes): the replay shows
// the whole map's history, so every living empire must consent. The last
// vote latches timelapseReadyTurn and resets the ballot — the group can run
// it again at the next session's end.
const validateTimelapseVote: Validator = (state, cmd) => {
  const empire = state.empires.find((e) => e.id === cmd.playerId);
  if (!empire) return 'no empire';
  if (empire.eliminated) return 'eliminated empires cannot vote';
  if ((state.timelapseVotes ?? []).includes(cmd.playerId)) return 'already opted in';
  return null;
};

const applyTimelapseVote: Applier = (state, cmd, events) => {
  const votes = [...(state.timelapseVotes ?? []), cmd.playerId].sort((a, b) => a - b);
  const living = state.empires.filter((e) => !e.eliminated).map((e) => e.id);
  if (living.every((id) => votes.includes(id))) {
    state.timelapseVotes = [];
    state.timelapseReadyTurn = state.turn;
    events?.push({ visibleTo: -1, kind: 'timelapse_ready', payload: { turn: state.turn } });
  } else {
    state.timelapseVotes = votes;
    events?.push({
      visibleTo: -1,
      kind: 'timelapse_vote',
      payload: { empireId: cmd.playerId, count: votes.length, needed: living.length },
    });
  }
};

const validateTelemetry: Validator = (state, cmd) => {
  const p = cmd.payload as TelemetryPayload;
  if (!p || typeof p.screens !== 'object' || p.screens === null || Array.isArray(p.screens)) return 'bad payload';
  const entries = Object.entries(p.screens);
  if (entries.length === 0 || entries.length > 20) return 'bad screens';
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 24) return 'bad screen key';
    if (!Number.isSafeInteger(v) || v < 0 || v > 86_400) return 'bad seconds';
  }
  void state;
  return null;
};

const applyTelemetry: Applier = (state, cmd) => {
  const p = cmd.payload as TelemetryPayload;
  const empire = empireOf(state, cmd.playerId);
  const t = { ...(empire.telemetry ?? {}) };
  for (const [k, v] of Object.entries(p.screens)) {
    t[k] = (t[k] ?? 0) + v;
  }
  empire.telemetry = t;
};

// ---------- trait reassignment (ecology docs: +4 pick points on research) ----------

interface TraitReassignPayload {
  add: string[];
  remove: string[];
}

/** "When trait reassignment is researched, you may choose 4 additional points
 * of race development picks, to either remove disadvantages or increase
 * advantages" (mechanics/tech/ecology.md). Once per game; governments are
 * never touched; exclusive pick groups must stay consistent. */
/** Shared by validate + apply so both fold the exact same result: returns the
 * final pick set, or an error string. Upgrading a held advantage a tier
 * (attack2 -> attack3, a documented use) releases the lower tier and charges
 * only the cost difference. */
function traitReassignResult(
  empire: { picks: string[] },
  p: TraitReassignPayload,
): Set<string> | string {
  const add = Array.isArray(p?.add) ? p.add : null;
  const remove = Array.isArray(p?.remove) ? p.remove : null;
  if (!add || !remove) return 'bad payload';
  if (add.length + remove.length === 0) return 'choose at least one change';
  let spent = 0;
  const picks = new Set<string>(empire.picks);
  for (const id of add) {
    const row = pickById.get(id);
    if (!row) return `unknown pick ${id}`;
    if (row.cost <= 0) return `${id} is not an advantage`;
    if ((GOVERNMENTS as readonly string[]).includes(id)) return 'governments cannot be reassigned';
    if (picks.has(id)) return `${id} already picked`;
    // tier upgrade within an exclusive family: swap out the held lower tier
    let credit = 0;
    for (const [group, members] of Object.entries(PICK_EXCLUSIVE_GROUPS)) {
      if (group === 'government' || !members.includes(id)) continue;
      for (const m of members) {
        if (m === id || !picks.has(m)) continue;
        const old = pickById.get(m);
        if (old && old.cost > 0 && old.cost < row.cost) {
          credit += old.cost;
          picks.delete(m);
        }
      }
    }
    spent += row.cost - credit;
    picks.add(id);
  }
  for (const id of remove) {
    const row = pickById.get(id);
    if (!row) return `unknown pick ${id}`;
    if (row.cost >= 0) return `${id} is not a disadvantage`;
    if (!picks.has(id)) return `${id} is not among your picks`;
    spent += -row.cost;
    picks.delete(id);
  }
  if (spent > 4) return `that spends ${spent} points — Trait Reassignment grants 4`;
  for (const [group, members] of Object.entries(PICK_EXCLUSIVE_GROUPS)) {
    if (group === 'government') continue;
    const chosen = members.filter((m) => picks.has(m));
    if (chosen.length > 1) return `picks are mutually exclusive: ${chosen.join(', ')}`;
  }
  return picks;
}

const validateTraitReassign: Validator = (state, cmd) => {
  const p = cmd.payload as TraitReassignPayload;
  const empire = empireOf(state, cmd.playerId);
  if (!empire.knownApps.includes('trait_reassignment')) return 'Trait Reassignment is not researched';
  if (empire.traitReassigned) return 'trait reassignment has already been used';
  const result = traitReassignResult(empire, p);
  return typeof result === 'string' ? result : null;
};

const applyTraitReassign: Applier = (state, cmd) => {
  const p = cmd.payload as TraitReassignPayload;
  const empire = empireOf(state, cmd.playerId);
  const result = traitReassignResult(empire, p);
  if (typeof result === 'string') return; // unreachable for validated commands
  empire.picks = [...result].sort();
  empire.traitReassigned = true;
};

// ---------- renaming + tags ----------

/** Fixed set of colony tags players can attach (UI filters on these). */
export const COLONY_TAGS = [
  'core',
  'border',
  'farm',
  'industry',
  'research',
  'military',
  'staging',
  'new',
] as const;

function validName(name: unknown): string | null {
  if (typeof name !== 'string') return 'name must be text';
  const trimmed = name.trim();
  if (trimmed.length < 1) return 'name must not be empty';
  if (trimmed.length > 24) return 'name too long (max 24)';
  return null;
}

const validateRenameStar: Validator = (state, cmd) => {
  const p = cmd.payload as { starId: number; name: string };
  const star = state.stars.find((s) => s.id === p?.starId);
  if (!star) return `no star ${p?.starId}`;
  // only a player with a settlement in the system may rename it
  const present = state.colonies.some((c) => {
    if (c.owner !== cmd.playerId) return false;
    const planet = state.planets.find((x) => x.id === c.planetId);
    return planet?.starId === star.id;
  });
  if (!present) return 'you need a colony or outpost in the system to rename its star';
  return validName(p.name);
};

const applyRenameStar: Applier = (state, cmd) => {
  const p = cmd.payload as { starId: number; name: string };
  state.stars.find((s) => s.id === p.starId)!.name = p.name.trim();
};

const validateRenameColony: Validator = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; name: string };
  const c = colony(state, p?.colonyId);
  if (!c) return `no colony ${p?.colonyId}`;
  if (c.owner !== cmd.playerId) return `colony ${p?.colonyId} not yours`;
  return validName(p.name);
};

const applyRenameColony: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; name: string };
  colony(state, p.colonyId)!.name = p.name.trim();
};

const validateSetColonyTags: Validator = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; tags: string[] };
  const c = colony(state, p?.colonyId);
  if (!c) return `no colony ${p?.colonyId}`;
  if (c.owner !== cmd.playerId) return `colony ${p?.colonyId} not yours`;
  if (!Array.isArray(p.tags)) return 'tags must be a list';
  for (const t of p.tags) {
    if (!(COLONY_TAGS as readonly string[]).includes(t)) return `unknown tag ${t}`;
  }
  if (new Set(p.tags).size !== p.tags.length) return 'duplicate tags';
  return null;
};

const applySetColonyTags: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; tags: string[] };
  const c = colony(state, p.colonyId)!;
  if (p.tags.length === 0) delete c.tags;
  else c.tags = [...p.tags].sort();
};

// ---------- council votes ----------

const validateVote: Validator = (state, cmd) => {
  const p = cmd.payload as { candidate: number };
  if (!state.council.pending) return 'no vote in progress';
  if (p.candidate !== -1 && !state.council.pending.candidates.includes(p.candidate)) {
    return 'not a candidate';
  }
  // you may abstain (-1) or back yourself, but voting FOR a candidate you have
  // never met makes no sense (and pre-contact fast-mode previews could not
  // even agree on who the candidates are)
  if (p.candidate !== -1 && p.candidate !== cmd.playerId && !metEmpireIds(state, cmd.playerId).has(p.candidate)) {
    return 'you have not met that candidate';
  }
  return null;
};

const applyVote: Applier = (state, cmd) => {
  const p = cmd.payload as { candidate: number };
  state.council.pending!.votes[String(cmd.playerId)] = p.candidate;
};

// ---------- debug commands (settings-gated, still deterministic + logged) ----------

/** Debug payloads are still hostile network JSON: a fractional amount/popK
 * would poison the canonical hash exactly like any other command. */
const validateDebug: Validator = (state, cmd) => {
  if (!state.settings.debugCommands) return 'debug commands disabled';
  const p = cmd.payload as Record<string, unknown>;
  switch (cmd.kind) {
    case 'debug_add_bc':
      if (!Number.isSafeInteger(p?.['amount']) || Math.abs(p['amount'] as number) > 1_000_000) return 'bad amount';
      return null;
    case 'debug_set_pop': {
      const popK = p?.['popK'];
      if (!Number.isSafeInteger(popK) || (popK as number) < 0 || (popK as number) > 100_000) return 'bad popK';
      return null;
    }
    case 'debug_spawn_ships':
      if (!Number.isSafeInteger(p?.['count']) || (p['count'] as number) < 1 || (p['count'] as number) > 20) return 'bad count';
      if (!Number.isSafeInteger(p?.['starId']) || !Number.isSafeInteger(p?.['designId'])) return 'bad ids';
      return null;
    case 'debug_grant_app':
      return typeof p?.['appId'] === 'string' && p['appId'].length <= 64 ? null : 'bad appId';
    default:
      return null;
  }
};

const applyDebugGrantApp: Applier = (state, cmd) => {
  const p = cmd.payload as { appId: string };
  const empire = empireOf(state, cmd.playerId);
  if (!empire.knownApps.includes(p.appId)) {
    empire.knownApps.push(p.appId);
    empire.knownApps.sort();
  }
};

const applyDebugAddBc: Applier = (state, cmd) => {
  const p = cmd.payload as { amount: number };
  empireOf(state, cmd.playerId).bc += p.amount;
};

const applyDebugSetPop: Applier = (state, cmd) => {
  const p = cmd.payload as { colonyId: number; popK: number };
  const c = colony(state, p.colonyId);
  if (c && c.groups[0]) {
    c.groups[0].popK = p.popK;
    normalizeJobsForGroup(c.groups[0]);
  }
};

/** Debug/bot-mode: found a ready-made colony on an unowned planet. Used by the
 * single-player bot's "granted the nearest colony" rule so the simulation
 * itself never special-cases bots. */
const validateDebugFoundColony: Validator = (state, cmd) => {
  if (!state.settings.debugCommands) return 'debug commands disabled';
  const p = cmd.payload as { planetId: number };
  const planet = state.planets.find((x) => x.id === p?.planetId);
  if (!planet) return `no planet ${p?.planetId}`;
  if (planet.body !== 'planet') return 'cannot colonize that body';
  if (state.colonies.some((c) => c.planetId === planet.id)) return 'already settled';
  return null;
};

const applyDebugFoundColony: Applier = (state, cmd) => {
  const p = cmd.payload as { planetId: number };
  const planet = state.planets.find((x) => x.id === p.planetId)!;
  const star = state.stars.find((s) => s.id === planet.starId)!;
  const empire = empireOf(state, cmd.playerId);
  state.colonies.push({
    id: allocId(state, cmd.playerId),
    planetId: planet.id,
    owner: cmd.playerId,
    name: star.name,
    groups: [{ race: cmd.playerId, popK: 2000, farmers: 1, workers: 1, scientists: 0, unrest: false }],
    buildings: [],
    queue: [],
    storedProd: 0,
    stickyInvested: {},
    boughtThisTurn: false,
    foodLackPrev: 0,
    prodLackPrev: 0,
    housingPPPrev: 0,
    outpost: false,
  });
  state.colonies.sort((a, b) => a.id - b.id);
  if (!empire.exploredStars.includes(star.id)) {
    empire.exploredStars.push(star.id);
    empire.exploredStars.sort((a, b) => a - b);
  }
};

const applyDebugSpawnShips: Applier = (state, cmd) => {
  const p = cmd.payload as { starId: number; designId: number; count: number };
  for (let i = 0; i < Math.min(p.count, 20); i++) {
    state.ships.push({
      id: allocId(state, cmd.playerId),
      owner: cmd.playerId,
      shipKind: 'design',
      designId: p.designId,
      location: { kind: 'star', starId: p.starId },
      cargoPopUnits: 0,
      cargoRace: cmd.playerId,
      dmgStructure: 0,
      dmgArmor: 0,
    });
  }
};

function normalizeJobsForGroup(g: PopGroup): void {
  const units = Math.floor(g.popK / 1000);
  let assigned = g.farmers + g.workers + g.scientists;
  while (assigned > units) {
    if (g.scientists > 0) g.scientists--;
    else if (g.workers > 0) g.workers--;
    else if (g.farmers > 0) g.farmers--;
    assigned--;
  }
  while (assigned < units) {
    // natives only ever farm; everyone else picks up tools first
    if (g.race === NATIVE_RACE) g.farmers++;
    else g.workers++;
    assigned++;
  }
  // natives shed INTO farming, never out of it
  if (g.race === NATIVE_RACE && (g.workers > 0 || g.scientists > 0)) {
    g.farmers += g.workers + g.scientists;
    g.workers = 0;
    g.scientists = 0;
  }
}

// ---------- registry ----------

export const COMMANDS: Record<string, { validate: Validator; apply: Applier }> = {
  // Durable completion marker: prevents a reloaded AI redoing an already
  // finished plan. No economy/turn advancement privileges; ordinary validation.
  ai_turn_complete: {
    validate: (state, cmd) => {
      if (!state.settings.singlePlayer?.opponents.some((p) => p.seat === cmd.playerId)) return 'not an AI seat';
      if (state.empires.find((e) => e.id === cmd.playerId)?.aiTurnCompleted === state.turn) return 'AI already finished this turn';
      return null;
    },
    apply: (state, cmd) => { state.empires.find((e) => e.id === cmd.playerId)!.aiTurnCompleted = state.turn; },
  },
  set_jobs: { validate: validateSetJobs, apply: applySetJobs },
  set_build_queue: { validate: validateSetQueue, apply: applySetQueue },
  buy_production: { validate: validateBuy, apply: applyBuy },
  set_research: { validate: validateSetResearch, apply: applySetResearch },
  queue_extra_research: { validate: validateExtraResearch, apply: applyExtraResearch },
  move_ships: { validate: validateMove, apply: applyMove },
  colonize: {
    validate: (s, c) => validateSettle(s, c, 'colony_ship'),
    apply: applyColonize,
  },
  build_outpost: {
    validate: (s, c) => validateSettle(s, c, 'outpost_ship'),
    apply: applyOutpost,
  },
  construct_planet: {
    validate: validateConstructPlanet,
    apply: applyConstructPlanet,
  },
  scrap_ship: { validate: validateScrap, apply: applyScrap },
  scrap_outpost: { validate: validateScrapOutpost, apply: applyScrapOutpost },
  sell_building: { validate: validateSellBuilding, apply: applySellBuilding },
  set_tax_rate: { validate: validateSetTax, apply: applySetTax },
  set_ship_style: { validate: validateSetShipStyle, apply: applySetShipStyle },
  save_design: { validate: validateSaveDesign, apply: applySaveDesign },
  obsolete_design: { validate: validateObsoleteDesign, apply: applyObsoleteDesign },
  declare_war: { validate: validateDeclareWar, apply: applyDeclareWar },
  offer_peace: { validate: validateOfferPeace, apply: applyOfferPeace },
  battle_orders: { validate: validateBattleOrders, apply: applyBattleOrders },
  load_transports: { validate: validateLoadTransports, apply: applyLoadTransports },
  unload_transports: { validate: validateUnloadTransports, apply: applyUnloadTransports },
  set_spy_orders: { validate: validateSpyOrders, apply: applySpyOrders },
  hire_leader: { validate: validateHireLeader, apply: applyHireLeader },
  dismiss_leader: { validate: validateDismissLeader, apply: applyDismissLeader },
  assign_leader: { validate: validateAssignLeader, apply: applyAssignLeader },
  diplo_propose: { validate: validatePropose, apply: applyPropose },
  diplo_respond: { validate: validateRespond, apply: applyRespond },
  attack_antarans: { validate: validateAttackAntarans, apply: applyAttackAntarans },
  resign: { validate: validateResign, apply: applyResign },
  cast_vote: { validate: validateVote, apply: applyVote },
  move_colonists: { validate: validateMoveColonists, apply: applyMoveColonists },
  trait_reassignment: { validate: validateTraitReassign, apply: applyTraitReassign },
  record_telemetry: { validate: validateTelemetry, apply: applyTelemetry },
  timelapse_vote: { validate: validateTimelapseVote, apply: applyTimelapseVote },
  rename_star: { validate: validateRenameStar, apply: applyRenameStar },
  rename_colony: { validate: validateRenameColony, apply: applyRenameColony },
  set_colony_tags: { validate: validateSetColonyTags, apply: applySetColonyTags },
  debug_grant_app: { validate: validateDebug, apply: applyDebugGrantApp },
  debug_add_bc: { validate: validateDebug, apply: applyDebugAddBc },
  debug_set_pop: { validate: validateDebug, apply: applyDebugSetPop },
  debug_spawn_ships: { validate: validateDebug, apply: applyDebugSpawnShips },
  debug_found_colony: { validate: validateDebugFoundColony, apply: applyDebugFoundColony },
};

export function validateCommand(state: GameState, cmd: EngineCommand): string | null {
  if (cmd.playerId >= 0) {
    const empire = state.empires.find((e) => e.id === cmd.playerId);
    if (!empire) return `no empire for player ${cmd.playerId}`;
    if (empire.eliminated) return 'empire eliminated';
    if (cmd.turn !== state.turn) return `command for turn ${cmd.turn}, current ${state.turn}`;
    if (state.phase === 'battle_orders' && cmd.kind !== 'battle_orders') {
      return 'battles are being resolved; only battle orders are accepted';
    }
  }
  const def = COMMANDS[cmd.kind];
  if (!def) return `unknown command ${cmd.kind}`;
  // malformed payloads (wrong field types from the network) must be REJECTED,
  // not thrown out of the host's command path
  try {
    return def.validate(state, cmd);
  } catch (e) {
    return `malformed ${cmd.kind} payload: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function applyCommand(state: GameState, cmd: EngineCommand, events?: TurnEvent[]): void {
  const def = COMMANDS[cmd.kind];
  if (!def) throw new Error(`unknown command ${cmd.kind}`);
  def.apply(state, cmd, events);
}

export { normalizeJobsForGroup };
