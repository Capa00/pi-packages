import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MessageRouter } from "../src/service/router.mjs";
import { TelegramApi } from "../src/channels/telegram/api.mjs";
import { validateDirectory } from "../src/contacts/directory.mjs";

function fixture() {
  const directory = validateDirectory({ version: 1, contacts: [123, 456].map((address) => ({
    id: `user-${address}`, name: `User ${address}`, aliases: [], endpoints: [{ channel: "telegram", address: String(address),
      permissions: { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true } }],
  })) });
  let draft; let counter = 0; let replies = 0;
  const sent = []; const answers = []; const removed = []; const deliveries = []; const cancellations = [];
  const sessions = {
    async reply() { replies++; draft = { deliveryId: randomUUID(), recipientId: "user-456", recipientName: "User 456", channel: "telegram", text: "Prova" }; return "Proposta preparata"; },
    pendingFor(sender) { return draft && sender.address === "123" ? [draft] : []; },
    async confirmSend(sender, id) { assert.equal(sender.address, "123"); assert.equal(id, draft.deliveryId); deliveries.push(id); draft = undefined; return { to: { name: "User 456" }, contextRecorded: true }; },
    cancelSend(sender, id) { assert.equal(sender.address, "123"); assert.equal(id, draft.deliveryId); cancellations.push(id); draft = undefined; },
  };
  const telegram = {
    async sendTyping() {},
    async sendText(chat, text, _signal, markup) { const id = ++counter; sent.push({ chat, text, markup, id }); return [id]; },
    async answerCallback(id, text) { answers.push({ id, text }); },
    async removeButtons(chat, message) { removed.push({ chat, message }); },
  };
  const router = new MessageRouter({ directory, sessions, telegram });
  const prepare = () => router.handle({ message: { from: { id: 123 }, chat: { id: 123, type: "private" }, text: "manda" } });
  const preview = () => sent.filter((message) => message.markup).at(-1);
  const callback = (action = "Conferma", from = 123, item = preview()) => ({ callback_query: {
    id: randomUUID(), from: { id: from }, message: { chat: { id: from, type: "private" }, message_id: item.id },
    data: item.markup.inline_keyboard[0].find((button) => button.text === action).callback_data,
  } });
  return { router, prepare, preview, callback, sent, answers, removed, deliveries, cancellations, telegram, sessions, expire: () => { draft = undefined; }, replies: () => replies };
}

test("anteprima con bottoni, senza ID visibile; click conferma senza modello", async () => {
  const f = fixture(); await f.prepare();
  const item = f.preview();
  assert.equal(f.sent.length, 1);
  assert.equal(item.text, "A User 456\n\nProva");
  assert.deepEqual(item.markup.inline_keyboard[0].map((button) => button.text), ["Conferma", "Annulla"]);
  assert.ok(!item.text.includes("/conferma"));
  assert.ok(item.markup.inline_keyboard[0].every((button) => Buffer.byteLength(button.callback_data) <= 64));
  await f.router.handle(f.callback());
  assert.equal(f.deliveries.length, 1); assert.equal(f.replies(), 1);
  assert.equal(f.answers.length, 1); assert.ok(f.removed.some((entry) => entry.message === item.id));
});

test("conversazione normale non ripete una proposta già mostrata", async () => {
  const f = fixture(); await f.prepare();
  f.sessions.reply = async () => "Risposta normale";
  await f.prepare();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].text, "Risposta normale");
  assert.equal(f.sent[1].markup, undefined);
  assert.equal(f.removed.length, 0);
});

test("annulla rimuove bottoni e non consegna", async () => {
  const f = fixture(); await f.prepare(); await f.router.handle(f.callback("Annulla"));
  assert.equal(f.cancellations.length, 1); assert.equal(f.deliveries.length, 0);
});

test("click duplicati sono serializzati e non duplicano consegne", async () => {
  const f = fixture(); await f.prepare(); const query = f.callback();
  await Promise.all([f.router.handle(query), f.router.handle(query)]);
  assert.equal(f.deliveries.length, 1);
});

test("proposte scadute, sostituite e messaggi differenti non autorizzano invii", async () => {
  const f = fixture(); await f.prepare(); const old = f.callback();
  await f.prepare(); await f.router.handle(old);
  const wrongMessage = f.callback(); wrongMessage.callback_query.message.message_id += 100;
  await f.router.handle(wrongMessage);
  f.expire(); await f.router.handle(f.callback());
  assert.equal(f.deliveries.length, 0);
});

test("callback di altri utenti, gruppi e sconosciuti escluse", async () => {
  const f = fixture(); await f.prepare();
  await f.router.handle(f.callback("Conferma", 456));
  await f.router.handle(f.callback("Conferma", 999));
  const group = f.callback(); group.callback_query.message.chat.type = "group";
  await f.router.handle(group);
  assert.equal(f.deliveries.length, 0); assert.equal(f.answers.length, 3);
});

test("errori UI non impediscono consegna confermata", async () => {
  const f = fixture(); await f.prepare();
  f.telegram.answerCallback = async () => { throw new Error("rete"); };
  f.telegram.removeButtons = async () => { throw new Error("rete"); };
  await f.router.handle(f.callback());
  assert.equal(f.deliveries.length, 1);
});

test("API riceve callback e mette la tastiera solo sull'ultimo frammento", async () => {
  const requests = [];
  const api = new TelegramApi("123:TEST", async (url, options) => {
    requests.push({ method: url.split("/").at(-1), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: requests.length } }) };
  });
  await api.getUpdates(0);
  const markup = { inline_keyboard: [[{ text: "Conferma", callback_data: "test" }]] };
  await api.sendText(123, "a".repeat(4100), undefined, markup);
  await api.answerCallback("query", "Ricevuto"); await api.removeButtons(123, 3);
  assert.ok(requests[0].body.allowed_updates.includes("callback_query"));
  assert.equal(requests[1].body.reply_markup, undefined);
  assert.deepEqual(requests[2].body.reply_markup, markup);
  assert.equal(requests[3].method, "answerCallbackQuery");
  assert.deepEqual(requests[4].body.reply_markup, { inline_keyboard: [] });
});
