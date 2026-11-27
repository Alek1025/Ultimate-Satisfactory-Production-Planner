import { createProcessSolverPort, runSolve, type PlanningProblem } from './solver';
import type { captureDispatch } from './dispatch';

export async function runAllocation(problem: PlanningProblem, receipt: ReturnType<typeof captureDispatch>) {
  const port = createProcessSolverPort({warmSpare: false});
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    const {request, options, fingerprint} = receipt;
    const terminal = await runSolve(port, { problem, request, options }, {signal: controller.signal});
    console.log(JSON.stringify({fingerprint, ...terminal}, null, 2));
    if (terminal.type === 'engine-error' || terminal.result?.status === 'invalid-request') process.exitCode = 1;
    else if (terminal.outcome === 'partial') process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', cancel);
    await port.close();
  }
}
