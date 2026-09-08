import { redactKnown, WHOLE_REF, looksLikeSecret } from './util.js';

export const HIDDEN = '[redacted]';
// Preserve references (and the conventional Bearer prefix), never arbitrary text
// beside them: "${HOST}:literal-password" still contains a literal credential.
const reference = (value) => typeof value === 'string' && /^(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
const privateValue = (value) => reference(value) ? value : HIDDEN;

export function redactUrl(value) {
  if (typeof value !== 'string') return value;
  if (WHOLE_REF.test(value)) return value;
  // Keep placeholders intact rather than percent-encoding them with URL.toString().
  return value.replace(/(https?:\/\/)[^/\s@]*@/gi, `$1${HIDDEN}@`)
    .replace(/([?&][^=&#\s]+=)([^&#\s]*)/g, (_m, key, v) => key + privateValue(v))
    .replace(/#.*$/, `#${HIDDEN}`)
    .replace(/\/([^/?#]+)/g, (m, segment) => looksLikeSecret(segment) ? `/${HIDDEN}` : m);
}

// Shape-based masking supplements known-value replacement. In particular, ALL
// literal env/header values and command arguments are private regardless of shape.
export function redactConfig(value, pairs = []) {
  const input = redactKnown(value, [...pairs].sort((a, b) => (b[1]?.length || 0) - (a[1]?.length || 0)));
  function walk(v, key = '') {
    if (Array.isArray(v)) return ['args','command'].includes(key) ? v.map(privateValue) : v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      if (['env', 'environment', 'headers', 'http_headers'].includes(key)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, privateValue(x)]));
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (typeof v !== 'string') return v;
    if (['url','serverUrl'].includes(key)) return redactUrl(v);
    if (/(?:token|password|secret|credential|authorization|api[_-]?key)/i.test(key) && !key.endsWith('_env_var')) return privateValue(v);
    return looksLikeSecret(v) ? privateValue(v) : v;
  }
  return walk(input);
}

// Permission decisions cannot rely only on token length/prefix heuristics: a short
// header or environment value is still potentially a password.
export function containsSensitiveLiteral(value, key = '') {
  if (Array.isArray(value)) return ['args','command'].includes(key) ? value.some((v) => !reference(v)) : value.some((v) => containsSensitiveLiteral(v));
  if (value && typeof value === 'object') {
    if (['env', 'environment', 'headers', 'http_headers'].includes(key)) return Object.values(value).some((v) => !reference(v));
    return Object.entries(value).some(([k, v]) => containsSensitiveLiteral(v, k));
  }
  if (typeof value !== 'string' || reference(value)) return false;
  if (['url','serverUrl'].includes(key) && redactUrl(value) !== value) return true;
  return (/(?:token|password|secret|credential|authorization|api[_-]?key)/i.test(key) && !key.endsWith('_env_var')) || looksLikeSecret(value);
}

// stderr and error.message are arbitrary subprocess output: either may echo argv,
// transformed secrets, or full config files. Report only structured process metadata.
export function processFailure(command, error) {
  const kind = error.code === 'ETIMEDOUT' ? 'timed out' : error.code === 'ENOENT' ? 'not found' : `exited ${error.status ?? error.signal ?? 'abnormally'}`;
  return `${command} ${kind}`;
}
