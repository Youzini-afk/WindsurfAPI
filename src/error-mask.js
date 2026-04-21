import { config } from './config.js';

export const GENERIC_ERROR_MESSAGE = '未知错误';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function maskErrorMessage(message, fallback = GENERIC_ERROR_MESSAGE) {
  const text = typeof message === 'string' && message.trim() ? message : fallback;
  if (!config.maskAllErrorMessages) return text;
  return GENERIC_ERROR_MESSAGE;
}

function maskValue(value, errorContext = false) {
  if (Array.isArray(value)) {
    return value.map(item => maskValue(item, errorContext));
  }
  if (!isPlainObject(value)) {
    if (errorContext && typeof value === 'string') return maskErrorMessage(value);
    return value;
  }

  const out = {};
  const objectIsErrorContext = errorContext
    || value.type === 'error'
    || value.status === 'error'
    || value.ok === false
    || value.success === false;

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'error') {
      out[key] = typeof entry === 'string'
        ? maskErrorMessage(entry)
        : maskValue(entry, true);
      continue;
    }
    if (key === 'errors') {
      out[key] = maskValue(entry, true);
      continue;
    }
    if (key === 'message' && objectIsErrorContext) {
      out[key] = maskErrorMessage(entry);
      continue;
    }
    out[key] = maskValue(entry, false);
  }

  return out;
}

export function maskErrorPayload(body) {
  if (!config.maskAllErrorMessages) return body;
  return maskValue(body, false);
}
