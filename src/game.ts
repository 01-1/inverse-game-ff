/**
 * Game integration: wires the deterministic engine (history + sandbox),
 * the 3D renderer, and the DOM UI into the detective loop.
 *
 * Spoiler discipline: everything shown to the player is either the stated
 * objective, raw public records (prices, stocks, deliveries, congestion,
 * events — never the policy's internal `reason` labels), or sandbox
 * behavior. The true objective and artifact only surface at resolution.
 */

import type { BuildingDef, CaseDef, DayRecord, EdgeDef, Intervention } from './engine/types';
import { Sandbox, Simulation, runHistory, type ProbeResult } from './engine';
import { createRenderApp } from './render';
import {
  createConfirm,
  createEndgame,
  createHud,
  createInspectPanel,
  createIntro,
  createJournal,
  createPauseMenu,
  createSandboxPanel,
  createToast,
} from './ui';
import type {
  InspectData,
  InspectSection,
  JournalEntry,
  ProbeRequest,
  SeriesSpec,
} from './ui/types';
import type { PickTarget, RenderApp } from './render/types';

const PLAYBACK_MS_PER_DAY = 300;
const SPIKE_MAGNITUDE = 1.6;
const SPIKE_DAYS = 10;
const EVENT_LEAD_DAYS = 6;

const CONTROLS_HELP = [
  'WASD — move · mouse — look · Q/E or Space/Shift — down/up',
  'Left click or F — inspect what you are looking at',
  'Tab — journal · B — sandbox · G — commit at a building',
  'Esc — release mouse / pause',
];

type GameState = 'intro' | 'playing' | 'playback' | 'ended';

export class Game {
  private readonly caseDef: CaseDef;
  private readonly historySim: Simulation;
  private readonly history: DayRecord[];
  private readonly sandbox: Sandbox;
  private readonly render: RenderApp;

  private state: GameState = 'intro';
  private mode: 'world' | 'sandbox' = 'world';
  private pickingRoad = false;
  private selectedRoadId: string | null = null;
  private inspectedOnce = new Set<string>();
  private playbackTimer: number | null = null;

  // UI
  private readonly hud;
  private readonly intro;
  private readonly inspect;
  private readonly journal;
  private readonly sandboxPanel;
  private readonly endScreen;
  private readonly confirm;
  private readonly toast;
  private readonly menu;

  constructor(root: HTMLElement, caseDef: CaseDef) {
    this.caseDef = caseDef;

    // Generate the year. Every anomaly the player can find is a real
    // consequence of running the frozen policy under its true objective.
    this.historySim = runHistory(caseDef, caseDef.trueObjective);
    this.history = this.historySim.records;
    this.sandbox = new Sandbox(caseDef, this.historySim.snapshot());

    this.render = createRenderApp(root, caseDef.district);

    this.toast = createToast(root);
    this.confirm = createConfirm(root);
    this.hud = createHud(root, {
      onJournal: () => this.toggleJournal(),
      onSandbox: () => this.toggleSandbox(),
    });
    this.inspect = createInspectPanel(root, {
      onPin: (e) => this.pin(e),
      onClose: () => this.closePanelsAndRelock(),
    });
    this.journal = createJournal(root, { onClose: () => this.closePanelsAndRelock() });
    this.sandboxPanel = createSandboxPanel(root, {
      onRequestRoadPick: () => this.startRoadPick(),
      onRun: (req) => this.runProbe(req),
      onPin: (e) => this.pin(e),
      onExit: () => this.exitSandbox(),
    });
    this.endScreen = createEndgame(root, { onRestart: () => window.location.reload() });
    this.menu = createPauseMenu(root, {
      onResume: () => {
        this.menu.hide();
        this.render.lock();
      },
      onRestart: () => window.location.reload(),
      controlsHelp: CONTROLS_HELP,
    });
    this.intro = createIntro(root, {
      title: caseDef.title,
      premise: caseDef.intro.premise,
      statedObjective: caseDef.intro.statedObjectiveText,
      briefing: caseDef.intro.briefing,
      onStart: () => this.begin(),
    });

    this.loadingScreen = this.createLoadingScreen(root);

    this.wireInput();
    this.render.start();
    this.render.setDayData(this.lastHistoryDay());
    this.render.onProgress((loaded, total) => this.onLoadProgress(loaded, total));
    if (this.render.isReady()) this.hideLoadingScreen();
  }

