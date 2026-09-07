import fs from 'node:fs';
import { setSecret, deleteSecret, listSecrets, resolveSecret, backendName } from '../secrets.js';
import { c } from '../util.js';

// readline echoes what is typed, which puts the credential in the scrollback, in a tmux
// capture and in any screen recording — in the one command whose whole point is to keep it
// off the command line. Read the raw tty instead and print nothing.
const ENTER = ['\r', '\n'];
const EOT = '\u0004';        // ctrl-D
const ETX = '\u0003';        // ctrl-C
const BACKSPACE = ['\u007f', '\b'];
async function promptHidden(label) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('no value given and stdin is not a terminal: pipe the value in, or use --from-env');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let buf = '';
  try {
    for await (const chunk of stdin) {
      for (const ch of chunk) {
        if (ENTER.includes(ch) || ch === EOT) { stdout.write('\n'); return buf; }
        if (ch === ETX) { stdout.write('\n'); throw new Error('cancelled'); }
        if (BACKSPACE.includes(ch)) { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  return buf;
}

export async function run(args, flags) {
  const sub = args[0];
  if (sub === 'ls' || !sub) {
    const names = listSecrets();
    console.log(c.dim(`backend: ${backendName()}`));
    for (const n of names) console.log(`${n}  ${resolveSecret(n) !== undefined ? c.ok('set') : c.warn('missing')}`);
    if (!names.length) console.log('no secrets stored yet');
    return 0;
  }
  const name = args[1];
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('usage: eag secret set|rm <NAME>');
  if (sub === 'rm') { deleteSecret(name); console.log(`${c.ok('removed')} ${name}`); return 0; }
  if (sub === 'set') {
    let value = flags.value;
    // parseArgs turns a trailing `--value` into `true` and a repeated one into an array;
    // the keychain would coerce either into a stored string and never complain again.
    if (value !== undefined && typeof value !== 'string') throw new Error('--value needs one string value (or pipe the value on stdin)');
    if (flags['from-env']) {
      value = process.env[name];
      if (value === undefined) throw new Error(`--from-env: $${name} is not set in this shell`);
    }
    if (value === undefined && !process.stdin.isTTY) value = fs.readFileSync(0, 'utf8').replace(/\n$/, '');
    if (value === undefined) value = await promptHidden(`value for ${name} (not echoed): `);
    if (!value) throw new Error('empty value');
    setSecret(name, value);
    console.log(`${c.ok('stored ')} ${name} (${backendName()})`);
    return 0;
  }
  throw new Error(`unknown subcommand: secret ${sub}`);
}
