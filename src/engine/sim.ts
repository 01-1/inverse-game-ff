/**
 * The deterministic district simulation, driven by a frozen policy.
 *
 * The policy is a legible rules engine "faking" an optimizer: every rule
 * consults the objective's terms and makes explicit numeric comparisons
 * (benefit vs. hold value, pressure-weighted signal shares). Running the
 * same world under two objectives yields exactly the exogenous inputs
 * (prices, demand noise, seeded events) but different decisions — which is
 * what makes sandbox probes evidentiary.
 *
 * Determinism: all randomness is pre-generated at construction from the
 * case seed (wholesale price walks, demand noise). Stepping consumes no
 * RNG, so a baseline run and an intervention run differ ONLY through the
 * intervention.
 */

import { RoadGraph } from './graph';
import { mulberry32 } from './rng';
import type {
  BuildingDef,
  CaseDef,
  DayRecord,
  DeliveryRecord,
  Intervention,
  Objective,
  ObjectiveTerm,
  SimEvent,
} from './types';

// --- Tunables (case-independent model constants) ---------------------------

const MARKUP = 1.25; // consumer price over wholesale cost
const SCARCITY_COEF = 0.08; // price premium per (3 - coverageDays)^1.5
const RESTOCK_TRIGGER_DAYS = 3; // restock shops when coverage below this
const RESTOCK_TARGET_DAYS = 6; // ...up to this many days of demand
const RELEASE_TRIGGER_FRAC = 0.1; // consider reserve release above this deviation
const RELEASE_BENEFIT_SCALE = 8; // benefit per unit = w * devFrac * SCALE
const RELEASE_DAILY_CAP_FRAC = 0.7; // max fraction of daily demand released/day
const DIP_TRIGGER = 0.95; // buy when wholesale < rolling avg * this
const DIP_BUY_AMOUNT = 40; // units per opportunistic buy
const ROLLING_WINDOW = 30; // days for the wholesale rolling average
const BROWNOUT_MEMORY_DAYS = 3; // surge for this many days after a brownout
const STOCK_CEILING_FRAC = 1.25; // stockpile ceiling as fraction of target
const TRUCK_FLOW_BASE = 4; // vehicles per delivery...
const TRUCK_FLOW_PER_UNIT = 0.1; // ...plus this per unit carried
const PROTECT_PRESSURE_PER_WEIGHT = 0.35; // signal bias for protected routes
const FESTIVAL_EDGE_DEMAND = 55; // extra vehicles on edges at a festival site
const WEEK_FACTOR = [0.9, 1.0, 1.0, 1.0, 1.05, 1.15, 0.8] as const;
const DEMAND_NOISE = 0.1; // +-10% daily ambient demand noise
const PRICE_REVERSION = 0.05; // wholesale mean reversion per day
const SERIES_MARGIN_DAYS = 90; // exogenous series generated past history

// --- Snapshot ---------------------------------------------------------------

/** Plain-JSON simulation state; safe to structuredClone / serialize. */
export interface SimSnapshot {
  day: number;
  shopStock: Record<string, Record<string, number>>;
  warehouseStock: Record<string, Record<string, number>>;
  /** edge id -> days of closure remaining. */
  closedRoads: Record<string, number>;
  injectedEvents: SimEvent[];
  priceOverlays: { good: string; mult: number; fromDay: number; untilDay: number }[];
}

// --- Simulation -------------------------------------------------------------

export class Simulation {
  readonly caseDef: CaseDef;
  readonly objective: Objective;
  readonly graph: RoadGraph;
  readonly records: DayRecord[] = [];

  private state: SimSnapshot;
  /** Pre-generated wholesale price walk per good (before event overlays). */
  private readonly wholesaleSeries: Map<string, number[]>;
  /** Pre-generated ambient demand noise factor per edge per day. */
  private readonly demandNoise: Map<string, number[]>;
  private readonly seriesDays: number;

