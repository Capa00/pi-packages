import { findEndpoint } from "../contacts/directory.mjs";
import { startTyping } from "../channels/telegram/typing.mjs";
import { formatPreview } from "./outbound.mjs";

export class MessageRouter {
  #directory;
  #sessions;
  #telegram;
  #log;
  #queues = new Map();
  #previews = new Map();
  constructor({ directory, sessions, telegram, log = () => {} }) {
    this.#directory = directory; this.#sessions = sessions; this.#telegram = telegram; this.#log = log;
  }

  #identify(from, chat) {
    if (chat?.type !== "private" || from?.is_bot || !Number.isSafeInteger(from?.id) || chat.id !== from.id) return undefined;
    const sender = { channel: "telegram", address: String(from.id) };
    const found = findEndpoint(this.#directory, sender);
    if (!found?.endpoint.permissions.canInteractWithPi || !found.endpoint.permissions.canReceiveMessages) return undefined;
    return { id: found.contact.id, sender };
  }

  handle(update, signal) {
    if (update?.callback_query) return this.#handleCallback(update.callback_query, signal);
    const message = update?.message;
    if (!message) return Promise.resolve();
    const actor = this.#identify(message.from, message.chat);
    if (!actor) return Promise.resolve();
    return this.#enqueue(actor.id, () => this.#process(actor, message, signal));
  }

  #enqueue(id, action) {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    this.#queues.set(id, pending);
    pending.then(() => this.#cleanup(id, pending), () => this.#cleanup(id, pending));
    return pending;
  }

  #cleanup(id, pending) { if (this.#queues.get(id) === pending) this.#queues.delete(id); }

  async #bestEffort(action) { try { await action(); } catch { /* UI non critica: non bloccare consegne o polling. */ } }

