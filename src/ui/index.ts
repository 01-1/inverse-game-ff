import type {
  ConfirmDialog,
  EndScreen,
  EndScreenOptions,
  Hud,
  HudOptions,
  InspectData,
  InspectPanel,
  InspectPanelOptions,
  IntroOptions,
  IntroScreen,
  Journal,
  JournalEntry,
  JournalOptions,
  PauseMenu,
  PauseMenuOptions,
  SandboxPanel,
  SandboxPanelOptions,
  SandboxPanelState,
  SandboxResultView,
  SeriesSpec,
  Toast,
} from './types';
import { wrappedDialogFocusIndex } from './focus';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

let nextUiId = 0;

function uiId(prefix: string): string {
  nextUiId += 1;
  return `${prefix}-${nextUiId}`;
}

interface DialogState {
  previousFocus: HTMLElement | null;
  inertedSiblings: HTMLElement[];
}

const dialogStates = new WeakMap<HTMLElement, DialogState>();

function focusableElements(node: HTMLElement): HTMLElement[] {
  const selector = 'button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  return [...node.querySelectorAll<HTMLElement>(selector)].filter((candidate) => !candidate.hidden);
}

function labelDialog(node: HTMLElement): void {
  const heading = node.querySelector<HTMLElement>('h1, h2, h3');
  if (!heading) return;
  if (!heading.id) heading.id = uiId('dialog-title');
  node.setAttribute('aria-labelledby', heading.id);
  node.removeAttribute('aria-label');
}

function showDialog(node: HTMLElement, initialFocus?: HTMLElement): void {
  if (!node.hidden) return;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inertedSiblings: HTMLElement[] = [];
  const parent = node.parentElement;
  if (parent) {
    for (const sibling of parent.children) {
      if (
        !(sibling instanceof HTMLElement) ||
        sibling === node ||
        sibling.inert ||
        sibling.getAttribute('role') === 'status'
      ) {
        continue;
      }
      sibling.inert = true;
      inertedSiblings.push(sibling);
    }
  }
  dialogStates.set(node, { previousFocus, inertedSiblings });
  node.hidden = false;
  labelDialog(node);
  (initialFocus ?? focusableElements(node)[0] ?? node).focus();
}

function hideDialog(node: HTMLElement): void {
  if (node.hidden) return;
  node.hidden = true;
  const state = dialogStates.get(node);
  dialogStates.delete(node);
  for (const sibling of state?.inertedSiblings ?? []) sibling.inert = false;
  if (state?.previousFocus?.isConnected) state.previousFocus.focus();
}

function overlay(className: string, accessibleName: string): HTMLDivElement {
  const node = el('div', `overlay ${className}`);
  node.hidden = true;
  node.tabIndex = -1;
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  node.setAttribute('aria-label', accessibleName);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(node);
    if (focusable.length === 0) {
      event.preventDefault();
      node.focus();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = wrappedDialogFocusIndex(currentIndex, focusable.length, event.shiftKey);
    if (targetIndex !== null) {
      event.preventDefault();
      focusable[targetIndex]?.focus();
    }
  });
  return node;
}

function formatLast(s: SeriesSpec): string {
  const last = s.data[s.data.length - 1] ?? 0;
  return s.format ? s.format(last) : last.toFixed(1);
}

function formatValue(s: SeriesSpec, value: number): string {
  return s.format ? s.format(value) : value.toFixed(1);
}

function seriesSummary(s: SeriesSpec): string {
  const first = s.data[0] ?? 0;
  const last = s.data[s.data.length - 1] ?? 0;
  const min = Math.min(...s.data);
  const max = Math.max(...s.data);
  const direction = last > first ? 'increased' : last < first ? 'decreased' : 'was unchanged';
  const details = [
    `${s.label} ${direction} from ${formatValue(s, first)} to ${formatValue(s, last)}`,
    `range ${formatValue(s, min)} to ${formatValue(s, max)}`,
  ];
  const compareLast = s.compare?.[s.compare.length - 1];
  if (compareLast !== undefined) details.push(`baseline ended at ${formatValue(s, compareLast)}`);
  if (s.refValue !== undefined) details.push(`reference ${formatValue(s, s.refValue)}`);
  return details.join(', ');
}

const SERIES_COLORS = ['#f7c85b', '#7bd8d0', '#ef7d70', '#b6d77a', '#d8c7ff'];

function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

