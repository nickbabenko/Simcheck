#!/usr/bin/env node
/**
 * Copy the step contract from a simbase checkout: its packages/protocol/src/steps.ts becomes
 * src/wire/steps.ts here, byte for byte. That file is the one schema both sides validate steps
 * with (simbase docs/30 R1); edit it in simbase, never here.
 *
 *   node scripts/vendor-steps.mjs ../simbase
 *   node scripts/vendor-steps.mjs ../simbase --check   # exit 1 if the copy has drifted
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [simbase, flag] = process.argv.slice(2);
if (!simbase) {
  console.error('usage: node scripts/vendor-steps.mjs <path to simbase> [--check]');
  process.exit(2);
}

const source = path.resolve(simbase, 'packages/protocol/src/steps.ts');
const target = fileURLToPath(new URL('../src/wire/steps.ts', import.meta.url));
const wanted = fs.readFileSync(source);

if (flag === '--check') {
  const same = fs.existsSync(target) && fs.readFileSync(target).equals(wanted);
  console.log(same ? 'src/wire/steps.ts matches simbase' : `src/wire/steps.ts has drifted from ${source}`);
  process.exit(same ? 0 : 1);
}

fs.writeFileSync(target, wanted);
console.log(`copied ${source} -> src/wire/steps.ts`);
