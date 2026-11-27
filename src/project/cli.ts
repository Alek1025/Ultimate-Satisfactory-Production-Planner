// `ussp project …` subcommands. The top-level CLI passes everything after `project` here.
// Output is JSON on stdout; errors go to stderr as `error [CODE]: message`.
import { parseArgs } from 'node:util';
import { ProjectError } from './errors';
import { ProjectStore } from './store';

export const PROJECT_HELP = [
  'ussp project init <file.ussp>',
  'ussp project info <file.ussp>',
  'ussp project replay <file.ussp> [--fold] [--message <text>]',
  'ussp project verify <file.ussp>',
  'ussp project log <file.ussp> [--ref <name>] [--limit <n>]',
  'ussp project show <file.ussp> [--ref <name>]',
  'ussp project edit <file.ussp> --op <json> [--ref <name>] [--op-id <id>]',
  'ussp project fold <file.ussp> [--ref <name>] [--message <text>]',
  'ussp project fork <file.ussp> <name> [--from <ref-or-revision>]',
  'ussp project checkout <file.ussp> <ref>',
  'ussp project export <file.ussp> <out.ussp> [--force]',
].join('\n');

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: CliIO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

class UsageError extends Error {}

/** Run one `project` subcommand. Returns the process exit code (0 ok, 1 failure, 2 usage). */
export function runProjectCommand(args: string[], io: CliIO = defaultIO): number {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        fold: { type: 'boolean' },
        message: { type: 'string', short: 'm' },
        ref: { type: 'string' },
        limit: { type: 'string' },
        op: { type: 'string' },
        'op-id': { type: 'string' },
        from: { type: 'string' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n${PROJECT_HELP}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const [command, file, arg] = positionals;
  if (values.help || !command) {
    io.out(PROJECT_HELP);
    return 0;
  }
  const print = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  const need = (n: number) => {
    if (positionals.length !== n) throw new UsageError(`"${command}" takes ${n - 1} argument(s)`);
  };
  const withStore = <T>(fn: (s: ProjectStore) => T, readOnly = false): T => {
    const store = ProjectStore.open(file!, { readOnly });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };

  try {
    switch (command) {
      case 'init': {
        need(2);
        const s = ProjectStore.create(file!);
        try {
          print({ file: s.file, head: s.head() });
        } finally {
          s.close();
        }
        return 0;
      }
      case 'info':
        need(2);
        withStore((s) => print({ file: s.file, head: s.head(), refs: s.listRefs(), counts: s.counts(), recovery: s.recovery }), true);
        return 0;
      case 'replay':
        need(2);
        withStore((s) => {
          const recovery = s.recovery;
          const folded = values.fold ? s.foldAll(values.message === undefined ? {} : { message: values.message }) : {};
          print({ recovery, folded, head: s.head() });
        });
        return 0;
      case 'verify': {
        need(2);
        const report = withStore((s) => s.verify());
        print(report);
        return report.ok ? 0 : 1;
      }
      case 'log': {
        need(2);
        const limit = values.limit === undefined ? 50 : Number(values.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
        withStore((s) => print(s.log(values.ref ?? 'HEAD', limit)), true);
        return 0;
      }
      case 'show':
        need(2);
        withStore((s) => print(s.working(values.ref ?? 'HEAD')), true);
        return 0;
      case 'edit': {
        need(2);
        if (values.op === undefined) throw new UsageError('--op <json> is required');
        let op: unknown;
        try {
          op = JSON.parse(values.op);
        } catch (e) {
          throw new UsageError(`--op is not JSON: ${(e as Error).message}`);
        }
        withStore((s) => {
          const { entry, duplicate } = s.journal(op, {
            ...(values.ref === undefined ? {} : { ref: values.ref }),
            ...(values['op-id'] === undefined ? {} : { opId: values['op-id'] }),
          });
          print({ entry, duplicate });
        });
        return 0;
      }
      case 'fold':
        need(2);
        withStore((s) => print({ revision: s.fold(values.ref ?? 'HEAD', values.message === undefined ? {} : { message: values.message }) }));
        return 0;
      case 'fork':
        need(3);
        withStore((s) => {
          const from = values.from ?? 'HEAD';
          const revision = s.hasRevision(from) ? from : s.resolve(from);
          s.createRef(arg!, revision);
          print({ ref: arg, revision });
        });
        return 0;
      case 'checkout':
        need(3);
        withStore((s) => {
          s.checkout(arg!);
          print({ head: s.head() });
        });
        return 0;
      case 'export':
        need(3);
        withStore((s) => print({ exported: s.exportTo(arg!, { overwrite: values.force ?? false }) }), true);
        return 0;
      default:
        throw new UsageError(`unknown project command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${PROJECT_HELP}`);
      return 2;
    }
    if (e instanceof ProjectError) {
      io.err(`error [${e.code}]: ${e.message}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
