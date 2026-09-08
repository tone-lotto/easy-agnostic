// Local JSONL adapters. Unknown record kinds, hidden reasoning, images and base
// instructions are deliberately not exported. No vendor SDK is launched.
export const VENDORS = ['claude', 'codex', 'pi', 'cursor', 'antigravity', 'opencode', 'export'];
const imported = (vendor,x) => ['cursor','antigravity','opencode'].includes(vendor) && x.type === 'eag-history' && x.version === 1 && x.vendor === vendor;

export function metadata(vendor, records) {
  for (const { data: x } of records) {
    if (imported(vendor,x)) return {id:x.id,cwd:x.cwd,timestamp:x.timestamp,binding:x.binding,sourceSha256:x.sourceSha256};
    if (['cursor','antigravity','opencode'].includes(vendor) && x.type === 'eag-history') throw new Error('imported transcript has mismatched vendor metadata');
    if (vendor === 'codex' && x.type === 'session_meta') return { id: x.payload?.id || x.payload?.session_id, cwd: x.payload?.cwd, timestamp: x.timestamp };
    if (vendor === 'claude' && x.sessionId && x.cwd && ['user', 'assistant'].includes(x.type)) return { id: x.sessionId, cwd: x.cwd, timestamp: x.timestamp };
    if (vendor === 'pi' && x.type === 'session' && [1, 2, 3].includes(x.version)) return { id: x.id, cwd: x.cwd, timestamp: x.timestamp };
    if (vendor === 'export' && x.type === 'eag-history' && x.version === 1) return { id: x.id, cwd: x.cwd, timestamp: x.timestamp };
  }
  return null;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && ['text', 'input_text', 'output_text'].includes(c.type) && typeof c.text === 'string').map(c => c.text).join('\n');
}

export function events(vendor, records, { tools = false } = {}) {
  const out = [];
  let cwd;
  const add = (record, kind, text, extra = {}) => {
    if (typeof text !== 'string' || !text) return;
    out.push({ line: record.line, kind, text, cwd, timestamp: record.data.timestamp, ...extra });
  };
  for (const r of records) {
    const x = r.data;
    if (vendor === 'codex') {
      const p = x.payload || {};
      if (['session_meta', 'turn_context'].includes(x.type)) cwd = p.cwd;
      if (x.type === 'compacted') add(r, 'summary', p.message);
      if (x.type !== 'response_item') continue;
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role) && [undefined, null, 'final', 'commentary', 'summary'].includes(p.channel)) add(r, p.role, textContent(p.content));
      if (tools && ['function_call', 'custom_tool_call'].includes(p.type)) add(r, 'tool_call', typeof p.arguments === 'string' ? p.arguments : p.input, { tool: p.name, callId: p.call_id });
      if (tools && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) add(r, 'tool_result', textContent(p.output), { callId: p.call_id });
    } else if (vendor === 'claude' || vendor === 'pi') {
      if (Object.hasOwn(x, 'cwd')) cwd = x.cwd;
      const m = x.message;
      if (vendor === 'pi' && ['compaction', 'branch_summary'].includes(x.type)) add(r, 'summary', x.summary, { branchId: x.id, parentId: x.parentId });
      if (!m || (vendor === 'claude' ? !['user', 'assistant'].includes(x.type) || x.isMeta : x.type !== 'message')) continue;
      const branch = { branchId: x.uuid || x.id, parentId: x.parentUuid ?? x.parentId };
      if (['user', 'assistant'].includes(m.role)) add(r, m.role, textContent(m.content), branch);
      if (tools && m.role === 'toolResult') add(r, 'tool_result', textContent(m.content), { ...branch, tool: m.toolName, callId: m.toolCallId, isError: !!m.isError });
      if (tools && m.role === 'bashExecution') {
        add(r, 'tool_call', m.command, { ...branch, tool: 'bash' });
        add(r, 'tool_result', m.output, { ...branch, tool: 'bash', isError: m.exitCode !== 0 });
      }
      if (tools && Array.isArray(m.content)) for (const c of m.content) {
        if (!c || typeof c !== 'object') continue;
        if (['tool_use', 'toolCall'].includes(c.type)) add(r, 'tool_call', JSON.stringify(c.input ?? c.arguments ?? {}), { ...branch, tool: c.name, callId: c.id });
        if (c.type === 'tool_result') add(r, 'tool_result', textContent(c.content), { ...branch, callId: c.tool_use_id, isError: !!c.is_error });
      }
    } else if (['export','cursor','antigravity','opencode'].includes(vendor)) {
      if (x.type === 'eag-history') cwd = x.cwd;
      if (x.type === 'message' && ['user', 'assistant', 'summary', ...(tools ? ['tool_call', 'tool_result'] : [])].includes(x.kind)) add(r, x.kind, x.text, { callId: x.callId, tool: x.tool, sourceLine:x.sourceLine,sourceRecord:x.sourceRecord });
    }
  }
  return out;
}
