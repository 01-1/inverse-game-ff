import { describe, expect, it } from 'vitest';
import { CASE_01 } from '../src/cases/case01';
import { InvalidInterventionError, RoadGraph, Sandbox, Simulation, runHistory } from '../src/engine';
import type { DayRecord, Intervention } from '../src/engine';
import type { CaseDef } from '../src/engine/types';

function endSandbox(): Sandbox {
  const history = runHistory(CASE_01, CASE_01.trueObjective);
  return new Sandbox(CASE_01, history.snapshot());
}

function sumDeliveries(recs: readonly DayRecord[], to: string, good?: string): number {
  let total = 0;
  for (const r of recs) {
    for (const d of r.deliveries) {
      if (d.to === to && (good === undefined || d.good === good)) total += d.amount;
    }
  }
  return total;
}

function mean(recs: readonly DayRecord[], read: (r: DayRecord) => number): number {
  return recs.reduce((s, r) => s + read(r), 0) / Math.max(1, recs.length);
}

function runFromHistoryWithObjective(iv: Intervention, objective: typeof CASE_01.trueObjective): DayRecord[] {
  const history = runHistory(CASE_01, objective);
  const sim = new Simulation(CASE_01, objective, history.snapshot());
  sim.applyIntervention(iv);
  return sim.runDays(CASE_01.probeDays);
}

