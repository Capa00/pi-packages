import { findEndpoint, resolveContact, resolveRecipientEndpoint } from "./directory.mjs";

/** Controlla i permessi, non prova l'intento dell'utente: il servizio dovrà verificarlo separatamente. */
export function authorizeRequestedSend(directory, sender, recipientQuery, requestedChannel) {
  const actor = findEndpoint(directory, sender);
  if (!actor?.endpoint.permissions.canInteractWithPi || !actor.endpoint.permissions.canRequestSendMessages) {
    throw new Error("Invio non autorizzato per il mittente");
  }
  const contact = resolveContact(directory, recipientQuery);
  const endpoint = resolveRecipientEndpoint(contact, requestedChannel);
  if (!endpoint.permissions.canReceiveMessages) throw new Error("Destinatario non autorizzato a ricevere messaggi");
  return { contact, endpoint };
}
