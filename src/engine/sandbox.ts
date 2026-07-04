/**
 * The sandbox: runs the FROZEN policy (the case's true objective — the player
 * never sees which) from the end-of-history state, with player interventions.
 * Probes cost compute budget. Baselines are free: the world is deterministic,
 * so the no-intervention run is computed once and reused.
 */

import { Simulation, type SimSnapshot } from './sim';
import type { CaseDef, DayRecord, Intervention, ProbeKind } from './types';

export interface ProbeResult {
  intervention: Intervention;
  cost: number;
  /** Day the probe window starts at (end of history). */
  startDay: number;
  days: number;
  baseline: DayRecord[];
  probe: DayRecord[];
}

export type CommitResult =
  | { outcome: 'win'; building: string }
  | { outcome: 'miss'; building: string; attemptsLeft: number }
  | { outcome: 'lose'; building: string };

export class Sandbox {
  readonly caseDef: CaseDef;
  private readonly endSnapshot: SimSnapshot;
  private baselineCache: DayRecord[] | null = null;
  private _budget: number;
  private _attemptsLeft: number;
  private _resolved: 'win' | 'lose' | null = null;
  readonly probes: ProbeResult[] = [];

  constructor(caseDef: CaseDef, endSnapshot: SimSnapshot) {
    this.caseDef = caseDef;
    this.endSnapshot = endSnapshot;
    this._budget = caseDef.computeBudget;
    this._attemptsLeft = caseDef.commitAttempts;
  }

  get budget(): number {
    return this._budget;
  }

  get attemptsLeft(): number {
    return this._attemptsLeft;
  }

  get resolved(): 'win' | 'lose' | null {
    return this._resolved;
  }

  probeCost(kind: ProbeKind): number {
    return this.caseDef.probeCosts[kind];
  }

  canAfford(kind: ProbeKind): boolean {
    return this._budget >= this.probeCost(kind);
  }

  /** The no-intervention run over the probe window (free, cached). */
  baseline(): DayRecord[] {
    if (!this.baselineCache) {
      const sim = new Simulation(this.caseDef, this.caseDef.trueObjective, this.endSnapshot);
      this.baselineCache = sim.runDays(this.caseDef.probeDays);
    }
    return this.baselineCache;
  }

  /**
   * Run one probe. Deducts budget; throws if unaffordable or case resolved.
   */
  runProbe(iv: Intervention): ProbeResult {
    if (this._resolved) throw new Error('Case already resolved');
    const cost = this.probeCost(iv.kind);
    if (this._budget < cost) throw new Error('Insufficient compute budget');
    this._budget -= cost;

    const sim = new Simulation(this.caseDef, this.caseDef.trueObjective, this.endSnapshot);
    sim.applyIntervention(iv);
    const probe = sim.runDays(this.caseDef.probeDays);
    const result: ProbeResult = {
      intervention: iv,
      cost,
      startDay: this.endSnapshot.day,
      days: this.caseDef.probeDays,
      baseline: this.baseline(),
      probe,
    };
    this.probes.push(result);
    return result;
  }

  /** Commit to a building as the artifact location. Binary, limited attempts. */
  commit(buildingId: string): CommitResult {
    if (this._resolved) throw new Error('Case already resolved');
    if (this._attemptsLeft <= 0) throw new Error('No attempts left');
    if (buildingId === this.caseDef.artifact.building) {
      this._resolved = 'win';
      return { outcome: 'win', building: buildingId };
    }
    this._attemptsLeft -= 1;
    if (this._attemptsLeft <= 0) {
      this._resolved = 'lose';
      return { outcome: 'lose', building: buildingId };
    }
    return { outcome: 'miss', building: buildingId, attemptsLeft: this._attemptsLeft };
  }
}
