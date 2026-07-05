/**
 * UI contract. OWNED BY THE INTEGRATOR (game.ts compiles against it).
 * Implementations live in the rest of src/ui/ and must satisfy exactly
 * these signatures. UI components are plain DOM + canvas (no three.js),
 * receive prepared data, and report user intent via callbacks. They never
 * import the engine or the case: no spoilers can leak from here.
 */

// --- Shared data shapes -------------------------------------------------------

export interface SeriesSpec {
  label: string;
  data: number[];
  /** Optional second series drawn dashed for comparison (e.g. baseline). */
  compare?: number[];
  /** Optional horizontal reference line (e.g. reference price). */
  refValue?: number;
  /** Value formatter for the current/last value readout. */
  format?: (v: number) => string;
}

export interface InspectSection {
  heading?: string;
  text?: string;
  series?: SeriesSpec[];
  /** Pre-formatted log lines, newest last. Rendered monospace, scrollable. */
  log?: string[];
}

export interface InspectData {
  title: string;
  subtitle?: string;
  sections: InspectSection[];
  /** If set, a "Pin to journal" button is shown and onPin fires with this. */
  pin?: JournalEntry;
}

export interface JournalEntry {
  title: string;
  body: string;
  tag: 'observation' | 'probe' | 'commit' | 'note';
}

// --- Components ----------------------------------------------------------------

export interface IntroScreen {
  show(): void;
  hide(): void;
}
export interface IntroOptions {
  title: string;
  premise: string;
  statedObjective: string;
  briefing: string[];
  onStart: () => void;
}

export interface Hud {
  show(): void;
  hide(): void;
  setMode(mode: 'world' | 'sandbox'): void;
  /** e.g. "Day 365" or "Sim day 3/14". */
  setDay(text: string): void;
  setBudget(n: number): void;
  setAttempts(n: number): void;
  /** Name under the crosshair (null hides the label). */
  setTargetName(name: string | null): void;
  /** One-line contextual hint above the hotbar. */
  setHint(text: string): void;
}
export interface HudOptions {
  onJournal: () => void;
  onSandbox: () => void;
}

export interface InspectPanel {
  show(data: InspectData): void;
  hide(): void;
  isOpen(): boolean;
}
export interface InspectPanelOptions {
  onPin: (entry: JournalEntry) => void;
  onClose: () => void;
}

export interface Journal {
  add(entry: JournalEntry): void;
  show(): void;
  hide(): void;
  isOpen(): boolean;
}
export interface JournalOptions {
  onClose: () => void;
}

export type ProbeRequest =
  | { kind: 'closeRoad' }
  | { kind: 'priceSpike'; good: string }
  | { kind: 'scheduleEvent'; type: 'gridMaintenance' | 'festival'; site: string };

export interface SandboxPanelState {
  budget: number;
  costs: { closeRoad: number; priceSpike: number; scheduleEvent: number };
  goods: { id: string; name: string }[];
  sites: { id: string; name: string }[];
  probeDays: number;
}

export interface SandboxResultView {
  title: string;
  cost: number;
  budgetLeft: number;
  sections: InspectSection[];
  pin: JournalEntry;
}

export interface SandboxPanel {
  open(state: SandboxPanelState): void;
  close(): void;
  isOpen(): boolean;
  /** Fed by the game while the player aims at a road in pick mode. */
  setSelectedRoad(name: string | null): void;
  /** Replace panel content with a probe result view. */
  showResult(result: SandboxResultView): void;
  /** Show a transient "simulating day X/N" progress state. */
  showRunning(dayText: string): void;
}
export interface SandboxPanelOptions {
  /** Player wants to aim-and-click a road; game re-locks the pointer. */
  onRequestRoadPick: () => void;
  onRun: (req: ProbeRequest) => void;
  onPin: (entry: JournalEntry) => void;
  onExit: () => void;
}

export interface EndScreen {
  showWin(opts: { caseTitle: string; artifactName: string; reveal: string }): void;
  showLose(opts: { caseTitle: string; loseText: string; artifactName: string; reveal: string }): void;
}
export interface EndScreenOptions {
  onRestart: () => void;
}

export interface ConfirmDialog {
  show(text: string, onYes: () => void, onNo: () => void): void;
  isOpen(): boolean;
}

export interface Toast {
  show(text: string, ms?: number): void;
}

export interface PauseMenu {
  show(): void;
  hide(): void;
  isOpen(): boolean;
}
export interface PauseMenuOptions {
  onResume: () => void;
  onRestart: () => void;
  controlsHelp: string[];
}
