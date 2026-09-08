import fs from 'node:fs';
import path from 'node:path';
import { scopePaths, assertProjectScope } from './paths.js';
import { guardConfig } from './json-config.js';
import { writeFileAtomic, readJsonSnapshot, backup } from './util.js';
import { withMutationLock } from './lock.js';

// Antigravity documents relative @file imports and the legacy .agent/rules
// location. Activation is chosen in its UI, not an invented YAML contract.
export const RULE = '# Shared project instructions\n\nRead and follow the shared project instructions below. They are maintained in AGENTS.md; edit that file for shared changes.\n\n@../../AGENTS.md\n';
export function instructionRule(root, { dryRun = false, remove = false, status = false } = {}) {
  const work = () => {
    const paths = assertProjectScope(scopePaths('project',root));
    const file = path.join(root,'.agent','rules','eag-project.md');
    const stateFile = path.join(paths.state,'antigravity-instructions.json');
    const guard = () => { guardConfig(file,{root}); guardConfig(stateFile,{root}); };
    guard();
    const state = readJsonSnapshot(stateFile,null);
    let text = null;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.nlink !== 1 || st.size > 12000) throw new Error('Antigravity instruction rule is not a safe regular file');
      text = fs.readFileSync(file,'utf8');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const owned = state.value?.file === file && state.value?.text === RULE;
    const current = text === RULE;
    const activation = 'Select Always On for .agent/rules/eag-project.md in Antigravity workspace customization; activation is not verified by EAG.';
    if (status) return {file,installed:text !== null,owned,current,activation};
    if (state.value && !owned) throw new Error('Antigravity instruction ownership changed; preserved for review');
    if (text !== null && (!owned || !current)) throw new Error('Antigravity instruction rule is unowned or modified; preserved for review');
    if (remove && !owned) return {op:'noop',message:'no owned Antigravity instruction rule'};
    if (!remove) {
      const st = fs.lstatSync(path.join(root,'AGENTS.md'));
      if (!st.isFile() || st.nlink !== 1) throw new Error('AGENTS.md must be a regular project file');
    }
    if (!remove && current && owned) return {op:'noop',message:activation};
    if (dryRun) return {op:'sync',message:`Would ${remove ? 'remove' : 'create'} ${file}. ${remove ? '' : activation}`};
    guard();
    if (remove) {
      if (text !== null) {
        backup(file,path.join(paths.state,'backup'),'antigravity-instructions');
        if (fs.readFileSync(file,'utf8') !== RULE) throw new Error('instruction rule changed since planning');
        fs.unlinkSync(file);
      }
    } else writeFileAtomic(file,RULE,0o600,{expected:null});
    try {
      writeFileAtomic(stateFile,JSON.stringify(remove ? null : {file,text:RULE})+'\n',0o600,{expected:state.text});
    } catch (e) {
      // Restore our exact change if ownership cannot be recorded.
      if (!remove && fs.readFileSync(file,'utf8') === RULE) fs.unlinkSync(file);
      if (remove && text !== null && !fs.existsSync(file)) writeFileAtomic(file,text,0o600,{expected:null});
      throw e;
    }
    return {op:'sync',message:`${remove ? 'Removed owned rule (private backup retained)' : 'Created Antigravity project rule'}: ${file}. ${remove ? '' : activation}`};
  };
  return dryRun || status ? work() : withMutationLock(work);
}
