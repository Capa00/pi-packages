import { randomUUID } from "node:crypto";
import { authorizeRequestedSend } from "../contacts/permissions.mjs";
import { findEndpoint } from "../contacts/directory.mjs";

const TTL = 10 * 60 * 1000;

/** Nessuna consegna senza conferma diretta; sending recuperato diventa incerto, mai ritentato. */
export class Outbound {
  #directory; #entries = new Map(); #deliver; #now; #store; #blocked = false;
  constructor(directory, deliver, now = Date.now, store) {
    this.#directory = directory; this.#deliver = deliver; this.#now = now; this.#store = store;
    let recovered = false;
    for (const entry of store?.load() ?? []) {
      if (entry.state === "sending") { entry.state = "delivery_unconfirmed"; entry.updatedAt = now(); recovered = true; }
      this.#entries.set(entry.draft.id, entry);
    }
    if (recovered) this.#persist();
    this.#prune();
  }
  get blocked() { return this.#blocked; }
  #assert() { if (this.#blocked) throw new Error("Stato outbound non disponibile; riavviare solo dopo verifica"); }
  #persist() {
    const terminal = [...this.#entries.values()].filter((e) => !["awaiting_confirmation", "sending"].includes(e.state)).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const entry of terminal.slice(100)) this.#entries.delete(entry.draft.id);
    try { this.#store?.save([...this.#entries.values()]); }
    catch (error) { this.#blocked = true; throw error; }
  }
  #prune() {
    this.#assert(); let changed = false;
    for (const entry of this.#entries.values()) {
      if (entry.state === "awaiting_confirmation" && entry.draft.expiresAt <= this.#now()) {
        entry.state = "expired"; entry.updatedAt = this.#now(); changed = true;
      }
    }
    if (changed) this.#persist();
  }
  #owns(draft, sender) {
    return draft.sender.channel === sender.channel && draft.sender.address === sender.address && draft.sender.scope === sender.scope;
  }
  #pending(sender, id) {
    this.#prune(); const entry = this.#entries.get(id);
    if (!entry || entry.state !== "awaiting_confirmation" || !this.#owns(entry.draft, sender)) throw new Error("Proposta assente, scaduta o non appartenente a questo utente");
    return entry;
  }
  prepare(sender, { recipient, text, channel }) {
    this.#prune();
    if (typeof text !== "string" || !text.trim() || text.length > 3000) throw new Error("Testo richiesto, massimo 3000 caratteri");
    const actor = findEndpoint(this.#directory, sender);
    const target = authorizeRequestedSend(this.#directory, sender, recipient, channel);
    if (target.endpoint.channel !== "telegram") throw new Error("Canale non ancora disponibile; per ora solo Telegram");
    if (actor.contact.name.length > 200) throw new Error("Nome mittente troppo lungo per la consegna Telegram");
    for (const entry of this.#entries.values()) if (entry.state === "awaiting_confirmation" && entry.draft.senderContactId === actor.contact.id) {
      entry.state = "superseded"; entry.updatedAt = this.#now();
    }
    const draft = {
      id: randomUUID(), sender: { ...sender }, senderContactId: actor.contact.id,
      senderName: actor.contact.name, recipientContactId: target.contact.id,
      recipientName: target.contact.name, endpoint: { ...target.endpoint }, text, expiresAt: this.#now() + TTL,
    };
    this.#entries.set(draft.id, { draft, state: "awaiting_confirmation", updatedAt: this.#now() });
    this.#persist();
    return this.preview(draft);
  }
  preview(draft) {
    return { deliveryId: draft.id, recipientId: draft.recipientContactId, recipientName: draft.recipientName,
      channel: draft.endpoint.channel, text: draft.text, expiresAt: draft.expiresAt, status: "awaiting_confirmation",
      confirmCommand: `/conferma ${draft.id}`, cancelCommand: `/annulla ${draft.id}` };
  }
  pendingFor(sender) {
    this.#prune();
    return [...this.#entries.values()].filter((e) => e.state === "awaiting_confirmation" && this.#owns(e.draft, sender)).map((e) => this.preview(e.draft));
  }
  recentFor(sender) {
    this.#prune();
    return [...this.#entries.values()].filter((e) => this.#owns(e.draft, sender) && ["delivered", "delivery_unconfirmed", "sending"].includes(e.state))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5).map((e) => ({ recipientName: e.draft.recipientName, status: e.state }));
  }
  bindPreview(sender, id, binding) {
    const entry = this.#pending(sender, id);
    if (binding.deliveryId !== id || String(binding.chatId) !== sender.address || !Number.isSafeInteger(binding.messageId) || binding.messageId <= 0) throw new Error("Anteprima non valida");
    entry.binding = { ...binding }; this.#persist();
  }
  previewForContact(id) {
    this.#prune();
    const entry = [...this.#entries.values()].find((e) => e.state === "awaiting_confirmation" && e.draft.senderContactId === id);
    return entry?.binding ? { ...entry.binding } : undefined;
  }
  cancel(sender, id) {
    const entry = this.#pending(sender, id);
    entry.state = "cancelled"; entry.updatedAt = this.#now(); this.#persist();
  }
  async confirm(sender, id, signal) {
    const entry = this.#pending(sender, id); const draft = entry.draft;
    const actor = findEndpoint(this.#directory, sender);
    const target = authorizeRequestedSend(this.#directory, sender, draft.recipientContactId, draft.endpoint.channel);
    if (actor.contact.id !== draft.senderContactId || target.endpoint.address !== draft.endpoint.address || target.endpoint.scope !== draft.endpoint.scope) throw new Error("Recapito cambiato; preparare una nuova proposta");
    if (actor.contact.name.length > 200) throw new Error("Nome mittente troppo lungo per la consegna Telegram");
    if (signal?.aborted) throw new Error("Invio annullato");
    draft.senderName = actor.contact.name; draft.recipientName = target.contact.name;
    entry.state = "sending"; entry.updatedAt = this.#now();
    // Commit prima della rete. Nessun callback/replay può tornare alla conferma.
    this.#persist();
    let result;
    try { result = await this.#deliver(draft, signal); }
    catch (error) {
      entry.state = "delivery_unconfirmed"; entry.updatedAt = this.#now();
      this.#persist(); throw error;
    }
    entry.state = "delivered"; entry.updatedAt = this.#now();
    if (result?.messageIds) entry.messageIds = result.messageIds;
    try { this.#persist(); }
    catch { return { ...result, journalRecorded: false }; }
    return result;
  }
}

export function formatPreview(preview) { return `A ${preview.recipientName}\n\n${preview.text}`; }
