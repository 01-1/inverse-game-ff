export type ActiveUi = 'none' | 'inspect' | 'journal' | 'sandbox' | 'confirm' | 'menu';

export type GlobalShortcutAction =
  | 'toggleJournal'
  | 'openSandbox'
  | 'inspect'
  | 'commit'
  | 'cancelRoadPick'
  | 'dismissPanel'
  | 'resume'
  | 'pause';

export interface ShortcutContext {
  playing: boolean;
  mode: 'world' | 'sandbox';
  activeUi: ActiveUi;
  pointerLocked: boolean;
  pickingRoad: boolean;
}

/** Decide whether a global key belongs to the world or must remain native to the active UI. */
export function globalShortcutAction(code: string, context: ShortcutContext): GlobalShortcutAction | null {
  if (!context.playing) return null;
  if (context.pickingRoad) return code === 'Escape' ? 'cancelRoadPick' : null;
  switch (code) {
    case 'KeyJ':
      if (context.activeUi === 'journal') return 'toggleJournal';
      return context.activeUi === 'none' && context.mode === 'world' ? 'toggleJournal' : null;
    case 'KeyB':
      return context.activeUi === 'none' && context.mode === 'world' ? 'openSandbox' : null;
    case 'KeyF':
      return context.activeUi === 'none' && context.pointerLocked ? 'inspect' : null;
    case 'KeyG':
      return context.activeUi === 'none' && context.pointerLocked && context.mode === 'world' ? 'commit' : null;
    case 'Escape':
      if (context.activeUi === 'confirm') return null;
      if (context.activeUi === 'menu') return 'resume';
      if (context.activeUi === 'inspect' || context.activeUi === 'journal' || context.activeUi === 'sandbox') {
        return 'dismissPanel';
      }
      return 'pause';
    default:
      return null;
  }
}
