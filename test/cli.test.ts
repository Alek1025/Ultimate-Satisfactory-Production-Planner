import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const catalog = 'fixtures/node-catalog-1.2.json';

it('runs the Obsidian charter through the CLI and returns its dispatch fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ussp-charter-'));
  try {
    const charter = join(dir, 'request.json');
    writeFileSync(charter, JSON.stringify({
      targets: [{item: 'Desc_IronPlate_C', ratePerMin: 20000}],
      budgets: {powerShards: 10},
    }));
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'solve',
      'fixtures/en-US.json', 'fixtures/obsidian-gears.sav', charter, '--catalog', catalog],
    {encoding: 'utf8', timeout: 45000});
    const receipt = JSON.parse(output);
    expect(receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.result.status).toBe('targets-not-met');
    expect(receipt.result.items.find((item: {item: string}) => item.item === 'Desc_IronPlate_C').delivered)
      .toBeCloseTo(6340, 3);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}, 50000);
