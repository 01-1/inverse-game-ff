/**
 * Rendering contract. OWNED BY THE INTEGRATOR (game.ts compiles against it).
 * The implementation lives in the rest of src/render/ and must satisfy
 * exactly these signatures. Rendering knows nothing about objectives,
 * probes, budgets, or the artifact — it draws a district and a day.
 */
import type { DayRecord, DistrictDef } from '../engine/types';

export type RenderMode = 'world' | 'sandbox';

export type PickTarget =
  | { kind: 'building'; id: string }
  | { kind: 'road'; id: string }
  | null;

export interface RenderApp {
  /** Start the render loop. Idempotent. */
  start(): void;
  dispose(): void;

  /** Restyle the whole scene: 'world' = daylight; 'sandbox' = hologram. */
  setMode(mode: RenderMode): void;

  /**
   * Drive animated life from a simulated day: car density per road follows
   * congestion, delivery trucks pulse along their recorded routes.
   * null = ambient idle.
   */
  setDayData(rec: DayRecord | null): void;

  /** What the crosshair currently points at (within interact range). */
  getPickTarget(): PickTarget;
  onPickChange(cb: (t: PickTarget) => void): void;

  /** Persistent highlight for a selected building/road (null clears). */
  setHighlight(t: PickTarget): void;

  /** Pointer lock. */
  lock(): void;
  unlock(): void;
  isLocked(): boolean;
  onLockChange(cb: (locked: boolean) => void): void;
}

export interface CreateRenderApp {
  (container: HTMLElement, district: DistrictDef): RenderApp;
}