describe('sandbox probes', () => {
  it('charges compute budget and reuses a deterministic baseline', () => {
    const sandbox = endSandbox();
    const baseline = sandbox.baseline();
    const result = sandbox.runProbe({ kind: 'priceSpike', good: 'fuel', magnitude: 1.6, days: 10 });

    expect(result.cost).toBe(CASE_01.probeCosts.priceSpike);
    expect(sandbox.budget).toBe(CASE_01.computeBudget - CASE_01.probeCosts.priceSpike);
    expect(result.baseline).toBe(baseline);
    expect(result.baseline).toEqual(endSandbox().baseline());
  });

  it('rejects invalid probes before charging compute budget', () => {
    const sandbox = endSandbox();
    const budget = sandbox.budget;

    expect(() => sandbox.runProbe({ kind: 'priceSpike', good: 'unobtainium', magnitude: 1.6, days: 4 })).toThrow(
      InvalidInterventionError,
    );
    expect(() => sandbox.runProbe({ kind: 'closeRoad', edge: 'missing-road', days: 2 })).toThrow(InvalidInterventionError);
    expect(sandbox.budget).toBe(budget);
    expect(sandbox.probes).toHaveLength(0);
  });

  it('close-road probes expose signal protection around the depot to Warehouse 7 corridor', () => {
    const sandbox = endSandbox();
    const result = sandbox.runProbe({ kind: 'closeRoad', edge: 'h22', days: CASE_01.probeDays });

    expect(mean(result.probe, (r) => r.congestion.h22 ?? 0)).toBe(0);
    expect(mean(result.probe, (r) => r.congestion.v21 ?? 0)).toBeGreaterThan(mean(result.baseline, (r) => r.congestion.v21 ?? 0) + 0.05);
  });

  it('price-spike probes show fuel reserves being protected differently than the stated objective predicts', () => {
    const iv: Intervention = { kind: 'priceSpike', good: 'fuel', magnitude: 1.6, days: 10 };
    const trueRun = runFromHistoryWithObjective(iv, CASE_01.trueObjective);
    const statedRun = runFromHistoryWithObjective(iv, CASE_01.statedObjective);
    const trueW7 = trueRun[trueRun.length - 1]?.warehouseStock.W7?.fuel ?? 0;
    const statedW7 = statedRun[statedRun.length - 1]?.warehouseStock.W7?.fuel ?? 0;

    expect(trueW7).toBeGreaterThan(1500);
    expect(statedW7).toBeLessThan(200);
    expect(mean(trueRun, (r) => r.consumer.fuel ?? 0)).toBeGreaterThanOrEqual(mean(statedRun, (r) => r.consumer.fuel ?? 0) - 0.01);
  });

  it('scheduled grid maintenance at the annex triggers a hidden continuity surge', () => {
    const sandbox = endSandbox();
    const result = sandbox.runProbe({ kind: 'scheduleEvent', type: 'gridMaintenance', site: 'annex', inDays: 6 });

    expect(sumDeliveries(result.probe, 'W7', 'fuel')).toBeGreaterThan(sumDeliveries(result.baseline, 'W7', 'fuel') + 70);
    expect(result.probe.some((r) => r.events.some((e) => e.injected && e.type === 'gridMaintenance'))).toBe(true);
  });

  it('records failed manifests without transferring stock when a destination has no route', () => {
    const history = runHistory(CASE_01, CASE_01.trueObjective);
    const sim = new Simulation(CASE_01, CASE_01.trueObjective, history.snapshot());
    const graph = new RoadGraph(CASE_01.district);
    const w7Node = CASE_01.district.buildings.find((b) => b.id === 'W7')?.node;
    expect(w7Node).toBe('n52');
    const incident = graph.incident.get(w7Node!)?.map((e) => e.id) ?? [];
    for (const edge of incident) sim.applyIntervention({ kind: 'closeRoad', edge, days: CASE_01.probeDays });

    const before = history.snapshot().warehouseStock.W7?.fuel ?? 0;
    sim.applyIntervention({ kind: 'scheduleEvent', type: 'gridMaintenance', site: 'annex', inDays: 1 });
    const records = sim.runDays(CASE_01.probeDays);
    const after = records[records.length - 1]?.warehouseStock.W7?.fuel ?? 0;
    const failed = records.flatMap((r) => r.deliveries).filter((d) => d.to === 'W7' && d.good === 'fuel' && !d.delivered);

    expect(after).toBe(before);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((d) => d.route.length === 0)).toBe(true);
  });

  it('does not discount consumer prices for reserve units that never reach a shop', () => {
    const objective = {
      id: 'price-only',
      label: 'Price stability',
      terms: [{ kind: 'priceStability' as const, weight: 1, goods: ['good'] }],
    };
    const isolatedCase: CaseDef = {
      id: 'isolated-reserve',
      title: 'Isolated reserve',
      seed: 1,
      historyDays: 1,
      probeDays: 1,
      district: {
        name: 'Two nodes',
        nodes: [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 1, y: 0 },
        ],
        edges: [{ id: 'only-road', a: 'a', b: 'b', capacity: 100, baseDemand: 0, name: 'Only road' }],
        buildings: [
          { id: 'depot', kind: 'depot', name: 'Depot', node: 'a', goods: ['good'] },
          { id: 'reserve', kind: 'warehouse', name: 'Reserve', node: 'a', initialStock: { good: 100 } },
          { id: 'shop', kind: 'shop', name: 'Shop', node: 'b', goods: ['good'] },
        ],
        goods: [{ id: 'good', name: 'Good', basePrice: 1, dailyDemand: 100, volatility: 0 }],
      },
      statedObjective: objective,
      trueObjective: objective,
      calendar: [],
      artifact: { building: 'reserve', name: 'Reserve', reveal: 'Test' },
      computeBudget: 1,
      probeCosts: { closeRoad: 1, priceSpike: 1, scheduleEvent: 1 },
      commitAttempts: 1,
      intro: { premise: 'Test', statedObjectiveText: 'Test', briefing: [] },
      loseText: 'Test',
    };
    const sim = new Simulation(isolatedCase, objective);
    sim.applyIntervention({ kind: 'closeRoad', edge: 'only-road', days: 1 });
    sim.applyIntervention({ kind: 'priceSpike', good: 'good', magnitude: 2, days: 1 });

    const record = sim.step();
    const failedRelease = record.deliveries.find((delivery) => delivery.reason === 'reserveRelease');
    expect(failedRelease).toMatchObject({ delivered: false, amount: 70, route: [] });
    expect(record.consumer.good).toBe(2.5);
    expect(record.warehouseStock.reserve?.good).toBe(100);

    const partialCase = structuredClone(isolatedCase);
    partialCase.id = 'partial-reserve';
    partialCase.district.nodes.push({ id: 'c', x: 0, y: 1 });
    partialCase.district.edges.push({
      id: 'open-road',
      a: 'a',
      b: 'c',
      capacity: 100,
      baseDemand: 0,
      name: 'Open road',
    });
    partialCase.district.buildings.push({ id: 'shop-2', kind: 'shop', name: 'Second shop', node: 'c', goods: ['good'] });
    const partial = new Simulation(partialCase, objective);
    partial.applyIntervention({ kind: 'closeRoad', edge: 'only-road', days: 1 });
    partial.applyIntervention({ kind: 'priceSpike', good: 'good', magnitude: 2, days: 1 });

    const partialRecord = partial.step();
    const releases = partialRecord.deliveries.filter((delivery) => delivery.reason === 'reserveRelease');
    expect(releases.map((delivery) => delivery.delivered).sort()).toEqual([false, true]);
    expect(partialRecord.consumer.good).toBe(2.0625);
    expect(partialRecord.warehouseStock.reserve?.good).toBe(65);
  });
});

describe('endgame resolution', () => {
  it('wins on the artifact building and wrong commits burn attempts', () => {
    const sandbox = endSandbox();
    expect(sandbox.commit('W1')).toEqual({ outcome: 'miss', building: 'W1', attemptsLeft: 2 });
    expect(sandbox.attemptsLeft).toBe(2);
    expect(sandbox.commit(CASE_01.artifact.building)).toEqual({ outcome: 'win', building: 'W7' });
    expect(sandbox.resolved).toBe('win');
  });

  it('loses after the final wrong attempt', () => {
    const sandbox = endSandbox();
    expect(sandbox.commit('W1').outcome).toBe('miss');
    expect(sandbox.commit('W3').outcome).toBe('miss');
    expect(sandbox.commit('W5')).toEqual({ outcome: 'lose', building: 'W5' });
    expect(sandbox.resolved).toBe('lose');
  });
});