function drawSeries(canvas: HTMLCanvasElement, specs: SeriesSpec[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const all = specs.flatMap((s) => [...s.data, ...(s.compare ?? []), ...(s.refValue === undefined ? [] : [s.refValue])]);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = Math.max(0.001, max - min);
  const y = (v: number) => h - 12 - ((v - min) / span) * (h - 24);
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const yy = 10 + (i * (h - 20)) / 3;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w, yy);
    ctx.stroke();
  }
  specs.forEach((s, idx) => {
    const draw = (data: number[], dashed: boolean): void => {
      if (data.length < 2) return;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.strokeStyle = dashed ? 'rgba(255,255,255,.45)' : seriesColor(idx);
      ctx.lineWidth = dashed ? 1.3 : 2;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        if (i === 0) ctx.moveTo(x, y(v));
        else ctx.lineTo(x, y(v));
      });
      ctx.stroke();
    };
    if (s.refValue !== undefined) {
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,.34)';
      ctx.beginPath();
      ctx.moveTo(0, y(s.refValue));
      ctx.lineTo(w, y(s.refValue));
      ctx.stroke();
    }
    draw(s.compare ?? [], true);
    draw(s.data, false);
  });
  ctx.setLineDash([]);
}

function renderInspect(container: HTMLElement, data: InspectData, onPin?: (e: JournalEntry) => void): void {
  container.replaceChildren();
  container.append(el('h2', undefined, data.title));
  if (data.subtitle) container.append(el('p', 'subtle', data.subtitle));
  for (const section of data.sections) {
    const block = el('section', 'panel-section');
    if (section.heading) block.append(el('h3', undefined, section.heading));
    if (section.text) block.append(el('p', undefined, section.text));
    if (section.series) {
      const legend = el('div', 'legend');
      section.series.forEach((s, idx) => {
        const row = el('div', 'legend-row');
        row.style.borderLeftColor = seriesColor(idx);
        const swatch = el('span', 'legend-swatch');
        swatch.style.background = seriesColor(idx);
        row.append(swatch, el('span', 'legend-label', `${s.label}: ${formatLast(s)}`));
        legend.append(row);
      });
      const c = el('canvas', 'spark');
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', section.series.map(seriesSummary).join('. '));
      block.append(legend, c);
      requestAnimationFrame(() => drawSeries(c, section.series ?? []));
    }
    if (section.log) {
      const pre = el('pre', 'log');
      pre.textContent = section.log.join('\n');
      block.append(pre);
    }
    container.append(block);
  }
  if (data.pin && onPin) container.append(button('Pin to journal', () => onPin(data.pin!), 'btn primary'));
}

export function createIntro(root: HTMLElement, opts: IntroOptions): IntroScreen {
  const node = overlay('intro', opts.title);
  const box = el('div', 'intro-box');
  box.append(el('h1', undefined, opts.title), el('p', 'premise', opts.premise), el('p', 'objective', opts.statedObjective));
  const list = el('ul');
  for (const item of opts.briefing) list.append(el('li', undefined, item));
  const enter = button('Enter Foundry Flats', opts.onStart, 'btn primary');
  const touchOnly =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(any-hover: none) and (any-pointer: coarse)').matches;
  if (touchOnly) {
    const warning = el(
      'p',
      'input-warning',
      'Desktop keyboard and mouse controls are required. Touch-only controls are not available.',
    );
    warning.id = uiId('input-warning');
    warning.setAttribute('role', 'alert');
    enter.setAttribute('aria-describedby', warning.id);
    box.append(list, warning, enter);
  } else {
    box.append(list, enter);
  }
  node.append(box);
  root.append(node);
  return { show: () => showDialog(node, enter), hide: () => hideDialog(node) };
}

export function createHud(root: HTMLElement, opts: HudOptions): Hud {
  const node = el('div', 'hud');
  node.hidden = true;
  const location = el('span', 'pill');
  const budget = el('span', 'pill');
  const attempts = el('span', 'pill');
  const target = el('div', 'target');
  const hint = el('div', 'hint');
  const status = el('div', 'hud-row status-row');
  target.hidden = true;
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  budget.setAttribute('aria-live', 'polite');
  attempts.setAttribute('aria-live', 'polite');
  location.textContent = opts.locationName;
  node.append(status, hint, target);
  node.firstElementChild?.append(location, budget, attempts);
  root.append(node);
  return {
    show: () => (node.hidden = false),
    hide: () => (node.hidden = true),
    setMode: () => undefined,
    setDay: () => undefined,
    setBudget: (n) => (budget.textContent = `Compute: ${n}`),
    setAttempts: (n) => (attempts.textContent = `Attempts: ${n}`),
    setTargetName: (name) => {
      target.textContent = name ? `Inspect: ${name}` : '';
      target.hidden = !name;
    },
    setHint: (t) => (hint.textContent = t),
  };
}

