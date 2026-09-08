import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EAG_HOME, physicalPath } from '../paths.js';
import { NEW_AGENTS } from '../agents.js';
import { redactTranscript } from './redact.js';

const MAX = 32 * 1024 * 1024;
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(p=>p?.type === 'text' && typeof p.text === 'string').map(p=>p.text).join('\n') : '';
const role = value => ['user','assistant'].includes(value) ? value : null;

export function normalizeExport(vendor, input, {project,bindProject=false,tools=false} = {}) {
  if (!NEW_AGENTS.includes(vendor)) throw new Error('import supports cursor, antigravity and opencode');
  if (Buffer.byteLength(input) > MAX) throw new Error('export exceeds 32 MiB');
  const rows = []; let id, directory;
  const emit = (kind,value,line,extra={}) => { const content = text(value); if (content) rows.push({type:'message',kind,text:redactTranscript(content),sourceLine:line,...extra}); };
  let data;
  try { data = JSON.parse(input); } catch { /* JSONL or markdown below */ }
  if (vendor === 'opencode' && data?.info && Array.isArray(data.messages)) {
    id = data.info.id; directory = data.info.directory;
    for (const [index,message] of data.messages.entries()) {
      const info = message.info ?? {};
      if (info.sessionID !== undefined && info.sessionID !== id) throw new Error('export contains mixed sessions');
      if (info.path?.cwd && directory && physicalPath(info.path.cwd) !== physicalPath(directory)) throw new Error('export contains another working directory');
      if (!role(info.role)) continue;
      for (const part of message.parts ?? []) {
        if (part?.type === 'text' && !part.ignored) emit(info.role,part.text,1,{sourceRecord:index});
        if (tools && part?.type === 'tool') {
          emit('tool_call',JSON.stringify(part.state?.input ?? {}),1,{sourceRecord:index,tool:part.tool,callId:part.callID});
          if (typeof part.state?.output === 'string') emit('tool_result',part.state.output,1,{sourceRecord:index,tool:part.tool,callId:part.callID});
        }
      }
    }
  } else if (input.trimStart().startsWith('{')) {
    const records = data ? [{data,line:1}] : input.split('\n').flatMap((line,index)=>{ if (!line.trim()) return []; try { return [{data:JSON.parse(line),line:index+1}]; } catch { throw new Error('unsupported or incomplete JSON export; no partial import'); } });
    for (const {data:x,line} of records) {
      // Cursor stream-json includes system/init cwd and session_id. No provider
      // system content or hidden reasoning is retained, only binding metadata.
      const nextId = x.session_id ?? x.conversation_id ?? x.result?.conversation_id;
      if (nextId && id && nextId !== id) throw new Error('export contains mixed sessions');
      if (nextId) id = nextId;
      const nextDir = x.cwd ?? x.workspace_directory;
      if (nextDir && directory && physicalPath(nextDir) !== physicalPath(directory)) throw new Error('export contains multiple projects');
      if (nextDir) directory = nextDir;
      const kind = role(x.type) ?? role(x.role) ?? role(x.event);
      if (kind) emit(kind,x.message?.content ?? x.content ?? x.text,line);
      // Official headless result envelopes: visible final response only.
      if (vendor === 'antigravity' && x.event === 'result') emit('assistant',x.result?.response,line);
      if (vendor === 'cursor' && x.type === 'result') emit('assistant',x.result,line);
    }
  } else if (vendor === 'cursor' || vendor === 'antigravity') {
    let kind = null, start = 1, buffer = [], fence = null;
    const flush = () => { if (kind) emit(kind,buffer.join('\n').trim(),start); buffer = []; };
    for (const [index,line] of input.split('\n').entries()) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; }
      const heading = !fence && /^(?:#{1,6}\s+|\*\*)(User|Assistant)(?:\*\*)?\s*:?\s*$/i.exec(line);
      const other = !fence && /^#{1,6}\s+(?:System|Thinking|Reasoning|Developer)\s*:?\s*$/i.test(line);
      if (heading || other) { flush(); kind = heading ? heading[1].toLowerCase() : null; start = index+2; }
      else buffer.push(line);
    }
    flush();
  }
  const selected = physicalPath(project);
  if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory) || physicalPath(directory) !== selected)) throw new Error('export project does not match --project; rebinding recorded metadata is refused');
  if (!directory && !bindProject) throw new Error('export has no verified project metadata; inspect it and explicitly add --bind-project to attest --project');
  if (!rows.length) throw new Error('no supported visible messages; use OpenCode JSON, Cursor/Antigravity stream-JSON or role-heading Markdown');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) id = randomUUID();
  return [{type:'eag-history',version:1,vendor,id,cwd:selected,binding:directory ? 'recorded' : 'user-attested',sourceSha256:createHash('sha256').update(input).digest('hex'),timestamp:new Date().toISOString()},...rows];
}

export function importHistory(vendor,{file,project,bindProject=false,tools=false,output,dryRun=false} = {}) {
  if (typeof file !== 'string' || typeof project !== 'string' || !path.isAbsolute(project)) throw new Error('history import requires --file and an absolute --project');
  const source = path.resolve(file), fd = fs.openSync(source,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let input;
  try { const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > MAX) throw new Error('export must be a regular non-linked file at most 32 MiB'); input = fs.readFileSync(fd,'utf8'); }
  finally { fs.closeSync(fd); }
  const records = normalizeExport(vendor,input,{project,bindProject,tools});
  const destination = output ? path.resolve(output) : path.join(EAG_HOME,'.state','history',vendor,`${records[0].id}-${randomUUID()}.jsonl`);
  if (dryRun) return {vendor,id:records[0].id,events:records.length-1,binding:records[0].binding,output:destination,dryRun:true,sent:false};
  // Never replace a transcript/receipt or follow directory aliases during import.
  for (let dir = path.dirname(destination); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    let st; try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink() && !['/tmp','/var'].includes(dir)) throw new Error('history destination aliases are refused');
  }
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  const out = fs.openSync(destination,'wx',0o600);
  try { fs.writeFileSync(out,records.map(r=>JSON.stringify(r)).join('\n')+'\n'); } finally { fs.closeSync(out); }
  return {vendor,id:records[0].id,events:records.length-1,binding:records[0].binding,output:destination,sent:false};
}
