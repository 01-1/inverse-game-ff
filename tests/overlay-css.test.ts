import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('overlay stylesheet', () => {
  it('lets the hidden attribute override overlay display rules', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8');
    const hiddenOverlayRule = /\.overlay\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important\s*;[^}]*\}/;

    expect(css).toMatch(hiddenOverlayRule);
  });
});
