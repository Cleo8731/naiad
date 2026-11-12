import './style.css';
import { App } from './app';
import { createBackend } from './backend';

const backend = await createBackend();
const job = await backend.cliJob();
if (job) {
  // Started as `naiad check` or `naiad fix`: no window is shown and no app is made.
  let result: { code: number; output: string };
  try {
    result = await (await import('./cli')).runCli(job, backend);
  } catch (e) {
    result = { code: 2, output: `naiad: the check failed: ${String((e as Error)?.message ?? e)}` };
  }
  try {
    await backend.cliDone(result.code, result.output);
  } catch (e) {
    // The result could not be handed over: say so now, not at the 60-second limit, and
    // that a fix may have been written already (bug hunt round 2, D13).
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, '?');
    await backend.cliDone(2, `naiad: the result could not be printed (${why}). A fix may have been written already: run "naiad check" on the file to see it as it is.`);
  }
} else {
  await new App(document.getElementById('app')!, backend).init();
}