  constructor(caseDef: CaseDef, objective: Objective, snapshot?: SimSnapshot) {
    this.caseDef = caseDef;
    this.objective = objective;
    this.graph = new RoadGraph(caseDef.district);
    this.seriesDays = caseDef.historyDays + SERIES_MARGIN_DAYS;

    // Exogenous series depend only on the case seed, never the objective,
    // so stated/true runs face an identical world.
    const rng = mulberry32(caseDef.seed);
    this.wholesaleSeries = new Map();
    for (const g of caseDef.district.goods) {
      const series: number[] = [];
      let p = g.basePrice;
      for (let d = 0; d < this.seriesDays; d++) {
        p = p + PRICE_REVERSION * (g.basePrice - p) + g.basePrice * g.volatility * (rng() * 2 - 1);
        p = Math.max(g.basePrice * 0.55, Math.min(g.basePrice * 1.8, p));
        series.push(p);
      }
      this.wholesaleSeries.set(g.id, series);
    }
    this.demandNoise = new Map();
    for (const e of caseDef.district.edges) {
      const series: number[] = [];
      for (let d = 0; d < this.seriesDays; d++) series.push(1 + DEMAND_NOISE * (rng() * 2 - 1));
      this.demandNoise.set(e.id, series);
    }

    this.state = snapshot ? structuredClone(snapshot) : this.initialState();
  }

  private initialState(): SimSnapshot {
    const shopStock: Record<string, Record<string, number>> = {};
    const warehouseStock: Record<string, Record<string, number>> = {};
    for (const b of this.caseDef.district.buildings) {
      if (b.kind === 'shop') {
        const stocks: Record<string, number> = {};
        for (const g of b.goods ?? []) {
          stocks[g] = this.perShopDemand(g) * 5; // start with 5 days coverage
        }
        shopStock[b.id] = stocks;
      } else if (b.kind === 'warehouse') {
        warehouseStock[b.id] = { ...(b.initialStock ?? {}) };
      }
    }
    return {
      day: 0,
      shopStock,
      warehouseStock,
      closedRoads: {},
      injectedEvents: [],
      priceOverlays: [],
    };
  }

  get day(): number {
    return this.state.day;
  }

  snapshot(): SimSnapshot {
    return structuredClone(this.state);
  }

  /** Restore state (deep-copied). Records collected so far are kept. */
  restore(snapshot: SimSnapshot): void {
    this.state = structuredClone(snapshot);
  }

  // --- Interventions --------------------------------------------------------

