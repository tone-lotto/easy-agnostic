// Private, short-lived worker; not a CLI command or a persistent service.
import { runAutoUpdate } from '../src/auto-update.js';
if (process.argv.length === 3) await runAutoUpdate({ baseRoot: process.argv[2] });
