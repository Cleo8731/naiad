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
  await backend.cliDone(result.code, result.output);
} else {
  await new App(document.getElementById('app')!, backend).init();
}
