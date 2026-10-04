import { keys, text } from "../config/validation.mjs";

export const CHANNELS = ["telegram", "whatsapp", "slack", "discord"];
export const PERMISSIONS = ["canInteractWithPi", "canReceiveMessages", "canRequestSendMessages"];

function channel(value) {
  if (!CHANNELS.includes(value)) throw new Error("Rubrica: canale non supportato");
  return value;
}

function normalize(value) {
  return value.normalize("NFKC").toLowerCase();
}

/** Restituisce una copia validata; i permessi mancanti sono sempre false. */
export function validateDirectory(data) {
  keys(data, ["version", "contacts"], "Rubrica");
  if (data.version !== 1 || !Array.isArray(data.contacts)) throw new Error("Rubrica: formato non valido");
  const ids = new Set();
  const addresses = new Set();
  const contacts = data.contacts.map((entry) => {
    keys(entry, ["id", "name", "aliases", "endpoints", "preferredChannel"], "Contatto");
    const id = text(entry.id, "ID contatto");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ids.has(id)) throw new Error("Rubrica: ID non valido o duplicato");
    ids.add(id);
    const name = text(entry.name, "Nome contatto");
    if (!Array.isArray(entry.aliases) || !Array.isArray(entry.endpoints)) throw new Error("Contatto: liste richieste");
    const aliases = entry.aliases.map((alias) => text(alias, "Alias"));
    const endpoints = entry.endpoints.map((endpoint) => {
      keys(endpoint, ["channel", "address", "scope", "permissions"], "Recapito");
      const type = channel(endpoint.channel);
      const address = text(endpoint.address, "Indirizzo recapito");
      const scope = endpoint.scope === undefined ? undefined : text(endpoint.scope, "Scope");
      if (type === "telegram" && (!/^[1-9][0-9]*$/.test(address) || scope !== undefined)) {
        throw new Error("Telegram: richiesto ID utente numerico positivo, senza scope");
      }
      const identity = JSON.stringify([type, scope ?? null, address]);
      if (addresses.has(identity)) throw new Error("Rubrica: recapito duplicato");
      addresses.add(identity);
      const grants = endpoint.permissions ?? {};
      keys(grants, PERMISSIONS, "Permessi");
      const permissions = {};
      for (const permission of PERMISSIONS) {
        if (grants[permission] !== undefined && typeof grants[permission] !== "boolean") {
          throw new Error("Permessi: valore booleano richiesto");
        }
        permissions[permission] = grants[permission] === true;
      }
      return { channel: type, address, ...(scope === undefined ? {} : { scope }), permissions };
    });
    const preferredChannel = entry.preferredChannel === undefined ? undefined : channel(entry.preferredChannel);
    if (preferredChannel && !endpoints.some((endpoint) => endpoint.channel === preferredChannel)) {
      throw new Error("Contatto: canale preferito senza recapito");
    }
    return { id, name, aliases, endpoints, ...(preferredChannel ? { preferredChannel } : {}) };
  });
  return { version: 1, contacts };
}

export function findEndpoint(directory, { channel, address, scope }) {
  for (const contact of directory.contacts) {
    const endpoint = contact.endpoints.find((item) => item.channel === channel && item.address === address && item.scope === scope);
    if (endpoint) return { contact, endpoint };
  }
  return undefined;
}

/** L'ID esatto ha precedenza; nomi e alias ambigui richiedono chiarimenti. */
export function resolveContact(directory, query) {
  text(query, "Destinatario");
  const byId = directory.contacts.find((contact) => contact.id === query);
  if (byId) return byId;
  const matches = directory.contacts.filter((contact) => [contact.name, ...contact.aliases].some((name) => normalize(name) === normalize(query)));
  if (matches.length !== 1) throw new Error(matches.length ? "Destinatario ambiguo: chiedere chiarimenti" : "Destinatario non trovato");
  return matches[0];
}

/** Non sceglie silenziosamente tra più recapiti dello stesso canale. */
export function resolveRecipientEndpoint(contact, requestedChannel) {
  const selected = requestedChannel ?? contact.preferredChannel;
  const matches = contact.endpoints.filter((endpoint) => !selected || endpoint.channel === selected);
  if (matches.length !== 1) throw new Error("Recapito assente o ambiguo: chiedere chiarimenti");
  return matches[0];
}
