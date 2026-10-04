export class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Telegram: richiesta fallita (${Number.isInteger(code) ? code : "rete"})`);
    this.code = code;
    this.retryAfter = Math.min(Math.max(Number(retryAfter) || 0, 0), 300);
    this.retryable = code === undefined || code === 429 || code >= 500;
  }
}

/** Non propaga URL, token, descrizioni del provider o errori fetch nei log. */
export class TelegramApi {
  #token;
  #fetch;
  constructor(token, fetchImpl = globalThis.fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async call(method, body, signal) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    let response;
    let data;
    try {
      response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), signal: combined,
      });
      data = await response.json();
    } catch {
      if (signal?.aborted) throw new Error("Operazione annullata");
      throw new TelegramError();
    }
    if (!response.ok || data?.ok !== true) {
      throw new TelegramError(data?.error_code ?? response.status, data?.parameters?.retry_after);
    }
    return data.result;
  }

  getUpdates(offset, signal) {
    return this.call("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"] }, signal);
  }

  sendTyping(chatId, signal) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" }, signal);
  }

  answerCallback(queryId, text, signal) {
    return this.call("answerCallbackQuery", { callback_query_id: queryId, text }, signal);
  }

  removeButtons(chatId, messageId, signal) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, signal);
  }

  async sendText(chatId, text, signal, replyMarkup) {
    const ids = [];
    const parts = splitText(text);
    for (let index = 0; index < parts.length; index++) {
      const body = { chat_id: chatId, text: parts[index] };
      if (replyMarkup && index === parts.length - 1) body.reply_markup = replyMarkup;
      const result = await this.call("sendMessage", body, signal);
      ids.push(result.message_id);
    }
    return ids;
  }
}

/** Testo semplice: niente interpretazione Markdown/HTML e niente surrogate spezzate. */
export function splitText(text, limit = 4000) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Risposta vuota");
  if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new Error("Limite messaggio non valido");
  const parts = [];
  let part = "";
  for (const character of text) {
    if (part.length + character.length > limit) { parts.push(part); part = ""; }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}