export function createInspectPanel(root: HTMLElement, opts: InspectPanelOptions): InspectPanel {
  const node = overlay('side-panel', 'Inspection');
  const panel = el('div', 'panel-shell');
  const body = el('div', 'scroll-body');
  const close = button('Close', opts.onClose);
  node.addEventListener('mousedown', (e) => {
    if (e.target === node) opts.onClose();
  });
  panel.append(body, close);
  node.append(panel);
  root.append(node);
  return {
    show: (data: InspectData) => {
      renderInspect(body, data, opts.onPin);
      showDialog(node, close);
    },
    hide: () => hideDialog(node),
    isOpen: () => !node.hidden,
  };
}

export function createJournal(root: HTMLElement, opts: JournalOptions): Journal {
  const entries: JournalEntry[] = [];
  const node = overlay('side-panel journal', 'Journal');
  const panel = el('div', 'panel-shell');
  const body = el('div', 'scroll-body');
  const close = button('Close', opts.onClose);
  const repaint = (): void => {
    body.replaceChildren(el('h2', undefined, 'Journal'));
    if (entries.length === 0) body.append(el('p', 'subtle', 'No pinned observations yet.'));
    for (const entry of entries) {
      const card = el('article', `journal-entry ${entry.tag}`);
      card.append(el('small', undefined, entry.tag.toUpperCase()), el('h3', undefined, entry.title));
      const pre = el('pre', 'entry-body');
      pre.textContent = entry.body;
      card.append(pre);
      body.append(card);
    }
  };
  node.addEventListener('mousedown', (e) => {
    if (e.target === node) opts.onClose();
  });
  panel.append(body, close);
  node.append(panel);
  root.append(node);
  return {
    add: (entry) => {
      entries.unshift(entry);
      repaint();
    },
    show: () => {
      repaint();
      showDialog(node, close);
    },
    hide: () => hideDialog(node),
    isOpen: () => !node.hidden,
  };
}

export function createSandboxPanel(root: HTMLElement, opts: SandboxPanelOptions): SandboxPanel {
  const node = overlay('sandbox-panel', 'Sandbox Probe');
  const panel = el('div', 'panel-shell');
  const body = el('div', 'scroll-body');
  let selectedRoad: string | null = null;
  let lastState: SandboxPanelState | null = null;
  const runButtons = (): void => {
    if (!lastState) return;
    const restoreFocus = body.contains(document.activeElement);
    body.replaceChildren(el('h2', undefined, 'Sandbox Probe'), el('p', 'subtle', `${lastState.probeDays} days per run. Budget: ${lastState.budget}.`));
    const roadLabel = el('p', 'objective', selectedRoad ? `Road selected: ${selectedRoad}` : 'No road selected.');
    body.append(roadLabel, button(`Pick road / close (${lastState.costs.closeRoad})`, opts.onRequestRoadPick, 'btn'));
    const goods = el('select');
    goods.id = uiId('sandbox-good');
    for (const g of lastState.goods) goods.append(new Option(g.name, g.id));
    const goodsLabel = el('label', undefined, 'Good');
    goodsLabel.htmlFor = goods.id;
    body.append(goodsLabel, goods, button(`Run price spike (${lastState.costs.priceSpike})`, () => opts.onRun({ kind: 'priceSpike', good: goods.value }), 'btn'));
    const sites = el('select');
    sites.id = uiId('sandbox-event-site');
    for (const s of lastState.sites) sites.append(new Option(s.name, s.id));
    const eventType = el('select');
    eventType.id = uiId('sandbox-event-type');
    eventType.append(new Option('Grid maintenance', 'gridMaintenance'), new Option('Festival', 'festival'));
    const siteLabel = el('label', undefined, 'Event site');
    siteLabel.htmlFor = sites.id;
    const eventTypeLabel = el('label', undefined, 'Event type');
    eventTypeLabel.htmlFor = eventType.id;
    body.append(siteLabel, sites, eventTypeLabel, eventType, button(`Run scheduled event (${lastState.costs.scheduleEvent})`, () => opts.onRun({ kind: 'scheduleEvent', type: eventType.value as 'gridMaintenance' | 'festival', site: sites.value }), 'btn'));
    const runRoad = button('Run selected road closure', () => opts.onRun({ kind: 'closeRoad' }), 'btn primary');
    runRoad.disabled = selectedRoad === null;
    body.append(runRoad, button('Exit sandbox', opts.onExit, 'btn'));
    if (!node.hidden) {
      labelDialog(node);
      if (restoreFocus) focusableElements(node)[0]?.focus();
    }
  };
  node.addEventListener('mousedown', (e) => {
    if (e.target === node) opts.onExit();
  });
  panel.append(body);
  node.append(panel);
  root.append(node);
  return {
    open: (state) => {
      lastState = state;
      selectedRoad = null;
      runButtons();
      showDialog(node);
    },
    close: () => {
      selectedRoad = null;
      hideDialog(node);
    },
    isOpen: () => !node.hidden,
    suspendForRoadPick: () => hideDialog(node),
    resumeAfterRoadPick: () => {
      runButtons();
      showDialog(node);
    },
    setSelectedRoad: (name) => {
      selectedRoad = name;
      if (!node.hidden) runButtons();
    },
    showRunning: (text) => {
      body.replaceChildren(el('h2', undefined, 'Running Probe'), el('p', 'premise', text));
      labelDialog(node);
      node.focus();
    },
    showResult: (result: SandboxResultView) => {
      body.replaceChildren();
      body.append(el('h2', undefined, result.title), el('p', 'subtle', `Cost ${result.cost}. Budget left ${result.budgetLeft}.`));
      renderInspect(body, { title: '', sections: result.sections }, undefined);
      body.append(button('Pin prediction result', () => opts.onPin(result.pin), 'btn primary'), button('New probe', runButtons, 'btn'), button('Exit sandbox', opts.onExit, 'btn'));
      labelDialog(node);
      focusableElements(node)[0]?.focus();
    },
  };
}

