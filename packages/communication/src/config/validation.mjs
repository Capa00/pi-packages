export function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: oggetto richiesto`);
  }
  return value;
}

export function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label}: campo non riconosciuto`);
  }
}

export function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${label}: stringa non vuota senza spazi ai bordi richiesta`);
  }
  return value;
}
