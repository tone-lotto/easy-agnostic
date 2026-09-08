import { redactConfig, redactUrl } from '../redact.js';

// Transcripts are free text, not MCP config. Mask obvious credentials before
// searching or clipping so a snippet cannot expose the tail of a matched secret.
// Deliberately no keychain access: history retrieval never unlocks credentials.
export function redactTranscript(input) {
  let text = String(input ?? '');
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]');
  text = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');
  // Structured calls/config pasted into messages get the stronger field masker.
  try { const data = JSON.parse(text); if (data && typeof data === 'object') text = JSON.stringify(redactConfig(data)); } catch { /* prose */ }
  text = text.replace(/https?:\/\/[^\s<>"'`]+/gi, url => redactUrl(url));
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted authorization]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+|npm_[A-Za-z0-9]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]');
  text = text.replace(/((?:[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
  text = text.replace(/(--(?:token|password|secret|api-key|authorization)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi, '$1[redacted]');
  return text;
}