export function createEndgame(root: HTMLElement, opts: EndScreenOptions): EndScreen {
  const node = overlay('end', 'Case result');
  const body = el('div', 'intro-box');
  node.append(body);
  root.append(node);
  const showWin = (title: string, text: string, artifact: string, reveal: string): void => {
    body.replaceChildren(el('h1', undefined, title), el('p', 'premise', text), el('h2', undefined, artifact), el('p', undefined, reveal), button('Restart case', opts.onRestart, 'btn primary'));
    showDialog(node);
  };
  const showLose = (text: string, artifact: string, reveal: string): void => {
    const revealButton = button('Reveal solution (spoiler)', () => {
      body.replaceChildren(
        el('h1', undefined, 'Case closed unresolved'),
        el('p', 'premise', text),
        el('h2', undefined, artifact),
        el('p', undefined, reveal),
        button('Restart case', opts.onRestart, 'btn primary'),
      );
      labelDialog(node);
      focusableElements(node)[0]?.focus();
    }, 'btn');
    body.replaceChildren(
      el('h1', undefined, 'Case closed unresolved'),
      el('p', 'premise', text),
      revealButton,
      button('Restart case', opts.onRestart, 'btn primary'),
    );
    showDialog(node);
  };
  return {
    showWin: (o) => showWin('Artifact found', o.caseTitle, o.artifactName, o.reveal),
    showLose: (o) => showLose(`${o.caseTitle}. ${o.loseText}`, o.artifactName, o.reveal),
  };
}

export function createConfirm(root: HTMLElement): ConfirmDialog {
  const node = overlay('confirm', 'Confirmation');
  const box = el('div', 'modal');
  let activeEscapeHandler: ((event: KeyboardEvent) => void) | null = null;
  node.append(box);
  root.append(node);
  return {
    show: (text, onYes, onNo, opts) => {
      if (activeEscapeHandler) node.removeEventListener('keydown', activeEscapeHandler);
      const stopListening = (): void => {
        if (!activeEscapeHandler) return;
        node.removeEventListener('keydown', activeEscapeHandler);
        activeEscapeHandler = null;
      };
      const cancel = (): void => {
        stopListening();
        hideDialog(node);
        onNo();
      };
      box.replaceChildren(
        el('h2', undefined, 'Confirm action'),
        el('p', undefined, text),
        button(opts?.confirmText ?? 'Commit', () => { stopListening(); hideDialog(node); onYes(); }, opts?.confirmClass ?? 'btn primary'),
        button('Cancel', cancel, 'btn'),
      );
      activeEscapeHandler = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        cancel();
      };
      node.addEventListener('keydown', activeEscapeHandler);
      showDialog(node);
    },
    isOpen: () => !node.hidden,
  };
}

export function createToast(root: HTMLElement): Toast {
  const node = el('div', 'toast');
  node.hidden = true;
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  root.append(node);
  let timer = 0;
  return {
    show: (text, ms = 2200) => {
      node.textContent = text;
      node.hidden = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => (node.hidden = true), ms);
    },
  };
}

export function createPauseMenu(root: HTMLElement, opts: PauseMenuOptions): PauseMenu {
  const node = overlay('confirm', 'Paused');
  const box = el('div', 'modal');
  const repo = el('a', 'btn repo-menu-link', 'GitHub');
  repo.href = 'https://github.com/01-1/inverse-game-ff/';
  repo.target = '_blank';
  repo.rel = 'noreferrer';
  box.append(el('h2', undefined, 'Paused'), ...opts.controlsHelp.map((c) => el('p', 'subtle', c)), button('Resume', opts.onResume, 'btn primary'), button('Restart', opts.onRestart, 'btn danger'), repo);
  node.append(box);
  root.append(node);
  return { show: () => showDialog(node), hide: () => hideDialog(node), isOpen: () => !node.hidden };
}