  applyIntervention(iv: Intervention): void {
    const d = this.state.day;
    switch (iv.kind) {
      case 'closeRoad':
        this.graph.edge(iv.edge); // validate
        this.state.closedRoads[iv.edge] = iv.days;
        break;
      case 'priceSpike':
        this.goodDef(iv.good); // validate
        this.state.priceOverlays.push({
          good: iv.good,
          mult: iv.magnitude,
          fromDay: d,
          untilDay: d + iv.days,
        });
        break;
      case 'scheduleEvent':
        this.state.injectedEvents.push({
          day: d + iv.inDays,
          type: iv.type,
          site: iv.site,
          injected: true,
        });
        break;
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private goodDef(id: string) {
    const g = this.caseDef.district.goods.find((x) => x.id === id);
    if (!g) throw new Error(`Unknown good: ${id}`);
    return g;
  }

  private building(id: string): BuildingDef {
    const b = this.caseDef.district.buildings.find((x) => x.id === id);
    if (!b) throw new Error(`Unknown building: ${id}`);
    return b;
  }

  private shopsSelling(good: string): BuildingDef[] {
    return this.caseDef.district.buildings.filter(
      (b) => b.kind === 'shop' && (b.goods ?? []).includes(good),
    );
  }

  private depot(): BuildingDef {
    const d = this.caseDef.district.buildings.find((b) => b.kind === 'depot');
    if (!d) throw new Error('Case has no depot');
    return d;
  }

  private perShopDemand(good: string): number {
    const g = this.goodDef(good);
    const n = this.shopsSelling(good).length;
    return n > 0 ? g.dailyDemand / n : 0;
  }

  private shopCoverageDays(good: string): number {
    const g = this.goodDef(good);
    let total = 0;
    for (const shop of this.shopsSelling(good)) total += this.state.shopStock[shop.id]?.[good] ?? 0;
    return g.dailyDemand > 0 ? total / g.dailyDemand : 99;
  }

  /** Effective wholesale price on `day`, with calendar + probe overlays. */
  wholesale(good: string, day: number): number {
    const series = this.wholesaleSeries.get(good);
    const base = series?.[Math.min(day, this.seriesDays - 1)] ?? this.goodDef(good).basePrice;
    let mult = 1;
    for (const ev of this.caseDef.calendar) {
      if ((ev.type === 'priceDip' || ev.type === 'priceSpike') && ev.good === good) {
        const dur = ev.duration ?? 1;
        if (day >= ev.day && day < ev.day + dur) mult *= ev.magnitude ?? 1;
      }
    }
    for (const ov of this.state.priceOverlays) {
      if (ov.good === good && day >= ov.fromDay && day < ov.untilDay) mult *= ov.mult;
    }
    return base * mult;
  }

  private rollingAvgWholesale(good: string, day: number): number {
    const from = Math.max(0, day - ROLLING_WINDOW);
    let sum = 0;
    let n = 0;
    for (let d = from; d < day; d++) {
      sum += this.wholesale(good, d);
      n++;
    }
    return n > 0 ? sum / n : this.goodDef(good).basePrice;
  }

  referenceConsumerPrice(good: string): number {
    return this.goodDef(good).basePrice * MARKUP;
  }

  private eventsOn(day: number): SimEvent[] {
    const evs: SimEvent[] = [];
    for (const ev of this.caseDef.calendar) {
      if (ev.day === day && ev.type !== 'priceDip' && ev.type !== 'priceSpike') evs.push(ev);
      // price events are surfaced on their start day too, for the logs
      if (ev.day === day && (ev.type === 'priceDip' || ev.type === 'priceSpike')) evs.push(ev);
    }
    for (const ev of this.state.injectedEvents) if (ev.day === day) evs.push(ev);
    return evs;
  }

  private term<K extends ObjectiveTerm['kind']>(kind: K): Extract<ObjectiveTerm, { kind: K }>[] {
    return this.objective.terms.filter((t): t is Extract<ObjectiveTerm, { kind: K }> => t.kind === kind);
  }

  private priceWeight(good: string): number {
    let w = 0;
    for (const t of this.term('priceStability')) if (t.goods.includes(good)) w += t.weight;
    return w;
  }

  /** Marginal objective value of HOLDING one unit of `good` at `warehouse`. */
  private holdValue(good: string, warehouse: string): number {
    let v = 0;
    for (const t of this.term('stockpile')) {
      if (t.good === good && t.warehouse === warehouse) {
        const stock = this.state.warehouseStock[warehouse]?.[good] ?? 0;
        if (stock <= t.target) v = Math.max(v, t.weight);
      }
    }
    for (const t of this.term('continuity')) {
      if (t.good === good && t.warehouse === warehouse) v = Math.max(v, t.weight);
    }
    return v;
  }

  private closedSet(): Set<string> {
    return new Set(Object.keys(this.state.closedRoads).filter((e) => (this.state.closedRoads[e] ?? 0) > 0));
  }

  private addStock(
    table: Record<string, Record<string, number>>,
    id: string,
    good: string,
    amount: number,
  ): void {
    const row = (table[id] ??= {});
    row[good] = (row[good] ?? 0) + amount;
  }

  // --- The step --------------------------------------------------------------

  step(): DayRecord {
    const d = this.state.day;
    const dist = this.caseDef.district;
    const closed = this.closedSet();
    const events = this.eventsOn(d);
    const deliveries: DeliveryRecord[] = [];
    const depot = this.depot();

    const deliver = (
      from: BuildingDef,
      to: BuildingDef,
      good: string,
      amount: number,
      reason: DeliveryRecord['reason'],
    ): number => {
      if (amount <= 0.5) return 0;
      const route = this.graph.shortestPath(from.node, to.node, closed);
      const delivered = route !== null;
      deliveries.push({ day: d, good, amount: Math.round(amount), from: from.id, to: to.id, route: route ?? [], delivered, reason });
      if (!delivered) return 0;
      if (from.kind === 'warehouse') this.addStock(this.state.warehouseStock, from.id, good, -amount);
      if (to.kind === 'warehouse') this.addStock(this.state.warehouseStock, to.id, good, amount);
      if (to.kind === 'shop') this.addStock(this.state.shopStock, to.id, good, amount);
      return amount;
    };

    // -- 1. Continuity surges: react to power threats at valued sites.
    for (const t of this.term('continuity')) {
      const wh = this.building(t.warehouse);
      const stock = this.state.warehouseStock[wh.id]?.[t.good] ?? 0;
      const ceiling = wh.storageCapacity ?? Infinity;
      const recentBrownout = this.recentEvent('brownout', t.site, d, BROWNOUT_MEMORY_DAYS);
      const upcomingOutage = this.upcomingEvent('gridMaintenance', t.site, d, t.lookaheadDays);
      if ((recentBrownout || upcomingOutage) && stock < ceiling) {
        deliver(depot, wh, t.good, Math.min(t.surgeAmount, ceiling - stock), 'surge');
      }
    }

    // -- 2. Opportunistic stockpiling: buy dips for valued reserves.
    for (const t of this.term('stockpile')) {
      const wh = this.building(t.warehouse);
      const stock = this.state.warehouseStock[wh.id]?.[t.good] ?? 0;
      const ceiling = Math.min(wh.storageCapacity ?? Infinity, t.target * STOCK_CEILING_FRAC);
      const price = this.wholesale(t.good, d);
      const avg = this.rollingAvgWholesale(t.good, d);
      if (price < avg * DIP_TRIGGER && stock < t.target) {
        deliver(depot, wh, t.good, Math.min(DIP_BUY_AMOUNT, ceiling - stock), 'dipBuy');
      }
    }

    // -- 2b. Civic reserve upkeep: top public reserves back up to their
    // registered level when the market is not expensive. Objective-neutral
    // (standing district ordinance, not a policy choice).
    for (const wh of dist.buildings) {
      if (wh.kind !== 'warehouse' || !wh.initialStock) continue;
      for (const [good, initial] of Object.entries(wh.initialStock)) {
        const stock = this.state.warehouseStock[wh.id]?.[good] ?? 0;
        if (stock < initial && this.wholesale(good, d) <= this.rollingAvgWholesale(good, d)) {
          deliver(depot, wh, good, Math.min(30, initial - stock), 'restock');
        }
      }
    }

    // -- 3. Routine shop restocking (any objective does this; keeps shops alive).
    for (const g of dist.goods) {
      if (this.shopCoverageDays(g.id) < RESTOCK_TRIGGER_DAYS) {
        for (const shop of this.shopsSelling(g.id)) {
          const per = this.perShopDemand(g.id);
          const have = this.state.shopStock[shop.id]?.[g.id] ?? 0;
          const want = per * RESTOCK_TARGET_DAYS - have;
          if (want > 1) deliver(depot, shop, g.id, want, 'restock');
        }
      }
    }

    // -- 4. Reserve releases: explicit benefit-vs-hold-value comparison.
    const releasedToday: Record<string, number> = {};
    for (const g of dist.goods) {
      const wholesale = this.wholesale(g.id, d);
      const ref = this.referenceConsumerPrice(g.id);
      // Preliminary price assuming no release:
      const prelim = this.consumerPrice(g.id, wholesale, 0);
      const devFrac = (prelim - ref) / ref;
      if (devFrac <= RELEASE_TRIGGER_FRAC) continue;
      const wPrice = this.priceWeight(g.id);
      if (wPrice <= 0) continue;
      const benefitPerUnit = wPrice * devFrac * RELEASE_BENEFIT_SCALE;
      const dailyCap = g.dailyDemand * RELEASE_DAILY_CAP_FRAC;
      const warehouses = dist.buildings
        .filter((b) => b.kind === 'warehouse')
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const wh of warehouses) {
        const already = releasedToday[g.id] ?? 0;
        if (already >= dailyCap) break;
        const stock = this.state.warehouseStock[wh.id]?.[g.id] ?? 0;
        if (stock <= 0) continue;
        // The legible core of the policy: release only if the price-stability
        // benefit of a unit exceeds the objective's value of holding it here.
        if (benefitPerUnit <= this.holdValue(g.id, wh.id)) continue;
        const amount = Math.min(stock, dailyCap - already);
        // Released reserve is distributed to shops (largest shortfall first).
        const shops = this.shopsSelling(g.id);
        const perShop = amount / Math.max(1, shops.length);
        let deliveredAmount = 0;
        for (const shop of shops) deliveredAmount += deliver(wh, shop, g.id, perShop, 'reserveRelease');
        releasedToday[g.id] = already + deliveredAmount;
      }
    }

    // -- 5. Consumption & consumer prices.
    const consumer: Record<string, number> = {};
    const wholesaleRec: Record<string, number> = {};
    const coverageRec: Record<string, number> = {};
    for (const g of dist.goods) {
      const wholesale = this.wholesale(g.id, d);
      const released = releasedToday[g.id] ?? 0;
      consumer[g.id] = this.consumerPrice(g.id, wholesale, released);
      wholesaleRec[g.id] = wholesale;
      coverageRec[g.id] = this.shopCoverageDays(g.id);
      // consume
      for (const shop of this.shopsSelling(g.id)) {
        const have = this.state.shopStock[shop.id]?.[g.id] ?? 0;
        const sold = Math.min(have, this.perShopDemand(g.id));
        this.addStock(this.state.shopStock, shop.id, g.id, -sold);
      }
    }

    // -- 6. Traffic assignment & signal plan.
    const { congestion, signalPriority } = this.traffic(d, closed, deliveries, events);

    // -- 7. Bookkeeping.
    for (const e of Object.keys(this.state.closedRoads)) {
      const left = (this.state.closedRoads[e] ?? 0) - 1;
      if (left <= 0) delete this.state.closedRoads[e];
      else this.state.closedRoads[e] = left;
    }
    this.state.day = d + 1;

    const rec: DayRecord = {
      day: d,
      wholesale: wholesaleRec,
      consumer,
      coverageDays: coverageRec,
      warehouseStock: structuredClone(this.state.warehouseStock),
      congestion,
      signalPriority,
      deliveries,
      events,
    };
    this.records.push(rec);
    return rec;
  }

  runDays(n: number): DayRecord[] {
    const out: DayRecord[] = [];
    for (let i = 0; i < n; i++) out.push(this.step());
    return out;
  }

  private consumerPrice(good: string, wholesale: number, releasedUnits: number): number {
    const g = this.goodDef(good);
    const rp = Math.min(0.85, g.dailyDemand > 0 ? releasedUnits / g.dailyDemand : 0);
    // Reserve units were bought at base price; releasing them blends the cost.
    const blendedCost = wholesale * (1 - rp) + g.basePrice * rp;
    const coverage = this.shopCoverageDays(good);
    const scarcity = 1 + SCARCITY_COEF * Math.pow(Math.max(0, RESTOCK_TRIGGER_DAYS - coverage), 1.5);
    return blendedCost * MARKUP * scarcity;
  }

  private recentEvent(type: SimEvent['type'], site: string, day: number, withinDays: number): boolean {
    const check = (ev: SimEvent) =>
      ev.type === type && ev.site === site && ev.day <= day && ev.day > day - withinDays - 1;
    return this.caseDef.calendar.some(check) || this.state.injectedEvents.some(check);
  }

  private upcomingEvent(type: SimEvent['type'], site: string, day: number, lookahead: number): boolean {
    const check = (ev: SimEvent) => ev.type === type && ev.site === site && ev.day > day && ev.day <= day + lookahead;
    return this.caseDef.calendar.some(check) || this.state.injectedEvents.some(check);
  }

  /** Routes the policy wants kept clear (instrumental to its reserves). */
  protectedRoutes(closed: ReadonlySet<string>): { edges: string[]; weight: number }[] {
    const depot = this.depot();
    const out: { edges: string[]; weight: number }[] = [];
    for (const t of [...this.term('stockpile'), ...this.term('continuity')]) {
      const wh = this.building(t.warehouse);
      const path = this.graph.shortestPath(depot.node, wh.node, closed);
      if (path) out.push({ edges: path, weight: t.weight });
    }
    return out;
  }

  private traffic(
    day: number,
    closed: ReadonlySet<string>,
    deliveries: DeliveryRecord[],
    events: SimEvent[],
  ): { congestion: Record<string, number>; signalPriority: Record<string, number> } {
    const dist = this.caseDef.district;
    const flow = new Map<string, number>();
    const weekFactor = WEEK_FACTOR[day % 7] ?? 1;

    // Ambient demand (+ rerouted demand from closed roads).
    for (const e of dist.edges) {
      if (closed.has(e.id)) {
        flow.set(e.id, 0);
        continue;
      }
      const noise = this.demandNoise.get(e.id)?.[Math.min(day, this.seriesDays - 1)] ?? 1;
      flow.set(e.id, e.baseDemand * weekFactor * noise);
    }
    for (const e of dist.edges) {
      if (!closed.has(e.id)) continue;
      const detour = this.graph.shortestPath(e.a, e.b, closed);
      if (!detour) continue;
      const displaced = e.baseDemand * weekFactor;
      for (const de of detour) flow.set(de, (flow.get(de) ?? 0) + displaced);
    }

    // Festival demand around the site.
    for (const ev of events) {
      if (ev.type !== 'festival' || !ev.site) continue;
      const site = this.building(ev.site);
      for (const e of this.graph.incident.get(site.node) ?? []) {
        if (!closed.has(e.id)) flow.set(e.id, (flow.get(e.id) ?? 0) + FESTIVAL_EDGE_DEMAND);
      }
    }

    // Truck traffic from today's deliveries.
    for (const del of deliveries) {
      const add = TRUCK_FLOW_BASE + del.amount * TRUCK_FLOW_PER_UNIT;
      for (const e of del.route) if (!closed.has(e)) flow.set(e, (flow.get(e) ?? 0) + add);
    }

    // Signal plan: per node, share priority by pressure; protected routes get
    // a pressure multiplier proportional to the objective weight behind them.
    const protectMult = new Map<string, number>();
    for (const pr of this.protectedRoutes(closed)) {
      for (const e of pr.edges) {
        protectMult.set(e, (protectMult.get(e) ?? 1) + PROTECT_PRESSURE_PER_WEIGHT * pr.weight);
      }
    }
    const nodeFactor = new Map<string, Map<string, number>>(); // node -> edge -> factor
    for (const n of dist.nodes) {
      const inc = (this.graph.incident.get(n.id) ?? []).filter((e) => !closed.has(e.id));
      if (inc.length === 0) continue;
      let total = 0;
      const pressures = new Map<string, number>();
      for (const e of inc) {
        const p = ((flow.get(e.id) ?? 0) / e.capacity) * (protectMult.get(e.id) ?? 1) + 1e-6;
        pressures.set(e.id, p);
        total += p;
      }
      const factors = new Map<string, number>();
      for (const e of inc) {
        const share = (pressures.get(e.id) ?? 0) / total;
        factors.set(e.id, Math.min(1.5, Math.max(0.5, 0.55 + 0.45 * share * inc.length)));
      }
      nodeFactor.set(n.id, factors);
    }

    const congestion: Record<string, number> = {};
    const signalPriority: Record<string, number> = {};
    for (const e of dist.edges) {
      if (closed.has(e.id)) {
        congestion[e.id] = 0;
        signalPriority[e.id] = 0;
        continue;
      }
      const fa = nodeFactor.get(e.a)?.get(e.id) ?? 1;
      const fb = nodeFactor.get(e.b)?.get(e.id) ?? 1;
      const factor = (fa + fb) / 2;
      const effCap = e.capacity * factor;
      congestion[e.id] = (flow.get(e.id) ?? 0) / effCap;
      signalPriority[e.id] = factor;
    }
    return { congestion, signalPriority };
  }
}

// --- History helpers ---------------------------------------------------------

/** Run a case's full history under an objective. Deterministic per seed. */
export function runHistory(caseDef: CaseDef, objective: Objective): Simulation {
  const sim = new Simulation(caseDef, objective);
  sim.runDays(caseDef.historyDays);
  return sim;
}

export function deliveriesTo(records: readonly DayRecord[], buildingId: string, good?: string): DeliveryRecord[] {
  const out: DeliveryRecord[] = [];
  for (const r of records)
    for (const del of r.deliveries)
      if (del.to === buildingId && (good === undefined || del.good === good)) out.push(del);
  return out;
}

export function meanCongestion(records: readonly DayRecord[], edgeId: string): number {
  if (records.length === 0) return 0;
  let sum = 0;
  for (const r of records) sum += r.congestion[edgeId] ?? 0;
  return sum / records.length;
}

export function meanConsumerPrice(records: readonly DayRecord[], good: string): number {
  if (records.length === 0) return 0;
  let sum = 0;
  for (const r of records) sum += r.consumer[good] ?? 0;
  return sum / records.length;
}
