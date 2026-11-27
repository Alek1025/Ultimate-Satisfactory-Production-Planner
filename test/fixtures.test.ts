/**
 * The fixture inventory itself. Every listed file must be present with its pinned SHA-256:
 * a missing or different file fails here (and in every test that uses it), never skips.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/util/hash';
import { FIXTURE_SHA256, fixture, MissingFixtureError, type FixtureName } from './fixtures';

describe('fixture inventory', () => {
  it.each(Object.entries(FIXTURE_SHA256) as Array<[FixtureName, string]>)('%s is present with the pinned SHA-256', (name, sha) => {
    expect(sha256Hex(fixture(name))).toBe(sha);
  });

  it('a missing fixture throws instead of skipping', () => {
    expect(() => fixture('does-not-exist.sav' as FixtureName)).toThrow(MissingFixtureError);
  });

  it('fixtures/README.md lists every pinned file and its hash', () => {
    const readme = readFileSync(fileURLToPath(new URL('../fixtures/README.md', import.meta.url)), 'utf8');
    for (const [name, sha] of Object.entries(FIXTURE_SHA256)) {
      expect(readme).toContain(name);
      expect(readme).toContain(sha);
    }
  });
});
