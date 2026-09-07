import { projectRoot } from '../paths.js';
import { syncInstructions } from '../instructions.js';

export async function run(args, flags) {
  let result;
  try {
    if (args.length) throw new Error('usage: eag instructions [--dry-run] [--prefer agents|claude] [--json]');
    result = syncInstructions(projectRoot(), { dryRun: !!flags['dry-run'], prefer: flags.prefer ?? null });
  } catch (e) {
    if (!flags.json) throw e;
    console.log(JSON.stringify({ op: 'error', message: e.message, exit: 1 }));
    return 1;
  }
  const code = result.op === 'conflict' ? 3 : flags['dry-run'] && ['sync', 'enroll'].includes(result.op) ? 2 : 0;
  console.log(flags.json ? JSON.stringify({ ...result, exit: code }) : result.message);
  return code;
}
