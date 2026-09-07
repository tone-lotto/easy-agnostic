import { execFileSync } from 'node:child_process';

// A hung CLI or locked credential store must not hold agent startup indefinitely.
export function runCommand(command, args, options = {}) {
  return execFileSync(command, args, { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, ...options });
}
