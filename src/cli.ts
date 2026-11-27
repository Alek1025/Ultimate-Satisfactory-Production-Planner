import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseGameData, readDocsFile } from './gamedata/docs-parser';
import { readCatalogPack, resolveNodes } from './gamedata/node-catalog';
import { summarizeSaveBytes } from './save/extract';
import { charterSchema } from './charter';
import { canonicalRequest, captureDispatch } from './dispatch';
import { sha256Hex, stableStringify } from './util/hash';
import { buildPlanningProblem } from './solver/problem';
import { SOLVER_VERSION } from './solver/solve';
import pkg from '../package.json';
import { runAllocation } from './run-allocation';

const help = [
  'ussp summary <docs.json> <save.sav> [--catalog <pack.json>]',
  'ussp solve <docs.json> <save.sav> <charter.json> [--catalog <pack.json>]',
  'ussp verify',
  'ussp project --help',
].join('\n');

async function main(args: string[]) {
  if (args[0] === 'project') {
    const {runProjectCommand} = await import('./project/cli');
    process.exitCode = runProjectCommand(args.slice(1));
    return;
  }
  const {positionals, values} = parseArgs({args, allowPositionals: true,
    options: { catalog: {type: 'string'}, help: {type: 'boolean', short: 'h'} }});
  const [command, docsPath, savePath, charterPath] = positionals;
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (command === 'verify' && positionals.length === 1) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const runner = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [runner, 'run'], {cwd: root, stdio: 'inherit'});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (!docsPath || !savePath || !((command === 'summary' && positionals.length === 3) ||
    (command === 'solve' && charterPath && positionals.length === 4))) throw new Error(help);
  const game = parseGameData(readDocsFile(readFileSync(docsPath)));
  const bytes = readFileSync(savePath);
  const summary = summarizeSaveBytes(bytes, game);
  const pack = values.catalog ? readCatalogPack(readFileSync(values.catalog)) : undefined;
  const nodes = resolveNodes(summary, game, pack?.catalog);
  if (command === 'summary') {
    console.log(JSON.stringify({source: summary.source, version: summary.version, gameMode: summary.gameMode,
      progression: summary.progression, holdings: summary.holdings, nodeCount: nodes.nodes.length,
      resources: Object.fromEntries(nodes.counts), parseStats: summary.parseStats,
      warnings: [...game.warnings, ...summary.warnings, ...nodes.warnings]}, null, 2));
    return;
  }
  const {options, ...request} = charterSchema.parse(JSON.parse(readFileSync(charterPath!, 'utf8')));
  const receipt = captureDispatch({
    docsModel: game.contentHash, catalog: pack?.sha256 ?? null,
    worldSnapshot: sha256Hex(bytes), planRevision: sha256Hex(stableStringify(canonicalRequest(request))),
    constants: game.constants, solverVersion: SOLVER_VERSION + '/highs-' + pkg.dependencies.highs,
    request, options,
  });
  await runAllocation(buildPlanningProblem(game, summary, nodes), receipt);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
