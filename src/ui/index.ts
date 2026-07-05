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

function overlay(className: string): HTMLDivElement {
  const node = el('div', `overlay ${className}`);
  node.hidden = true;
  return node;
}

function formatLast(s: SeriesSpec): string {
  const last = s.data[s.data.length - 1] ?? 0;
  return s.format ? s.format(last) : last.toFixed(1);
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
  const colors = ['#f7c85b', '#7bd8d0', '#ef7d70', '#b6d77a', '#d8c7ff'];
  specs.forEach((s, idx) => {
    const draw = (data: number[], dashed: boolean): void => {
      if (data.length < 2) return;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.strokeStyle = dashed ? 'rgba(255,255,255,.45)' : colors[idx % colors.length]!;
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
      for (const s of section.series) legend.append(el('span', undefined, `${s.label}: ${formatLast(s)}`));
      const c = el('canvas', 'spark');
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
  const node = overlay('intro');
  const box = el('div', 'intro-box');
  box.append(el('h1', undefined, opts.title), el('p', 'premise', opts.premise), el('p', 'objective', opts.statedObjective));
  const list = el('ul');
  for (const item of opts.briefing) list.append(el('li', undefined, item));
  box.append(list, button('Enter Basin East', opts.onStart, 'btn primary'));
  node.append(box);
  root.append(node);
  return { show: () => (node.hidden = false), hide: () => (node.hidden = true) };
}

export function createHud(root: HTMLElement, opts: HudOptions): Hud {
  const node = el('div', 'hud');
  node.hidden = true;
  const mode = el('span', 'pill');
  const day = el('span', 'pill');
  const budget = el('span', 'pill');
  const attempts = el('span', 'pill');
  const target = el('div', 'target');
  const hint = el('div', 'hint');
  const controls = el('div', 'hud-row');
  controls.append(button('Journal', opts.onJournal, 'btn small'), button('Sandbox', opts.onSandbox, 'btn small'));
  node.append(el('div', 'hud-row'), target, hint, controls);
  node.firstElementChild?.append(mode, day, budget, attempts);
  root.append(node);
  return {
    show: () => (node.hidden = false),
    hide: () => (node.hidden = true),
    setMode: (m) => (mode.textContent = m === 'sandbox' ? 'SANDBOX' : 'WORLD'),
    setDay: (t) => (day.textContent = t),
    setBudget: (n) => (budget.textContent = `Compute ${n}`),
    setAttempts: (n) => (attempts.textContent = `Attempts ${n}`),
    setTargetName: (name) => {
      target.textContent = name ? `Inspect: ${name}` : '';
      target.hidden = !name;
    },
    setHint: (t) => (hint.textContent = t),
  };
}

export function createInspectPanel(root: HTMLElement, opts: InspectPanelOptions): InspectPanel {
  const node = overlay('side-panel');
  const close = button('Close', opts.onClose, 'btn small');
  const body = el('div', 'scroll-body');
  node.append(close, body);
  root.append(node);
  return {
    show: (data: InspectData) => {
      renderInspect(body, data, opts.onPin);
      node.hidden = false;
    },
    hide: () => (node.hidden = true),
    isOpen: () => !node.hidden,
  };
}

export function createJournal(root: HTMLElement, opts: JournalOptions): Journal {
  const entries: JournalEntry[] = [];
  const node = overlay('side-panel journal');
  const body = el('div', 'scroll-body');
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
  node.append(button('Close', opts.onClose, 'btn small'), body);
  root.append(node);
  return {
    add: (entry) => {
      entries.unshift(entry);
      repaint();
    },
    show: () => {
      repaint();
      node.hidden = false;
    },
    hide: () => (node.hidden = true),
    isOpen: () => !node.hidden,
  };
}

export function createSandboxPanel(root: HTMLElement, opts: SandboxPanelOptions): SandboxPanel {
  const node = overlay('sandbox-panel');
  const body = el('div', 'scroll-body');
  let selectedRoad: string | null = null;
  let lastState: SandboxPanelState | null = null;
  const runButtons = (): void => {
    if (!lastState) return;
    body.replaceChildren(el('h2', undefined, 'Sandbox Probe'), el('p', 'subtle', `${lastState.probeDays} days per run. Budget: ${lastState.budget}.`));
    const roadLabel = el('p', 'objective', selectedRoad ? `Road selected: ${selectedRoad}` : 'No road selected.');
    body.append(roadLabel, button(`Pick road / close (${lastState.costs.closeRoad})`, opts.onRequestRoadPick, 'btn'));
    const goods = el('select');
    for (const g of lastState.goods) goods.append(new Option(g.name, g.id));
    body.append(el('label', undefined, 'Wholesale price spike'), goods, button(`Run price spike (${lastState.costs.priceSpike})`, () => opts.onRun({ kind: 'priceSpike', good: goods.value }), 'btn'));
    const sites = el('select');
    for (const s of lastState.sites) sites.append(new Option(s.name, s.id));
    const eventType = el('select');
    eventType.append(new Option('Grid maintenance', 'gridMaintenance'), new Option('Festival', 'festival'));
    body.append(el('label', undefined, 'Schedule event'), sites, eventType, button(`Run scheduled event (${lastState.costs.scheduleEvent})`, () => opts.onRun({ kind: 'scheduleEvent', type: eventType.value as 'gridMaintenance' | 'festival', site: sites.value }), 'btn'));
    body.append(button('Run selected road closure', () => opts.onRun({ kind: 'closeRoad' }), 'btn primary'), button('Exit sandbox', opts.onExit, 'btn'));
  };
  node.append(body);
  root.append(node);
  return {
    open: (state) => {
      lastState = state;
      runButtons();
      node.hidden = false;
    },
    close: () => (node.hidden = true),
    isOpen: () => !node.hidden,
    setSelectedRoad: (name) => {
      selectedRoad = name;
      if (!node.hidden) runButtons();
    },
    showRunning: (text) => {
      body.replaceChildren(el('h2', undefined, 'Running Probe'), el('p', 'premise', text));
    },
    showResult: (result: SandboxResultView) => {
      body.replaceChildren();
      body.append(el('h2', undefined, result.title), el('p', 'subtle', `Cost ${result.cost}. Budget left ${result.budgetLeft}.`));
      renderInspect(body, { title: '', sections: result.sections }, undefined);
      body.append(button('Pin prediction result', () => opts.onPin(result.pin), 'btn primary'), button('New probe', runButtons, 'btn'), button('Exit sandbox', opts.onExit, 'btn'));
    },
  };
}

export function createEndgame(root: HTMLElement, opts: EndScreenOptions): EndScreen {
  const node = overlay('end');
  const body = el('div', 'intro-box');
  node.append(body);
  root.append(node);
  const show = (title: string, text: string, artifact: string, reveal: string): void => {
    body.replaceChildren(el('h1', undefined, title), el('p', 'premise', text), el('h2', undefined, artifact), el('p', undefined, reveal), button('Restart case', opts.onRestart, 'btn primary'));
    node.hidden = false;
  };
  return {
    showWin: (o) => show('Artifact found', o.caseTitle, o.artifactName, o.reveal),
    showLose: (o) => show('Case closed unresolved', `${o.caseTitle}. ${o.loseText}`, o.artifactName, o.reveal),
  };
}

export function createConfirm(root: HTMLElement): ConfirmDialog {
  const node = overlay('confirm');
  const box = el('div', 'modal');
  node.append(box);
  root.append(node);
  return {
    show: (text, onYes, onNo) => {
      box.replaceChildren(el('p', undefined, text), button('Commit', () => { node.hidden = true; onYes(); }, 'btn primary'), button('Cancel', () => { node.hidden = true; onNo(); }, 'btn'));
      node.hidden = false;
    },
    isOpen: () => !node.hidden,
  };
}

export function createToast(root: HTMLElement): Toast {
  const node = el('div', 'toast');
  node.hidden = true;
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
  const node = overlay('confirm');
  const box = el('div', 'modal');
  box.append(el('h2', undefined, 'Paused'), ...opts.controlsHelp.map((c) => el('p', 'subtle', c)), button('Resume', opts.onResume, 'btn primary'), button('Restart', opts.onRestart, 'btn'));
  node.append(box);
  root.append(node);
  return { show: () => (node.hidden = false), hide: () => (node.hidden = true), isOpen: () => !node.hidden };
}
