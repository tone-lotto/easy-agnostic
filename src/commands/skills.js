import { inventory } from '../skills.js';
import { projectRoot } from '../paths.js';

export async function run(args, flags) {
  try {
    if (args.length !== 1 || args[0] !== 'ls') throw new Error('usage: eag skills ls [--scope user|project] [--json]');
    const scope = flags.scope ?? 'user';
    const skills = inventory({ scope, root: projectRoot() });
    if (flags.json) console.log(JSON.stringify({ scope, skills }, null, 2));
    else if (!skills.length) console.log('no skills found');
    else for (const s of skills) console.log(`${s.inherited ? 'inherited' : s.scope} ${s.origin} ${s.name}${s.linked ? ' [link]' : ''}${s.conflict ? ' [conflict]' : ''}${s.sameNameInUserScope ? ' [also in user scope]' : ''} ${s.path}`);
    return 0;
  } catch (e) {
    if (!flags.json) throw e;
    console.log(JSON.stringify({ error: e.message, exit: 1 }));
    return 1;
  }
}