  async #retire(id, deliveryId, signal) {
    const preview = this.#previews.get(id) ?? this.#sessions.previewForContact?.(id);
    if (!preview || (deliveryId && preview.deliveryId !== deliveryId)) return;
    this.#previews.delete(id);
    await this.#bestEffort(() => this.#telegram.removeButtons(preview.chatId, preview.messageId, signal));
  }

  async #showPreview(id, sender, chatId, draft, signal) {
    await this.#retire(id, undefined, signal);
    const markup = { inline_keyboard: [[
      { text: "Conferma", callback_data: `out:conferma:${draft.deliveryId}` },
      { text: "Annulla", callback_data: `out:annulla:${draft.deliveryId}` },
    ]] };
    const ids = await this.#telegram.sendText(chatId, formatPreview(draft), signal, markup);
    const binding = { deliveryId: draft.deliveryId, chatId, messageId: ids.at(-1) };
    this.#sessions.bindPreview?.(sender, draft.deliveryId, binding);
    this.#previews.set(id, binding);
  }

  async #handleCallback(query, signal) {
    if (typeof query.id !== "string" || !query.id) return;
    const actor = this.#identify(query.from, query.message?.chat);
    const command = typeof query.data === "string" ? query.data.match(/^out:(conferma|annulla):([0-9a-f-]{36})$/) : undefined;
    if (!actor || !command || !Number.isSafeInteger(query.message?.message_id)) {
      await this.#bestEffort(() => this.#telegram.answerCallback(query.id, "Azione non disponibile.", signal));
      return;
    }
    // Chiudi subito lo spinner, anche se c'è una risposta pi in corso nella stessa chat.
    const acknowledgment = this.#bestEffort(() => this.#telegram.answerCallback(query.id, "Richiesta ricevuta.", signal));
    return this.#enqueue(actor.id, async () => {
      await acknowledgment;
      if (signal?.aborted) return;
      const preview = this.#previews.get(actor.id) ?? this.#sessions.previewForContact?.(actor.id);
      const pending = this.#sessions.pendingFor(actor.sender);
      if (!preview || preview.deliveryId !== command[2] || preview.chatId !== query.message.chat.id ||
          preview.messageId !== query.message.message_id || !pending.some((draft) => draft.deliveryId === command[2])) {
        // La chat è quella del richiedente autorizzato, mai quella di un altro utente.
        await this.#bestEffort(() => this.#telegram.removeButtons(query.message.chat.id, query.message.message_id, signal));
        await this.#telegram.sendText(query.message.chat.id, "Questa proposta non è più disponibile: è scaduta, sostituita o già gestita.", signal);
        return;
      }
      await this.#retire(actor.id, command[2], signal);
      const result = await this.#performAction(actor.sender, command[1], command[2], signal);
      if (!signal?.aborted) await this.#telegram.sendText(query.message.chat.id, result, signal);
    });
  }

  async #performAction(sender, action, deliveryId, signal) {
    try {
      if (action === "annulla") {
        await this.#sessions.cancelSend(sender, deliveryId);
        return "Proposta annullata. Nessun messaggio inviato.";
      }
      const result = await this.#sessions.confirmSend(sender, deliveryId, signal);
      let text = `Messaggio consegnato a ${result.to.name}.`;
      if (!result.contextRecorded) text += " Attenzione: Telegram ha confermato l'invio, ma la registrazione nel contesto non è completa. Non inviare di nuovo.";
      if (result.journalRecorded === false) text += " Il registro persistente non è stato aggiornato: non inviare di nuovo.";
      return text;
    } catch {
      return "Invio non completato o proposta non valida/scaduta. Se è un errore di consegna, verifica Telegram prima di riprovare: l'esito potrebbe essere incerto.";
    }
  }

  async #process({ id, sender }, message, signal) {
    if (signal?.aborted) return;
    const text = message.text;
    if (typeof text !== "string" || !text.trim()) {
      await this.#telegram.sendText(message.chat.id, "Per ora posso ricevere soltanto messaggi di testo.", signal);
      return;
    }
    if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)) {
      await this.#telegram.sendText(message.chat.id, "Sei autorizzato. Scrivimi un messaggio per parlare con pi.", signal);
      return;
    }
    if (/^\/sends(?:@[A-Za-z0-9_]+)?\s*$/.test(text)) {
      const drafts = this.#sessions.pendingFor?.(sender) ?? [];
      const recent = this.#sessions.recentFor?.(sender) ?? [];
      for (const draft of drafts) await this.#showPreview(id, sender, message.chat.id, draft, signal);
      if (recent.length) {
        const statuses = recent.map((entry) => `To ${entry.recipientName}: ${entry.status === "delivered" ? "delivery confirmed" : entry.status === "sending" ? "send in progress" : "delivery uncertain; check Telegram before sending again"}.`);
        await this.#telegram.sendText(message.chat.id, statuses.join("\n"), signal);
      } else if (!drafts.length) await this.#telegram.sendText(message.chat.id, "No pending proposals or recent sends.", signal);
      return;
    }
    const command = text.match(/^\/(conferma|annulla)(?:@[A-Za-z0-9_]+)?\s+([0-9a-f-]{36})\s*$/);
    if (command) {
      if (message.forward_origin || message.via_bot) {
        await this.#telegram.sendText(message.chat.id, "La conferma deve essere scritta direttamente da te, non inoltrata.", signal);
        return;
      }
      await this.#retire(id, command[2], signal);
      const result = await this.#performAction(sender, command[1], command[2], signal);
      if (!signal?.aborted) await this.#telegram.sendText(message.chat.id, result, signal);
      return;
    }
    if (/^\/(conferma|annulla)(?:\s|$)/.test(text)) {
      await this.#telegram.sendText(message.chat.id, "Usa i bottoni Conferma e Annulla sotto l'anteprima del messaggio.", signal);
      return;
    }
    const existingProposals = new Set((this.#sessions.pendingFor?.(sender) ?? []).map((draft) => draft.deliveryId));
    let answer;
    const stopTyping = startTyping(this.#telegram, message.chat.id, signal);
    try { answer = await this.#sessions.reply(id, text, sender); }
    catch {
      if (signal?.aborted) return;
      this.#log("Errore durante l'elaborazione pi; dettagli omessi per proteggere i dati.");
      answer = "Non sono riuscito a elaborare il messaggio. Controlla la configurazione di pi e riprova.";
    } finally { stopTyping(); }
    if (!signal?.aborted) {
      const newProposals = (this.#sessions.pendingFor?.(sender) ?? []).filter((draft) => !existingProposals.has(draft.deliveryId));
      if (!newProposals.length) await this.#telegram.sendText(message.chat.id, answer, signal);
      for (const draft of newProposals) {
        await this.#showPreview(id, sender, message.chat.id, draft, signal);
      }
    }
  }
}
