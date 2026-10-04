import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelegramApi, TelegramError, splitText } from "../src/channels/telegram/api.mjs";
import { MessageRouter } from "../src/service/router.mjs";
import { PiSessions, loadSdk } from "../src/service/sessions.mjs";
import { prepareState } from "../src/service/state.mjs";
import { runService } from "../src/service/run.mjs";
import { validateDirectory } from "../src/contacts/directory.mjs";

const grants = { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true };
const directory = validateDirectory({ version: 1, contacts: [
  { id: "alice", name: "Alice", aliases: [], endpoints: [{ channel: "telegram", address: "123", permissions: grants }] },
  { id: "bob", name: "Bob", aliases: [], endpoints: [{ channel: "telegram", address: "456", permissions: grants }] },
] });
function update(id = 123, text = "ciao", updateId = 1) {
  return { update_id: updateId, message: { chat: { id, type: "private" }, from: { id, is_bot: false }, text } };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-telegram-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function fakeSdk(replies = []) {
  const sessions = [];
  const created = [];
  const managers = [];
  const resources = [];
  return {
    sessions, created, managers, resources,
    Type: {
      Object: (properties, options) => ({ type: "object", properties, ...options }),
      String: (options) => ({ type: "string", ...options }),
      Literal: (value) => ({ const: value }), Union: (values) => ({ anyOf: values }), Optional: (schema) => schema,
    },
    DefaultResourceLoader: class {
      constructor(options) { resources.push(options); }
      async reload() {}
    },
    SessionManager: { continueRecent(cwd, directory) { managers.push({ cwd, directory }); return { cwd, directory }; } },
    SettingsManager: {
      create() { return { getGlobalSettings() { return { packages: ["npm:example"], defaultModel: "test-model" }; } }; },
      inMemory(settings) { return { getSettings() { return settings; } }; },
    },
    async createAgentSession(options) {
      created.push(options);
      const session = {
        async prompt(text) { replies.push(text); },
        getLastAssistantText() { return "Risposta pi"; },
        async abort() {}, dispose() {},
      };
      sessions.push(session);
      return { session };
    },
  };
}

function harness(reply = async (_id, text) => `risposta:${text}`) {
  const sent = []; const prompts = []; const logs = []; const typing = [];
  const router = new MessageRouter({ directory,
    sessions: { async reply(id, text) { prompts.push({ id, text }); return reply(id, text); } },
    telegram: {
      async sendText(chat, text) { sent.push({ chat, text }); },
      async sendTyping(chat) { typing.push(chat); },
    },
    log: (message) => logs.push(message),
  });
  return { router, sent, prompts, logs, typing };
}

test("ignora utenti sconosciuti, gruppi, bot e chat con identità incoerente", async () => {
  const h = harness();
  const group = update(); group.message.chat.type = "group";
  const bot = update(); bot.message.from.is_bot = true;
  const mismatch = update(); mismatch.message.chat.id = 456;
  for (const item of [update(999), group, bot, mismatch, { edited_message: update().message }]) await h.router.handle(item);
  assert.equal(h.prompts.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.typing.length, 0);
});

test("risponde nella stessa chat solo agli autorizzati", async () => {
  const h = harness(); await h.router.handle(update());
  assert.deepEqual(h.prompts, [{ id: "alice", text: "ciao" }]);
  assert.deepEqual(h.sent, [{ chat: 123, text: "risposta:ciao" }]);
  assert.deepEqual(h.typing, [123]);
});

test("start e media producono risposte locali senza chiamare pi", async () => {
  const h = harness();
  await h.router.handle(update(123, "/start"));
  const media = update(); delete media.message.text; await h.router.handle(media);
  assert.equal(h.prompts.length, 0);
  assert.match(h.sent[0].text, /autorizzato/);
  assert.match(h.sent.at(-1).text, /testo/);
  assert.equal(h.typing.length, 0);
});

test("messaggi dello stesso utente sono serializzati; utenti diversi restano indipendenti", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness(async (_id, text) => { if (text === "primo") await wait; return text; });
  const first = h.router.handle(update(123, "primo"));
  const second = h.router.handle(update(123, "secondo"));
  await h.router.handle(update(456, "altro"));
  assert.deepEqual(h.prompts.map((item) => item.text), ["primo", "altro"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(h.prompts.map((item) => item.text), ["primo", "altro", "secondo"]);
});

test("errori pi non espongono dettagli e non bloccano la coda successiva", async () => {
  const h = harness(async () => { throw new Error("SECRET_TOKEN"); });
  await h.router.handle(update()); await h.router.handle(update());
  assert.equal(h.prompts.length, 2);
  assert.ok(!JSON.stringify([h.sent, h.logs]).includes("SECRET_TOKEN"));
});

test("richiede anche il permesso di ricezione per rispondere", async () => {
  const restricted = structuredClone(directory); restricted.contacts[0].endpoints[0].permissions.canReceiveMessages = false;
  const router = new MessageRouter({ directory: restricted, sessions: { reply() { assert.fail(); } }, telegram: { sendText() { assert.fail(); } } });
  await router.handle(update());
});

test("divisione delle risposte rispetta limiti e Unicode", () => {
  const text = "a".repeat(3999) + "😀" + "b".repeat(4100);
  const parts = splitText(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.length <= 4000 && !/[\uD800-\uDBFF]$/.test(part)));
  assert.throws(() => splitText(""), /vuota/);
});

test("Telegram usa POST, polling lungo e testo senza parse_mode", async () => {
  const calls = [];
  const api = new TelegramApi("123:SECRET", async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 10 } }) };
  });
  await api.getUpdates(20); await api.sendText(123, "testo");
  assert.equal(calls[0].offset, 20); assert.equal(calls[0].timeout, 30);
  assert.equal(calls[1].chat_id, 123); assert.equal(calls[1].parse_mode, undefined);
});