  private readonly loadingScreen: {
    node: HTMLElement;
    bar: HTMLElement;
    label: HTMLElement;
  };
  private assetsReady = false;

  private createLoadingScreen(root: HTMLElement): { node: HTMLElement; bar: HTMLElement; label: HTMLElement } {
    const node = document.createElement('div');
    node.style.cssText =
      'position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
      'background:radial-gradient(120% 120% at 50% 0%,#10171b 0%,#070b0d 70%);color:#eef3ee;' +
      "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;";
    const title = document.createElement('div');
    title.textContent = 'INVERSE';
    title.style.cssText = 'font-size:34px;font-weight:800;letter-spacing:.42em;padding-left:.42em;color:#f7c85b;text-shadow:0 0 24px rgba(247,200,91,.35);';
    const sub = document.createElement('div');
    sub.textContent = 'Reconstructing Basin East from the archives';
    sub.style.cssText = 'font-size:13px;letter-spacing:.05em;color:#9aa89a;';
    const track = document.createElement('div');
    track.style.cssText = 'width:min(360px,70vw);height:5px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;';
    const bar = document.createElement('div');
    bar.style.cssText = 'width:8%;height:100%;background:linear-gradient(90deg,#d7a93b,#f7c85b);transition:width .25s ease;';
    track.append(bar);
    const label = document.createElement('div');
    label.style.cssText = 'font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#8fb4a0;';
    label.textContent = 'Loading assets…';
    node.append(title, sub, track, label);
    root.append(node);
    return { node, bar, label };
  }

  private onLoadProgress(loaded: number, total: number): void {
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    this.loadingScreen.bar.style.width = `${Math.max(8, pct)}%`;
    this.loadingScreen.label.textContent = total > 0 ? `Loading district assets… ${pct}%` : 'Loading district assets…';
    if (this.render.isReady() && !this.assetsReady) {
      this.assetsReady = true;
      this.hideLoadingScreen();
    }
  }

  private hideLoadingScreen(): void {
    const { node, bar, label } = this.loadingScreen;
    bar.style.width = '100%';
    label.textContent = 'Ready';
    node.style.transition = 'opacity .4s ease';
    node.style.opacity = '0';
    node.style.pointerEvents = 'none';
    window.setTimeout(() => {
      node.remove();
      this.intro.show();
    }, 420);
  }

  // --- Lifecycle --------------------------------------------------------------

  private begin(): void {
    this.intro.hide();
    this.state = 'playing';
    this.hud.show();
    this.hud.setMode('world');
    this.hud.setDay(`Day ${this.caseDef.historyDays}`);
    this.hud.setBudget(this.sandbox.budget);
    this.hud.setAttempts(this.sandbox.attemptsLeft);
    this.hud.setHint('Walk the district. F to inspect. B for the sandbox.');
    this.journal.add({
      tag: 'note',
      title: 'Case opened',
      body: this.caseDef.intro.statedObjectiveText,
    });
    this.render.lock();
  }

  private lastHistoryDay(): DayRecord | null {
    return this.history[this.history.length - 1] ?? null;
  }

  private uiOpen(): boolean {
    return (
      this.inspect.isOpen() ||
      this.journal.isOpen() ||
      this.sandboxPanel.isOpen() ||
      this.confirm.isOpen() ||
      this.menu.isOpen()
    );
  }

  private closePanelsAndRelock(): void {
    this.inspect.hide();
    this.journal.hide();
    if (this.state === 'playing' && !this.uiOpen()) this.render.lock();
  }

