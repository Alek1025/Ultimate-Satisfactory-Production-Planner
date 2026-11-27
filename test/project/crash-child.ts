// Child process for the crash-replay tests. It is killed mid-write, by the parent or by itself.
//
//   loop  <file> <startIndex> <foldEvery>       journal workload ops forever, folding every N
//   fault <file> <point> <action> [<target>]     run one action and SIGKILL itself at <point>
//
// Progress goes through fs.writeSync so a line printed before a kill is never lost in a buffer.
import { writeSync } from 'node:fs';
import { ProjectStore, type FaultPoint } from '../../src/project';
import { opId, workloadOp } from './support';

const say = (line: string) => writeSync(1, line + '\n');
const [mode, file, a, b, c] = process.argv.slice(2);

if (mode === 'loop') {
  const start = Number(a);
  const foldEvery = Number(b);
  const store = ProjectStore.open(file!);
  say('ready');
  for (let i = start; ; i++) {
    const { duplicate } = store.journal(workloadOp(i), { opId: opId(i) });
    say(`ack ${i}${duplicate ? ' dup' : ''}`);
    if ((i + 1) % foldEvery === 0) {
      store.fold();
      say(`fold ${i}`);
    }
  }
} else if (mode === 'fault') {
  const point = a as FaultPoint;
  const faults = (p: FaultPoint) => {
    if (p !== point) return;
    say(`kill ${p}`);
    process.kill(process.pid, 'SIGKILL');
  };
  switch (b) {
    case 'create':
      ProjectStore.create(c!, { faults });
      break;
    case 'journal': {
      const store = ProjectStore.open(file!, { faults });
      store.journal(workloadOp(Number(c)), { opId: opId(Number(c)) });
      break;
    }
    case 'fold':
      ProjectStore.open(file!, { faults }).fold();
      break;
    case 'commit': {
      const store = ProjectStore.open(file!, { faults });
      store.commit({ charter: { forked: true }, network: {}, message: 'side commit' }, [store.head().revision]);
      break;
    }
    case 'export':
      ProjectStore.open(file!, { faults }).exportTo(c!);
      break;
    default:
      throw new Error(`unknown action ${b}`);
  }
  say('done');
} else {
  throw new Error(`unknown mode ${mode}`);
}
