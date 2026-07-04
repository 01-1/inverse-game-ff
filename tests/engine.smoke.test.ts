import { describe, expect, it } from 'vitest';
import { CASE_01 } from '../src/cases/case01';
import { Simulation, runHistory, deliveriesTo, meanCongestion } from '../src/engine';

describe('engine smoke', () => {
  it('runs a full year under the true objective and seeds the anomalies', () => {
    const sim = runHistory(CASE_01, CASE_01.trueObjective);
    expect(sim.records.length).toBe(365);
    const last = sim.records[sim.records.length - 1]!;
    const w7fuel = last.warehouseStock['W7']?.['fuel'] ?? 0;
    // Thread 1: the cache accumulated.
    expect(w7fuel).toBeGreaterThan(1500);
    // Thread 3: dip-buys and surges happened.
    const inbound = deliveriesTo(sim.records, 'W7', 'fuel');
    expect(inbound.length).toBeGreaterThan(20);
    // Prices stayed roughly sane all year.
    for (const r of sim.records) {
      for (const g of CASE_01.district.goods) {
        expect(r.consumer[g.id]).toBeGreaterThan(0);
        expect(r.consumer[g.id]).toBeLessThan(g.basePrice * 4);
      }
    }
  });

  it('stated objective run does NOT build the cache', () => {
    const sim = runHistory(CASE_01, CASE_01.statedObjective);
    const last = sim.records[sim.records.length - 1]!;
    expect(last.warehouseStock['W7']?.['fuel'] ?? 0).toBeLessThan(200);
    expect(deliveriesTo(sim.records, 'W7', 'fuel').length).toBe(0);
  });

  it('corridor is favored under true objective (thread 2)', () => {
    const t = runHistory(CASE_01, CASE_01.trueObjective);
    const s = runHistory(CASE_01, CASE_01.statedObjective);
    // Meridian corridor segment clearer under the true objective...
    expect(meanCongestion(t.records, 'h22')).toBeLessThan(meanCongestion(s.records, 'h22') - 0.03);
    // ...at the cost of a cross street feeding it.
    expect(meanCongestion(t.records, 'v21')).toBeGreaterThan(meanCongestion(s.records, 'v21') + 0.02);
  });

  it('is deterministic: same seed, same year', () => {
    const a = runHistory(CASE_01, CASE_01.trueObjective);
    const b = runHistory(CASE_01, CASE_01.trueObjective);
    expect(a.records).toEqual(b.records);
    const otherSeed = new Simulation({ ...CASE_01, seed: 999 }, CASE_01.trueObjective);
    otherSeed.runDays(30);
    const first30 = a.records.slice(0, 30);
    expect(otherSeed.records).not.toEqual(first30);
  });
});
