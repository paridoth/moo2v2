import type { BattleOrders } from '@engine/combat';
import type { Empire, SinglePlayerConfig } from '@engine/types';
import type { ColonyRow, EmpireSummary, FleetRow, MoveOption, ResearchChoice } from '@engine/selectors';
import type { ShipDesign } from '@engine/shipdesign';

export type AiDifficulty = SinglePlayerConfig['difficulty'];
export type AiPersonality = SinglePlayerConfig['opponents'][number]['personality'];
export interface AiCommand { kind: string; payload: unknown }
export type JobGroups = Array<{ race: number; farmers: number; workers: number; scientists: number }>;
export interface DesignOption { id: number; hull: string; cost: number; cp: number; strength: number }
export type DesignPayload = Omit<ShipDesign, 'id' | 'obsolete' | 'auto'>;
export interface NavalObservation {
  templates: Array<{ role: 'escort' | 'assault'; design: DesignPayload; power: number; cost: number }>;
  designs: Array<{ id: number; power: number; cost: number }>;
  refits: Array<{ shipId: number; colonyId: number; designId: number; cost: number }>;
}

/** Data transfer object: policies never receive a GameState or session. */
export interface EmpireObservation {
  turn: number;
  self: Empire;
  summary: EmpireSummary;
  colonies: Array<ColonyRow & { suggestedJobs: JobGroups; strategicJobs: JobGroups; buildCosts: Record<string, number> }>;
  designs: DesignOption[];
  naval: NavalObservation;
  research: ResearchChoice[];
  fleets: Array<FleetRow & { moves: MoveOption[] }>;
  systems: Array<{
    id: number;
    explored: boolean;
    inRange: boolean;
    guarded: boolean;
    planets: Array<{ id: number; quality: number; occupied: boolean }>;
    colonies: Array<{ id: number; owner: number; outpost: boolean }>;
    ships: Array<{ id: number; owner: number; kind: string; hull: string | null }>;
  }>;
  contacts: Array<{ id: number; name: string }>;
  protectedContacts: number[];
  council: { candidates: number[]; voted: boolean } | null;
  enemies: number[];
  proposals: Array<{ id: number; from: number; kind: string }>;
  battles: Array<{ id: string; starId: number; attacking: boolean; ordered: boolean }>;
}

export interface StrategyContext { difficulty: AiDifficulty; personality: AiPersonality }
export interface StrategicPolicy {
  readonly id: SinglePlayerConfig['opponents'][number]['strategy'];
  plan(observation: EmpireObservation, context: StrategyContext): AiCommand[];
  battleOrders(observation: EmpireObservation, context: StrategyContext, battleId: string): BattleOrders;
}