test("errori Telegram sanitizzati e classificati senza token", async () => {
  const api = new TelegramApi("123:SECRET", async () => { throw new Error("https://api.telegram.org/bot123:SECRET"); });
  await assert.rejects(api.getUpdates(0), (error) => error instanceof TelegramError && error.retryable && !error.message.includes("SECRET"));
  const denied = new TelegramApi("123:SECRET", async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: "SECRET" }) }));
  await assert.rejects(denied.getUpdates(0), (error) => !error.retryable && !error.message.includes("SECRET"));
});

test("SDK mantiene una sessione per contatto, directory distinte e strumenti disabilitati", async (t) => {
  const sessionsDirectory = await temporary(t); const sdk = fakeSdk();
  const config = { sessionsDirectory, pi: { workingDirectory: sessionsDirectory, agentDirectory: sessionsDirectory } };
  const sessions = new PiSessions(config, sdk);
  await sessions.reply("alice", "uno"); await sessions.reply("alice", "due"); await sessions.reply("bob", "tre");
  assert.equal(sdk.created.length, 2);
  assert.notEqual(sdk.managers[0].directory, sdk.managers[1].directory);
  assert.deepEqual(sdk.created[0].tools, []); assert.equal(sdk.created[0].noTools, "all");
  assert.equal(sdk.resources[0].noExtensions, true);
  assert.deepEqual(sdk.created[0].settingsManager.getSettings().packages, []);
  assert.equal(sdk.created[0].settingsManager.getSettings().defaultModel, "test-model");
  await sessions.close(); await assert.rejects(sessions.reply("alice", "quattro"), /chiuse/);
});

test("SDK mancante non causa fallback a percorsi globali impliciti", async () => {
  await assert.rejects(loadSdk({}), /Configurazione pi mancante/);
  await assert.rejects(loadSdk({ pi: { sdkModule: "/missing/sdk.js" } }), /SDK pi non accessibile/);
});

test("offset persistente e lock impediscono due servizi sulla stessa directory", async (t) => {
  const directory = await temporary(t);
  const state = await prepareState(directory);
  assert.equal(await state.readOffset(), 0);
  await assert.rejects(prepareState(directory), /già attivo/);
  await state.writeOffset(42); await state.close();
  const reopened = await prepareState(directory);
  assert.equal(await reopened.readOffset(), 42); await reopened.close();
});

test("ciclo completo con SDK e Telegram simulati: risposta, checkpoint e ripresa", async (t) => {
  const sessionsDirectory = await temporary(t); const sdk = fakeSdk(); const controller = new AbortController(); const sent = [];
  const config = { sessionsDirectory, pi: { workingDirectory: sessionsDirectory, agentDirectory: sessionsDirectory }, telegram: { botToken: "123:TEST" }, directory };
  let polls = 0;
  await runService(config, { signal: controller.signal, sdk, log() {}, telegram: {
    async getUpdates(offset) {
      if (polls++ === 0) { assert.equal(offset, 0); return [update(123, "ciao", 7), update(999, "ignorato", 8)]; }
      assert.equal(offset, 9); controller.abort(); return [];
    },
    async sendText(id, text) { sent.push({ id, text }); },
    async sendTyping() {},
  } });
  assert.deepEqual(sent, [{ id: 123, text: "Risposta pi" }]);
  assert.equal(JSON.parse(await readFile(join(sessionsDirectory, "telegram-offset.json"), "utf8")).offset, 9);
  const next = new AbortController();
  await runService(config, { signal: next.signal, sdk: fakeSdk(), log() {}, telegram: {
    async getUpdates(offset) { assert.equal(offset, 9); next.abort(); return []; }, sendText() { assert.fail(); },
  } });
});
