import { projectRoot } from '../paths.js';
import { syncInstructions } from '../instructions.js';
import { instructionRule } from '../instruction-rule.js';

export async function run(args, flags) {
  let result;
  try {
    if (args.length) throw new Error('usage: eag instructions [--target antigravity] [--remove] [--dry-run] [--prefer agents|claude] [--json]');
    for (const key of ['dry-run','remove','json']) if (flags[key] !== undefined && flags[key] !== true) throw new Error(`--${key} is a boolean flag`);
    if (flags.target !== undefined && flags.target !== 'antigravity') throw new Error('Cursor and OpenCode read AGENTS.md natively; only Antigravity needs --target');
    if (flags.remove && !flags.target || flags.target && flags.prefer) throw new Error('--remove needs --target; --prefer applies only to shared instruction sync');
    result = flags.target ? instructionRule(projectRoot(),{dryRun:!!flags['dry-run'],remove:!!flags.remove})
      : syncInstructions(projectRoot(), { dryRun: !!flags['dry-run'], prefer: flags.prefer ?? null });
  } catch (e) {
    if (!flags.json) throw e;
    console.log(JSON.stringify({ op: 'error', message: e.message, exit: 1 }));
    return 1;
  }
  const code = result.op === 'conflict' ? 3 : flags['dry-run'] && ['sync', 'enroll'].includes(result.op) ? 2 : 0;
  console.log(flags.json ? JSON.stringify({ ...result, exit: code }) : result.message);
  return code;
}
