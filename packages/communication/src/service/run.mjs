import { setTimeout as delay } from "node:timers/promises";
import { TelegramApi, TelegramError } from "../channels/telegram/api.mjs";
import { PiSessions, loadSdk } from "./sessions.mjs";
import { MessageRouter } from "./router.mjs";
import { prepareState } from "./state.mjs";
import { OutboundStore } from "./outbound-store.mjs";

export async function runService(config, { signal, log = console.log, sdk, telegram } = {}) {
  // Import e configurazione prima del lock o di chiamate Telegram.
  const runtime = sdk ?? await loadSdk(config);
  const state = await prepareState(config.sessionsDirectory);
  let sessions;
  const abortSessions = () => { void sessions?.close(); };
  try {
    const api = telegram ?? new TelegramApi(config.telegram.botToken);
    sessions = new PiSessions(config, runtime, api, { outboundStore: new OutboundStore(config.sessionsDirectory) });
    const router = new MessageRouter({ directory: config.directory, sessions, telegram: api, log });
    signal?.addEventListener("abort", abortSessions, { once: true });
    let offset = await state.readOffset();
    log("Servizio Telegram avviato: chat private, solo utenti autorizzati. Ctrl+C per arrestare.");
    while (!signal?.aborted) {
      let updates;
      try { updates = await api.getUpdates(offset, signal); }
      catch (error) {
        if (signal?.aborted) break;
        if (!(error instanceof TelegramError) || !error.retryable) {
          throw new Error("Ricezione Telegram fallita: verificare token, webhook e altre istanze del bot");
        }
        log("Ricezione Telegram temporaneamente non disponibile; nuovo tentativo.");
        try { await delay(Math.max(error.retryAfter, 3) * 1000, undefined, { signal }); }
        catch { if (!signal?.aborted) throw new Error("Attesa Telegram fallita"); }
        continue;
      }
      if (!Array.isArray(updates)) throw new Error("Risposta Telegram non valida");
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Error("Update Telegram non valido");
      }
      // I messaggi dello stesso contatto sono serializzati dal router.
      const results = await Promise.allSettled(updates.filter((update) => update.update_id >= offset).map((update) => router.handle(update, signal)));
      if (signal?.aborted) break;
      if (sessions.outboundFailed) throw new Error("Stato outbound non salvato; servizio arrestato, verificare prima di riavviare");
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Invio risposta Telegram fallito; servizio arrestato. Verificare prima di riavviare: possibili replay.");
      }
      if (updates.length) {
        offset = Math.max(offset, ...updates.map((update) => update.update_id + 1));
        await state.writeOffset(offset);
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortSessions);
    try { await sessions?.close(); } finally { await state.close(); }
    log("Servizio Telegram arrestato.");
  }
}
