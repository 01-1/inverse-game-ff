import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('interaction wiring', () => {
  const renderSource = readFileSync(resolve(import.meta.dirname, '../src/render/index.ts'), 'utf8');

  it('registers the plaza pad as a building pick target', () => {
    const plazaPickRule = /pad\.userData\.pick\s*=\s*\{\s*kind:\s*'building',\s*id:\s*b\.id\s*\}/;
    const plazaPickablesRule = /this\.pickables\.push\(pad\)/;

    expect(renderSource).toMatch(plazaPickRule);
    expect(renderSource).toMatch(plazaPickablesRule);
  });
});
