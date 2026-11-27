// Shared by the project tests and the crash child process.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits, type PlanContent, type PlanEdit } from '../../src/project';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

export const EMPTY: PlanContent = { worldBase: null, charter: {}, network: {} };

/** Deterministic pseudo-random numbers, so a big value is the same in the child and the model. */
function lcg(seed: number, n: number): number[] {
  let x = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(x);
  }
  return out;
}

/** The i-th op of the crash workload. Every op applies to the result of ops 0..i-1. */
export function workloadOp(i: number): PlanEdit {
  if (i === 0) return { kind: 'set', doc: 'charter', path: ['goals'], value: {} };
  if (i === 1) return { kind: 'set', doc: 'network', path: ['sites'], value: [] };
  switch (i % 4) {
    case 0:
      return { kind: 'set', doc: 'charter', path: ['goals', `g${i}`], value: { item: `Desc_Item${i % 7}_C`, rate: i * 1.5 } };
    case 1:
      return { kind: 'insert', doc: 'network', path: ['sites', 0], value: { id: `site-${i}`, x: i, y: -i } };
    case 2:
      // A large value, so kills land in the middle of multi-page writes.
      return { kind: 'set', doc: 'network', path: ['bulk'], value: lcg(i, 4000) };
    default:
      return i - 3 >= 4
        ? { kind: 'remove', doc: 'charter', path: ['goals', `g${i - 3}`] }
        : { kind: 'set', doc: 'charter', path: ['note'], value: `n${i}` };
  }
}

export function opId(i: number): string {
  return `op-${i}`;
}

/** Expected working content after the first n workload ops. */
export function model(n: number): PlanContent {
  return applyEdits(EMPTY, Array.from({ length: n }, (_, i) => workloadOp(i)));
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ussp-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

export interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
  stderr: string;
  killedByParent: boolean;
}

/**
 * Run the crash child. `killWhen` is checked on each stdout line; when it returns true the parent
 * hard-kills the child (TerminateProcess on Windows, SIGKILL elsewhere) after `delayMs`.
 */
export function runChild(args: string[], killWhen?: (lines: string[]) => boolean, delayMs = 0): Promise<ChildRun> {
  const loader = pathToFileURL(path.join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', loader, CHILD, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  let buf = '';
  let stderr = '';
  let killing = false;
  let killedByParent = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop()!;
    lines.push(...parts.filter(Boolean));
    if (!killing && killWhen?.(lines)) {
      killing = true;
      setTimeout(() => {
        killedByParent = child.kill('SIGKILL');
      }, delayMs);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (buf) lines.push(buf);
      resolve({ code, signal, lines, stderr, killedByParent });
    });
  });
}
