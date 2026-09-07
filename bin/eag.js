#!/usr/bin/env node
import { main } from '../src/cli.js';
main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(`eag: ${err?.message ?? err}`); if (process.env.EAG_DEBUG) console.error(err); process.exit(1); },
);
