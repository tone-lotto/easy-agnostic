#!/usr/bin/env node
import { boot } from '../src/update-runtime.js';
boot(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(`eag: ${err?.message ?? err}`); if (process.env.EAG_DEBUG) console.error(err); process.exit(1); },
);
