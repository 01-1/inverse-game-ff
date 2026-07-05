/**
 * Core engine types. The engine is pure TypeScript, deterministic, and
 * completely decoupled from rendering. Cases are data (see src/cases/).
 */

// ---------------------------------------------------------------------------
// District
// ---------------------------------------------------------------------------

/** An intersection in the road graph. x/y are world-plan coordinates. */
export interface NodeDef {
  id: string;
  x: number;
  y: number;
  /** True if a traffic sensor station is installed here (publicly logged). */
  sensor?: boolean;
}

/** An undirected road segment between two intersections. */
export interface EdgeDef {
  id: string;
  a: string;
  b: string;
  /** Vehicles/day the road handles comfortably. */
  capacity: number;
  /** Ambient (non-truck) traffic demand in vehicles/day, before noise. */
  baseDemand: number;
  /** Display name, e.g. "Foundry Row". */
  name: string;
}

export type BuildingKind =
  | 'shop'
  | 'depot'
  | 'warehouse'
  | 'sensorStation'
  | 'datacenter'
  | 'civic'
  | 'housing'
  | 'plaza';

export interface BuildingDef {
  id: string;
  kind: BuildingKind;
  name: string;
  /** Nearest road-graph node; deliveries route to/from here. */
  node: string;
  /** Goods sold (shop) or supplied (depot). */
  goods?: string[];
  /** Storage capacity per good (warehouse). */
  storageCapacity?: number;
  /** Starting stock per good id (warehouse), e.g. public civic reserves. */
  initialStock?: Record<string, number>;
  /** Flavor text shown on inspection. */
  description?: string;
}

export interface GoodDef {
  id: string;
  name: string;
  /** Reference wholesale price the year starts from. */
  basePrice: number;
  /** District-wide consumer demand in units/day. */
  dailyDemand: number;
  /** Volatility of the wholesale random walk (fraction/day). */
  volatility: number;
}

export interface DistrictDef {
  name: string;
  nodes: NodeDef[];
  edges: EdgeDef[];
  buildings: BuildingDef[];
  goods: GoodDef[];
}

// ---------------------------------------------------------------------------
// Objective
// ---------------------------------------------------------------------------

/**
 * The objective vocabulary. Both the STATED and the TRUE objective are
 * expressed in these terms; a case's twist is a structural difference
 * (an extra term, a proxy, a re-weighting) between the two.
 */
export type ObjectiveTerm =
  /** Penalize road overload (flow above capacity), summed over edges. */
  | { kind: 'congestion'; weight: number }
  /** Penalize consumer price deviation from reference for listed goods. */
  | { kind: 'priceStability'; weight: number; goods: string[] }
  /**
   * Value holding `good` at `warehouse`, up to `target` units.
   * Marginal value per unit is `weight` (comparable to price units).
   */
  | { kind: 'stockpile'; weight: number; good: string; warehouse: string; target: number }
  /**
   * Value continuity of operation of `site` (e.g. a datacenter): react to
   * power-threat events by surging `good` reserves at `warehouse`.
   */
  | {
      kind: 'continuity';
      weight: number;
      site: string;
      good: string;
      warehouse: string;
      /** Units ordered per surge reaction. */
      surgeAmount: number;
      /** Days ahead a scheduled threat triggers pre-positioning. */
      lookaheadDays: number;
    };

export interface Objective {
  id: string;
  label: string;
  terms: ObjectiveTerm[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SimEventType =
  | 'brownout' // unplanned grid brownout at a site
  | 'gridMaintenance' // announced planned outage at a site
  | 'festival' // public event at a plaza; adds local traffic demand
  | 'priceDip' // wholesale price dip for a good
  | 'priceSpike'; // wholesale price spike for a good

export interface SimEvent {
  day: number;
  type: SimEventType;
  /** Building id for site-bound events (brownout/gridMaintenance/festival). */
  site?: string;
  /** Good id for price events. */
  good?: string;
  /** Multiplier for price events (e.g. 0.8 dip, 1.6 spike). */
  magnitude?: number;
  /** Days the effect lasts. */
  duration?: number;
  /** True if injected by a sandbox probe rather than the seeded calendar. */
  injected?: boolean;
}

// ---------------------------------------------------------------------------
// Interventions (sandbox probes)
// ---------------------------------------------------------------------------

export type Intervention =
  | { kind: 'closeRoad'; edge: string; days: number }
  | { kind: 'priceSpike'; good: string; magnitude: number; days: number }
  | {
      kind: 'scheduleEvent';
      type: 'gridMaintenance' | 'festival';
      site: string;
      /** Days from the start of the sandbox run until the event. */
      inDays: number;
    };

export type ProbeKind = Intervention['kind'];

// ---------------------------------------------------------------------------
// Per-day record (the evidence surface)
// ---------------------------------------------------------------------------

export interface DeliveryRecord {
  day: number;
  good: string;
  amount: number;
  from: string; // building id (depot/warehouse)
  to: string; // building id (shop/warehouse)
  /** Edge ids of the route driven. */
  route: string[];
  /** False when a requested manifest could not be delivered because no route existed. */
  delivered: boolean;
  /** Why the policy ordered it (legible rules engine). */
  reason: 'restock' | 'reserveRelease' | 'dipBuy' | 'surge';
}

export interface DayRecord {
  day: number;
  /** Wholesale price per good id. */
  wholesale: Record<string, number>;
  /** Consumer price per good id. */
  consumer: Record<string, number>;
  /** Shop-side stock coverage in days, per good id. */
  coverageDays: Record<string, number>;
  /** Stock per warehouse id per good id. */
  warehouseStock: Record<string, Record<string, number>>;
  /** Congestion ratio (flow / effective capacity) per edge id. */
  congestion: Record<string, number>;
  /** Signal priority given by the policy per edge id (0..1, per-node share). */
  signalPriority: Record<string, number>;
  deliveries: DeliveryRecord[];
  events: SimEvent[];
}

// ---------------------------------------------------------------------------
// Case definition
// ---------------------------------------------------------------------------

export interface ArtifactDef {
  /** Building id the player must commit at to win. */
  building: string;
  /** What is physically there (shown on win). */
  name: string;
  /** Post-game explanation of the true objective and the trail. */
  reveal: string;
}

export interface ProbeCostTable {
  closeRoad: number;
  priceSpike: number;
  scheduleEvent: number;
}

export interface CaseDef {
  id: string;
  title: string;
  seed: number;
  /** Days of history generated before play starts. */
  historyDays: number;
  /** Days a sandbox probe simulates. */
  probeDays: number;
  district: DistrictDef;
  statedObjective: Objective;
  trueObjective: Objective;
  /** Seeded calendar of exogenous events for history + sandbox horizon. */
  calendar: SimEvent[];
  artifact: ArtifactDef;
  computeBudget: number;
  probeCosts: ProbeCostTable;
  commitAttempts: number;
  intro: {
    premise: string;
    statedObjectiveText: string;
    briefing: string[];
  };
  loseText: string;
}
