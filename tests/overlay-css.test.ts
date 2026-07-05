import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('overlay stylesheet', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8');

  it('lets the hidden attribute override overlay display rules', () => {
    const hiddenOverlayRule = /\.overlay\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important\s*;[^}]*\}/;

    expect(css).toMatch(hiddenOverlayRule);
  });

  it('allows tall full-screen overlays to scroll', () => {
    const overlayRule = /\.overlay\s*\{[^}]*overflow-y\s*:\s*auto\s*;[^}]*\}/;
    const overlayBoxRule = /\.(?:intro-box|modal)\s*,\s*\.(?:intro-box|modal)\s*\{[^}]*max-height\s*:\s*calc\(100vh - 48px\)\s*;[^}]*overflow\s*:\s*auto\s*;[^}]*margin\s*:\s*auto 0\s*;[^}]*\}/;

    expect(css).toMatch(overlayRule);
    expect(css).toMatch(overlayBoxRule);
  });
});
