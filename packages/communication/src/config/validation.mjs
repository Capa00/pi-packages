export function validateProfileName(value) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value !== value.trim() || value.length > 80 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    throw new Error("Profile name: use at most 80 characters without surrounding spaces or control characters.");
  }
  return value;
}

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
