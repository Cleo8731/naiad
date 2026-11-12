// `naiad check <file>...` and `naiad fix <file>...`: the checker run from a terminal.
// The desktop shell starts the app with no window shown (src-tauri/src/lib.rs); this
// runs the check with Mermaid's own parser and hands back the text to print and the
// exit code: 0 no problems, 1 problems, 2 the check could not be made.

import mermaid from 'mermaid';
import type { Backend, CliJob } from './backend';
import { checkFile, fixFile, formatReport } from './core/check';
import { reading } from './semantics';

const KINDS = /\.(mmd|mermaid|md|markdown)$/i;

export async function runCli(job: CliJob, backend: Backend): Promise<{ code: number; output: string }> {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
  if (!job.files.length) return { code: 2, output: `Usage: naiad ${job.mode} <file>...` };

  const out: string[] = [];
  let problems = 0;
  let failed = false;
  for (const { name, path } of job.files) {
    if (!KINDS.test(name)) {
      out.push(`${name}: not checked: Naiad reads .mmd, .mermaid and .md files.`);
      failed = true;
      continue;
    }
    let raw: string;
    try {
      raw = await backend.read(path);
    } catch (e) {
      out.push(`${name}: cannot be read: ${String((e as Error)?.message ?? e)}`);
      failed = true;
      continue;
    }
    if (job.mode === 'fix') {
      const fixed = await fixFile(name, raw, reading);
      if (fixed.refused) {
        out.push(`${name}: not fixed: ${fixed.refused}`);
      } else if (fixed.lines.length) {
        // The file may have been changed by someone else since it was read: then leave it.
        if ((await backend.read(path)) !== raw) {
          out.push(`${name}: not fixed: the file changed while it was being checked. Run the command again.`);
        } else {
          await backend.write(path, fixed.raw);
          raw = fixed.raw;
          const which = fixed.lines.length === 1 ? `line ${fixed.lines[0]}` : `lines ${fixed.lines.join(', ')}`;
          out.push(`${name}: fixed ${which} ("%%" became "%% .")`);
        }
      }
    }
    const report = await checkFile(name, raw, reading);
    problems += report.findings.length;
    out.push(formatReport(name, raw, report));
  }
  return { code: failed ? 2 : problems ? 1 : 0, output: wellFormed(out.join('\n')) };
}

/**
 * The text with any half of a character pair (a lone surrogate) replaced by U+FFFD. The
 * output is handed to the desktop shell as UTF-8, which cannot hold half a character:
 * the handover would fail, and the program would end only at its 60-second limit,
 * after `fix` had written its change (bug hunt round 2, D13).
 */
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}
