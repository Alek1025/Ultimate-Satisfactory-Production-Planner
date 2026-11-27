import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProjectCommand } from '../../src/project';
import { tempDir } from './support';

let dir: string;
let cleanup: () => void;
beforeEach(() => ({ dir, cleanup } = tempDir()));
afterEach(() => cleanup());

function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runProjectCommand(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  const text = out.join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // help text
  }
  return { code, json, text, err: err.join('\n') };
}

describe('ussp project', () => {
  it('init, edit, replay, fold, log, fork, checkout, show, export, verify', () => {
    const file = path.join(dir, 'p.ussp');
    expect(cli('init', file).code).toBe(0);
    expect(cli('init', file)).toMatchObject({ code: 1, err: expect.stringContaining('[EXISTS]') });

    const op = JSON.stringify({ kind: 'set', doc: 'charter', path: ['goals'], value: { plates: 6340 } });
    expect(cli('edit', file, '--op', op, '--op-id', 'e1').json).toMatchObject({ duplicate: false, entry: { opId: 'e1', seq: 1 } });
    expect(cli('edit', file, '--op', op, '--op-id', 'e1').json.duplicate).toBe(true);

    const replay = cli('replay', file);
    expect(replay.json.recovery).toMatchObject({ pendingTotal: 1 });
    const folded = cli('replay', file, '--fold', '-m', 'Save');
    expect(Object.keys(folded.json.folded)).toEqual(['main']);
    expect(cli('fold', file).json).toEqual({ revision: null });
    expect(cli('log', file).json.map((r: any) => r.message)).toEqual(['Save', 'Create project']);

    expect(cli('fork', file, 'what-if').json.ref).toBe('what-if');
    expect(cli('checkout', file, 'what-if').json.head.ref).toBe('what-if');
    cli('edit', file, '--op', JSON.stringify({ kind: 'set', doc: 'charter', path: ['fork'], value: true }));
    expect(cli('show', file).json).toMatchObject({ ref: 'what-if', pending: 1, charter: { goals: { plates: 6340 }, fork: true } });
    expect(cli('show', file, '--ref', 'main').json.charter).toEqual({ goals: { plates: 6340 } });

    const info = cli('info', file).json;
    expect(info.counts).toMatchObject({ plan_revisions: 2, journal: 2, journal_pending: 1 });

    const out = path.join(dir, 'copy.ussp');
    expect(cli('export', file, out).code).toBe(0);
    expect(cli('export', file, out).code).toBe(1);
    expect(cli('export', file, out, '--force').code).toBe(0);
    expect(cli('verify', out)).toMatchObject({ code: 0, json: { ok: true, problems: [] } });
  });

  it('reports bad input with codes and exit status', () => {
    const file = path.join(dir, 'p.ussp');
    cli('init', file);
    expect(cli('edit', file, '--op', '{nope')).toMatchObject({ code: 2 });
    expect(cli('edit', file)).toMatchObject({ code: 2 });
    expect(cli('edit', file, '--op', '{"kind":"remove","doc":"charter","path":["x"]}')).toMatchObject({ code: 1, err: expect.stringContaining('[BAD_EDIT]') });
    expect(cli('info', path.join(dir, 'missing.ussp'))).toMatchObject({ code: 1, err: expect.stringContaining('[NOT_FOUND]') });
    expect(cli('frobnicate', file).code).toBe(2);
    expect(cli('log', file, '--limit', '0').code).toBe(2);
    expect(cli('--bogus').code).toBe(2);
    expect(cli().text).toContain('ussp project init');
  });
});
