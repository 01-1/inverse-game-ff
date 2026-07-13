import { describe, expect, it } from 'vitest';
import { globalShortcutAction, type ShortcutContext } from '../src/input-policy';
import { wrappedDialogFocusIndex } from '../src/ui/focus';

const world: ShortcutContext = {
  playing: true,
  mode: 'world',
  activeUi: 'none',
  pointerLocked: true,
  pickingRoad: false,
};

describe('global input policy', () => {
  it('leaves Tab native and blocks unrelated shortcuts behind every panel', () => {
    expect(globalShortcutAction('Tab', world)).toBeNull();
    for (const activeUi of ['inspect', 'sandbox', 'confirm', 'menu'] as const) {
      const context = { ...world, activeUi, pointerLocked: false };
      expect(globalShortcutAction('KeyJ', context)).toBeNull();
      expect(globalShortcutAction('KeyB', context)).toBeNull();
      expect(globalShortcutAction('KeyF', context)).toBeNull();
      expect(globalShortcutAction('KeyG', context)).toBeNull();
    }
  });

  it('uses J for the journal and routes Escape only to the active surface', () => {
    expect(globalShortcutAction('KeyJ', world)).toBe('toggleJournal');
    expect(globalShortcutAction('KeyJ', { ...world, activeUi: 'journal', pointerLocked: false })).toBe('toggleJournal');
    expect(globalShortcutAction('Escape', { ...world, activeUi: 'sandbox', pointerLocked: false })).toBe('dismissPanel');
    expect(globalShortcutAction('Escape', { ...world, activeUi: 'menu', pointerLocked: false })).toBe('resume');
    expect(globalShortcutAction('Escape', { ...world, activeUi: 'confirm', pointerLocked: false })).toBeNull();
  });

  it('routes only Escape while the sandbox dialog is suspended for a road pick', () => {
    const roadPickContext: ShortcutContext = {
      ...world,
      mode: 'sandbox',
      activeUi: 'none',
      pointerLocked: true,
      pickingRoad: true,
    };
    expect(globalShortcutAction('Escape', roadPickContext)).toBe('cancelRoadPick');
    for (const code of ['Tab', 'KeyJ', 'KeyB', 'KeyF', 'KeyG']) {
      expect(globalShortcutAction(code, roadPickContext)).toBeNull();
    }
  });
});

describe('dialog focus policy', () => {
  it('wraps at both ends while leaving movement inside the dialog native', () => {
    expect(wrappedDialogFocusIndex(0, 3, true)).toBe(2);
    expect(wrappedDialogFocusIndex(2, 3, false)).toBe(0);
    expect(wrappedDialogFocusIndex(1, 3, false)).toBeNull();
    expect(wrappedDialogFocusIndex(1, 3, true)).toBeNull();
  });
});
