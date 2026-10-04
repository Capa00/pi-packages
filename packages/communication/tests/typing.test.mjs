import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramApi } from "../src/channels/telegram/api.mjs";
import { startTyping } from "../src/channels/telegram/typing.mjs";

test("usa l'indicatore nativo sendChatAction typing", async () => {
  let request;
  const api = new TelegramApi("123:TEST", async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  });
  await api.sendTyping(123);
  assert.ok(request.url.endsWith("/sendChatAction"));
  assert.deepEqual(request.body, { chat_id: 123, action: "typing" });
});

test("typing immediato, rinnovo e interruzione alla fine", async (t) => {
  let calls = 0;
  const stop = startTyping({ async sendTyping() { calls++; } }, 123, undefined, 10);
  t.after(stop);
  assert.equal(calls, 1);
  await delay(40);
  assert.ok(calls >= 2);
  stop(); const atStop = calls;
  await delay(30);
  assert.equal(calls, atStop);
});

test("errore typing non si propaga e shutdown interrompe i rinnovi", async (t) => {
  let calls = 0;
  const controller = new AbortController();
  const stop = startTyping({ async sendTyping() { calls++; throw new Error("errore di rete"); } }, 123, controller.signal, 10);
  t.after(stop);
  await delay(30);
  controller.abort(); const atStop = calls;
  await delay(30);
  assert.equal(calls, atStop);
});

test("non sovrappone richieste e annulla quella in corso", async (t) => {
  let calls = 0; let activeSignal;
  const stop = startTyping({ sendTyping(_chat, signal) {
    calls++; activeSignal = signal;
    return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  } }, 123, undefined, 10);
  t.after(stop);
  await delay(35);
  assert.equal(calls, 1);
  stop(); assert.equal(activeSignal.aborted, true);
});

test("non invia typing se già annullato", () => {
  const controller = new AbortController(); controller.abort();
  const stop = startTyping({ sendTyping() { assert.fail(); } }, 123, controller.signal);
  stop();
});