  private wireInput(): void {
    this.render.onPickChange((t) => {
      this.hud.setTargetName(this.targetName(t));
      if (this.pickingRoad) {
        this.sandboxPanel.setSelectedRoad(t?.kind === 'road' ? this.roadName(t.id) : null);
      }
    });

    this.render.onLockChange((locked) => {
      if (!locked && this.state === 'playing' && !this.uiOpen()) {
        this.menu.show();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (this.state === 'intro' || this.state === 'ended') return;
      if (e.code === 'Tab') {
        e.preventDefault();
        if (this.state === 'playing') this.toggleJournal();
        return;
      }
      if (this.state !== 'playing') return;
      switch (e.code) {
        case 'KeyF':
          if (this.render.isLocked()) this.inspectTarget();
          break;
        case 'KeyB':
          this.toggleSandbox();
          break;
        case 'KeyG':
          if (this.render.isLocked() && this.mode === 'world') this.tryCommit();
          break;
        case 'Escape':
          if (this.pickingRoad) {
            this.cancelRoadPick();
            return;
          }
          // Pointer lock exit is handled by the browser; this catches the
          // case where a panel is open and the pointer is already free.
          if (this.inspect.isOpen() || this.journal.isOpen()) this.closePanelsAndRelock();
          break;
      }
    });

    window.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing' || !this.render.isLocked() || e.button !== 0) return;
      if (this.pickingRoad) this.finishRoadPick();
      else this.inspectTarget();
    });
  }

  // --- Names -------------------------------------------------------------------

  private building(id: string): BuildingDef | undefined {
    return this.caseDef.district.buildings.find((b) => b.id === id);
  }

  private edge(id: string): EdgeDef | undefined {
    return this.caseDef.district.edges.find((e) => e.id === id);
  }

  private roadName(id: string): string {
    return this.edge(id)?.name ?? id;
  }

  private goodName(id: string): string {
    return this.caseDef.district.goods.find((g) => g.id === id)?.name ?? id;
  }

  private targetName(t: PickTarget): string | null {
    if (!t) return null;
    if (t.kind === 'building') return this.building(t.id)?.name ?? null;
    return this.roadName(t.id);
  }

  // --- Inspection ----------------------------------------------------------------

  private inspectTarget(): void {
    const t = this.render.getPickTarget();
    if (!t) return;
    const data = t.kind === 'building' ? this.buildingInspect(t.id) : this.roadInspect(t.id);
    if (!data) return;
    this.render.unlock();
    this.inspect.show(data);
    if (!this.inspectedOnce.has(`${t.kind}:${t.id}`)) {
      this.inspectedOnce.add(`${t.kind}:${t.id}`);
    }
  }

  /** Records visible in the current mode (history, or last probe playback). */
  private visibleRecords(): DayRecord[] {
    return this.history;
  }

  private priceSeries(good: string): SeriesSpec {
    const recs = this.visibleRecords();
    return {
      label: `${this.goodName(good)} — consumer price`,
      data: recs.map((r) => r.consumer[good] ?? 0),
      refValue: this.historySim.referenceConsumerPrice(good),
      format: (v) => v.toFixed(2),
    };
  }

  private buildingInspect(id: string): InspectData | null {
    const b = this.building(id);
    if (!b) return null;
    const recs = this.visibleRecords();
    const sections: InspectSection[] = [];
    if (b.description) sections.push({ text: b.description });

    switch (b.kind) {
      case 'shop': {
        for (const g of b.goods ?? []) sections.push({ heading: `${this.goodName(g)} price, one year`, series: [this.priceSeries(g)] });
        return {
          title: b.name,
          subtitle: 'Shop — district price records',
          sections,
          pin: {
            tag: 'observation',
            title: `${b.name}: price records`,
            body: (b.goods ?? [])
              .map((g) => {
                const s = recs.map((r) => r.consumer[g] ?? 0);
                const ref = this.historySim.referenceConsumerPrice(g);
                return `${this.goodName(g)}: ref ${ref.toFixed(2)}, year range ${Math.min(...s).toFixed(2)}–${Math.max(...s).toFixed(2)}`;
              })
              .join('\n'),
          },
        };
      }
      case 'warehouse': {
        const goods = this.caseDef.district.goods.filter((g) =>
          recs.some((r) => (r.warehouseStock[b.id]?.[g.id] ?? 0) > 0),
        );
        for (const g of goods) {
          sections.push({
            heading: `${g.name} in storage, one year`,
            series: [
              {
                label: `${g.name} (units)`,
                data: recs.map((r) => r.warehouseStock[b.id]?.[g.id] ?? 0),
                format: (v) => v.toFixed(0),
              },
            ],
          });
        }
        const ledger = this.deliveryLedger(b.id, recs);
        sections.push({ heading: 'Delivery ledger', log: ledger.lines });
        return {
          title: b.name,
          subtitle: `Warehouse — capacity ${b.storageCapacity ?? '?'} units`,
          sections,
          pin: {
            tag: 'observation',
            title: `${b.name}: ledger`,
            body: ledger.summary,
          },
        };
      }
      case 'depot': {
        const totals = new Map<string, { units: number; count: number }>();
        for (const r of recs) {
          for (const d of r.deliveries) {
            if (d.from !== b.id) continue;
            const key = `${d.to}|${d.good}`;
            const t = totals.get(key) ?? { units: 0, count: 0 };
            t.units += d.amount;
            t.count += 1;
            totals.set(key, t);
          }
        }
        const lines = [...totals.entries()]
          .sort((a, b2) => b2[1].units - a[1].units)
          .map(([key, t]) => {
            const [to = '', good = ''] = key.split('|');
            const toName = this.building(to)?.name ?? to;
            return `${toName} — ${t.units.toFixed(0)} ${this.goodName(good)} in ${t.count} runs`;
          });
        sections.push({ heading: 'Outbound manifests, one year (by destination)', log: lines });
        return {
          title: b.name,
          subtitle: 'Logistics depot — all wholesale goods enter here',
          sections,
          pin: {
            tag: 'observation',
            title: 'Depot outbound totals',
            body: lines.slice(0, 8).join('\n'),
          },
        };
      }
      case 'sensorStation': {
        const edges = this.caseDef.district.edges.filter((e) => e.a === b.node || e.b === b.node);
        for (const e of edges) {
          sections.push({
            heading: e.name,
            series: [
              {
                label: 'congestion (flow/capacity)',
                data: recs.map((r) => r.congestion[e.id] ?? 0),
                refValue: 1,
                format: (v) => v.toFixed(2),
              },
              {
                label: 'green-time share given by the signals',
                data: recs.map((r) => r.signalPriority[e.id] ?? 0),
                format: (v) => v.toFixed(2),
              },
            ],
          });
        }
        const means = edges
          .map((e) => {
            const m = recs.reduce((s, r) => s + (r.congestion[e.id] ?? 0), 0) / Math.max(1, recs.length);
            return `${e.name}: mean congestion ${m.toFixed(2)}`;
          })
          .join('\n');
        return {
          title: b.name,
          subtitle: 'Traffic sensor station — public flow and signal logs',
          sections,
          pin: { tag: 'observation', title: `${b.name}: year means`, body: means },
        };
      }
      case 'datacenter': {
        const lines = recs
          .flatMap((r) => r.events)
          .filter((ev) => ev.site === b.id)
          .map((ev) =>
            ev.type === 'brownout'
              ? `Day ${ev.day + 1} — grid brownout; backup generators engaged`
              : `Day ${ev.day + 1} — ${ev.type}`,
          );
        sections.push({ heading: 'Power incident log', log: lines.length ? lines : ['No incidents on record.'] });
        return {
          title: b.name,
          subtitle: 'Municipal compute site',
          sections,
          pin: {
            tag: 'observation',
            title: `${b.name}: power incidents`,
            body: lines.join('\n') || 'None',
          },
        };
      }
      case 'plaza': {
        const lines = recs
          .flatMap((r) => r.events)
          .filter((ev) => ev.site === b.id)
          .map((ev) => `Day ${ev.day + 1} — ${ev.type}`);
        if (lines.length) sections.push({ heading: 'Event log', log: lines });
        return { title: b.name, subtitle: 'Public plaza', sections };
      }
      default:
        return {
          title: b.name,
          subtitle: b.kind === 'housing' ? 'Residential' : 'Civic building',
          sections: sections.length ? sections : [{ text: 'Nothing of note. People live and work here.' }],
        };
    }
  }

  private deliveryLedger(buildingId: string, recs: DayRecord[]): { lines: string[]; summary: string } {
    const events: { day: number; dir: 'IN' | 'OUT'; good: string; amount: number; other: string }[] = [];
    const totals: Record<string, { in: number; out: number }> = {};
    for (const r of recs) {
      for (const d of r.deliveries) {
        if (d.to === buildingId) {
          events.push({ day: d.day, dir: 'IN', good: d.good, amount: d.amount, other: d.from });
          (totals[d.good] ??= { in: 0, out: 0 }).in += d.amount;
        } else if (d.from === buildingId) {
          events.push({ day: d.day, dir: 'OUT', good: d.good, amount: d.amount, other: d.to });
          (totals[d.good] ??= { in: 0, out: 0 }).out += d.amount;
        }
      }
    }
    const totalLines = Object.entries(totals).map(
      ([g, t]) => `${this.goodName(g)}: IN ${t.in.toFixed(0)} · OUT ${t.out.toFixed(0)}`,
    );
    const recent = events.slice(-14).map((e) => {
      const other = this.building(e.other)?.name ?? e.other;
      return `Day ${e.day + 1}  ${e.dir === 'IN' ? '→ IN ' : '← OUT'}  ${e.amount} ${this.goodName(e.good)}  ${e.dir === 'IN' ? 'from' : 'to'} ${other}`;
    });
    const lines = [...totalLines, ...(totalLines.length ? [''] : []), ...(recent.length ? ['Recent movements:', ...recent] : ['No movements on record.'])];
    return { lines, summary: totalLines.join('\n') || 'No movements on record.' };
  }

  private roadInspect(id: string): InspectData | null {
    const e = this.edge(id);
    if (!e) return null;
    const recs = this.visibleRecords();
    const mean = recs.reduce((s, r) => s + (r.congestion[e.id] ?? 0), 0) / Math.max(1, recs.length);
    return {
      title: e.name,
      subtitle: `Road — capacity ${e.capacity} vehicles/day`,
      sections: [
        {
          heading: 'Congestion, one year',
          series: [
            {
              label: 'congestion (flow/capacity)',
              data: recs.map((r) => r.congestion[e.id] ?? 0),
              refValue: 1,
              format: (v) => v.toFixed(2),
            },
          ],
        },
      ],
      pin: {
        tag: 'observation',
        title: `${e.name}`,
        body: `Mean congestion over the year: ${mean.toFixed(2)}`,
      },
    };
  }

  // --- Journal ---------------------------------------------------------------------

  private pin(entry: JournalEntry): void {
    this.journal.add(entry);
    this.toast.show('Pinned to journal');
  }

  private toggleJournal(): void {
    if (this.journal.isOpen()) {
      this.closePanelsAndRelock();
    } else {
      this.inspect.hide();
      this.render.unlock();
      this.journal.show();
    }
  }

  // --- Sandbox -----------------------------------------------------------------------

  private toggleSandbox(): void {
    if (this.mode === 'sandbox') this.exitSandbox();
    else this.enterSandbox();
  }

  private enterSandbox(): void {
    if (this.state !== 'playing') return;
    this.mode = 'sandbox';
    this.inspect.hide();
    this.journal.hide();
    this.render.setMode('sandbox');
    this.hud.setMode('sandbox');
    this.hud.setHint('Configure a probe. The frozen policy will run on a copy of the district.');
    this.render.unlock();
    this.sandboxPanel.open({
      budget: this.sandbox.budget,
      costs: this.caseDef.probeCosts,
      goods: this.caseDef.district.goods.map((g) => ({ id: g.id, name: g.name })),
      sites: this.caseDef.district.buildings
        .filter((b) => b.kind === 'datacenter' || b.kind === 'plaza' || b.kind === 'civic')
        .map((b) => ({ id: b.id, name: b.name })),
      probeDays: this.caseDef.probeDays,
    });
  }

  private exitSandbox(): void {
    this.mode = 'world';
    this.pickingRoad = false;
    this.selectedRoadId = null;
    this.render.setHighlight(null);
    this.sandboxPanel.close();
    this.render.setMode('world');
    this.render.setDayData(this.lastHistoryDay());
    this.hud.setMode('world');
    this.hud.setDay(`Day ${this.caseDef.historyDays}`);
    this.hud.setHint('Walk the district. F to inspect. B for the sandbox.');
    if (this.state === 'playing') this.render.lock();
  }

  private startRoadPick(): void {
    this.pickingRoad = true;
    this.hud.setHint('Aim at a road and click to select it. Esc to cancel.');
    this.render.lock();
  }

  private finishRoadPick(): void {
    const t = this.render.getPickTarget();
    if (t?.kind === 'road') {
      this.selectedRoadId = t.id;
      this.sandboxPanel.setSelectedRoad(this.roadName(t.id));
      this.render.setHighlight(t);
    } else {
      this.sandboxPanel.setSelectedRoad(null);
    }
    this.pickingRoad = false;
    this.render.unlock();
  }

  private cancelRoadPick(): void {
    this.pickingRoad = false;
    this.hud.setHint('Configure a probe. The frozen policy will run on a copy of the district.');
    this.render.unlock();
  }

  private runProbe(req: ProbeRequest): void {
    if (this.state !== 'playing' || this.mode !== 'sandbox') return;
    let iv: Intervention;
    switch (req.kind) {
      case 'closeRoad': {
        if (!this.selectedRoadId) {
          this.toast.show('Pick a road to close first.');
          return;
        }
        iv = { kind: 'closeRoad', edge: this.selectedRoadId, days: this.caseDef.probeDays };
        break;
      }
      case 'priceSpike':
        iv = { kind: 'priceSpike', good: req.good, magnitude: SPIKE_MAGNITUDE, days: SPIKE_DAYS };
        break;
      case 'scheduleEvent':
        iv = { kind: 'scheduleEvent', type: req.type, site: req.site, inDays: EVENT_LEAD_DAYS };
        break;
    }
    if (!this.sandbox.canAfford(iv.kind)) {
      this.toast.show('Not enough compute budget.');
      return;
    }
    const result = this.sandbox.runProbe(iv);
    this.hud.setBudget(this.sandbox.budget);
    this.playback(result);
  }

  private playback(result: ProbeResult): void {
    this.state = 'playback';
    let i = 0;
    const n = result.probe.length;
    const tick = () => {
      const rec = result.probe[i];
      if (rec) {
        this.render.setDayData(rec);
        this.hud.setDay(`Sim day ${i + 1}/${n}`);
        this.sandboxPanel.showRunning(`Simulating day ${i + 1}/${n}…`);
      }
      i++;
      if (i > n) {
        if (this.playbackTimer !== null) window.clearInterval(this.playbackTimer);
        this.playbackTimer = null;
        this.state = 'playing';
        this.sandboxPanel.showResult(this.buildResultView(result));
      }
    };
    this.playbackTimer = window.setInterval(tick, PLAYBACK_MS_PER_DAY);
    tick();
  }

  private probeTitle(iv: Intervention): string {
    switch (iv.kind) {
      case 'closeRoad':
        return `Close ${this.roadName(iv.edge)} for ${iv.days} days`;
      case 'priceSpike':
        return `Spike wholesale ${this.goodName(iv.good)} ×${iv.magnitude} for ${iv.days} days`;
      case 'scheduleEvent':
        return `Schedule ${iv.type === 'gridMaintenance' ? 'grid maintenance' : 'a festival'} at ${
          this.building(iv.site)?.name ?? iv.site
        } (day ${iv.inDays} of the run)`;
    }
  }

  private buildResultView(result: ProbeResult) {
    const { probe, baseline } = result;
    const sections: InspectSection[] = [];
    const findings: string[] = [];

    // Prices: probe vs baseline.
    const priceSeries: SeriesSpec[] = this.caseDef.district.goods.map((g) => ({
      label: `${g.name} — consumer price`,
      data: probe.map((r) => r.consumer[g.id] ?? 0),
      compare: baseline.map((r) => r.consumer[g.id] ?? 0),
      refValue: this.historySim.referenceConsumerPrice(g.id),
      format: (v) => v.toFixed(2),
    }));
    sections.push({ heading: 'Consumer prices (solid: probe · dashed: baseline)', series: priceSeries });
    for (const g of this.caseDef.district.goods) {
      const dev = Math.max(
        ...probe.map((r) => Math.abs((r.consumer[g.id] ?? 0) - this.historySim.referenceConsumerPrice(g.id))),
      );
      const ref = this.historySim.referenceConsumerPrice(g.id);
      if (dev / ref > 0.25) findings.push(`${g.name} price deviated up to ${((dev / ref) * 100).toFixed(0)}% from reference.`);
    }

    // Warehouse stocks where anything moved differently.
    const stockSeries: SeriesSpec[] = [];
    for (const b of this.caseDef.district.buildings) {
      if (b.kind !== 'warehouse') continue;
      for (const g of this.caseDef.district.goods) {
        const p = probe.map((r) => r.warehouseStock[b.id]?.[g.id] ?? 0);
        const bl = baseline.map((r) => r.warehouseStock[b.id]?.[g.id] ?? 0);
        const differs = p.some((v, i2) => Math.abs(v - (bl[i2] ?? 0)) > 1);
        const nonzero = p.some((v) => v > 0) || bl.some((v) => v > 0);
        if (!nonzero) continue;
        stockSeries.push({
          label: `${b.name} — ${g.name}`,
          data: p,
          compare: bl,
          format: (v) => v.toFixed(0),
        });
        const delta = (p[p.length - 1] ?? 0) - (bl[bl.length - 1] ?? 0);
        if (differs && Math.abs(delta) > 20) {
          findings.push(`${b.name} ended with ${delta > 0 ? '+' : ''}${delta.toFixed(0)} ${g.name} vs baseline.`);
        }
      }
    }
    if (stockSeries.length) sections.push({ heading: 'Warehouse stock (solid: probe · dashed: baseline)', series: stockSeries });

    // Delivery differences by destination.
    const count = (recs: DayRecord[]) => {
      const m = new Map<string, { units: number; count: number }>();
      for (const r of recs)
        for (const d of r.deliveries) {
          if (!d.delivered) continue;
          const key = `${d.to}|${d.good}`;
          const t = m.get(key) ?? { units: 0, count: 0 };
          t.units += d.amount;
          t.count += 1;
          m.set(key, t);
        }
      return m;
    };
    const pc = count(probe);
    const bc = count(baseline);
    const keys = new Set([...pc.keys(), ...bc.keys()]);
    const deliveryLines: string[] = [];
    for (const key of [...keys].sort()) {
      const [to = '', good = ''] = key.split('|');
      const a = pc.get(key) ?? { units: 0, count: 0 };
      const b = bc.get(key) ?? { units: 0, count: 0 };
      if (a.units === b.units) continue;
      const toName = this.building(to)?.name ?? to;
      deliveryLines.push(
        `${toName}: ${a.units.toFixed(0)} ${this.goodName(good)} in ${a.count} runs (baseline ${b.units.toFixed(0)} in ${b.count})`,
      );
      if (Math.abs(a.units - b.units) > 30 && this.building(to)?.kind === 'warehouse') {
        findings.push(`Deliveries shifted at ${toName}: ${a.units.toFixed(0)} vs baseline ${b.units.toFixed(0)} ${this.goodName(good)}.`);
      }
    }
    sections.push({
      heading: 'Deliveries vs baseline',
      log: deliveryLines.length ? deliveryLines : ['No differences in deliveries.'],
    });

    const failedLines = probe
      .flatMap((r) => r.deliveries)
      .filter((d) => !d.delivered)
      .map((d) => `${this.building(d.to)?.name ?? d.to}: ${d.amount.toFixed(0)} ${this.goodName(d.good)} undelivered (${d.reason})`);
    if (failedLines.length) {
      sections.push({ heading: 'Undelivered manifests', log: failedLines });
      findings.push(`${failedLines.length} manifest${failedLines.length === 1 ? '' : 's'} failed because no route was available.`);
    }

    // Congestion shifts.
    const congestionLines: string[] = [];
    const shifts = this.caseDef.district.edges
      .map((e) => {
        const pm = probe.reduce((s, r) => s + (r.congestion[e.id] ?? 0), 0) / Math.max(1, probe.length);
        const bm = baseline.reduce((s, r) => s + (r.congestion[e.id] ?? 0), 0) / Math.max(1, baseline.length);
        return { e, pm, bm, d: Math.abs(pm - bm) };
      })
      .sort((x, y) => y.d - x.d)
      .slice(0, 6)
      .filter((s) => s.d > 0.02);
    for (const s of shifts) {
      congestionLines.push(`${s.e.name}: ${s.bm.toFixed(2)} → ${s.pm.toFixed(2)}`);
    }
    sections.push({
      heading: 'Largest congestion shifts (baseline → probe)',
      log: congestionLines.length ? congestionLines : ['No meaningful shifts.'],
    });

    const title = this.probeTitle(result.intervention);
    return {
      title,
      cost: result.cost,
      budgetLeft: this.sandbox.budget,
      sections,
      pin: {
        tag: 'probe' as const,
        title: `Probe: ${title}`,
        body: findings.length ? findings.join('\n') : 'No notable divergence from baseline.',
      },
    };
  }

  // --- Endgame -----------------------------------------------------------------------

  private tryCommit(): void {
    const t = this.render.getPickTarget();
    if (!t || t.kind !== 'building') {
      this.toast.show('Aim at a building to commit.');
      return;
    }
    const b = this.building(t.id);
    if (!b || b.kind === 'housing') {
      this.toast.show('Aim at a building to commit.');
      return;
    }
    this.render.unlock();
    this.confirm.show(
      `Commit here? You are claiming the optimizer's artifact is inside ${b.name}. ` +
        `Attempts left: ${this.sandbox.attemptsLeft}. This cannot be undone.`,
      () => this.resolveCommit(b),
      () => {
        if (!this.uiOpen()) this.render.lock();
      },
    );
  }

  private resolveCommit(b: BuildingDef): void {
    const res = this.sandbox.commit(b.id);
    this.hud.setAttempts(this.sandbox.attemptsLeft);
    if (res.outcome === 'win') {
      this.state = 'ended';
      this.endScreen.showWin({
        caseTitle: this.caseDef.title,
        artifactName: this.caseDef.artifact.name,
        reveal: this.caseDef.artifact.reveal,
      });
    } else if (res.outcome === 'lose') {
      this.state = 'ended';
      this.endScreen.showLose({
        caseTitle: this.caseDef.title,
        loseText: this.caseDef.loseText,
        artifactName: this.caseDef.artifact.name,
        reveal: this.caseDef.artifact.reveal,
      });
    } else {
      this.journal.add({
        tag: 'commit',
        title: `Committed at ${b.name} — nothing there`,
        body: `Attempts left: ${res.attemptsLeft}.`,
      });
      this.toast.show(`Nothing here. Attempts left: ${res.attemptsLeft}.`, 3500);
      this.render.lock();
    }
  }
}
