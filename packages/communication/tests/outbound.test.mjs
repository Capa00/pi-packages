import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Outbound } from "../src/service/outbound.mjs";
import { PiSessions } from "../src/service/sessions.mjs";
import { MessageRouter } from "../src/service/router.mjs";
import { validateDirectory } from "../src/contacts/directory.mjs";

const alice = { channel: "telegram", address: "123" };
const bob = { channel: "telegram", address: "456" };
function directory() {
  return validateDirectory({ version: 1, contacts: [
    { id: "alice", name: "Alice", aliases: ["Al"], endpoints: [{ ...alice, permissions: { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true } }] },
    { id: "bob", name: "Bob", aliases: [], endpoints: [{ ...bob, permissions: { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true } }] },
  ] });
}
const proposal = { recipient: "bob", text: "Ci vediamo alle 18" };

function mockSdk() {
  const sessions = new Map();
  const sdk = {
    Type: {
      Object: (properties, options) => ({ type: "object", properties, ...options }),
      String: (options) => ({ type: "string", ...options }), Literal: (value) => ({ const: value }),
      Union: (schemas) => ({ anyOf: schemas }), Optional: (schema) => schema,
    },
    DefaultResourceLoader: class { async reload() {} },
    SettingsManager: { create: () => ({ getGlobalSettings: () => ({}) }), inMemory: (settings) => settings },
    SessionManager: { continueRecent: (_cwd, directory) => ({ directory }) },
    async createAgentSession(options) {
      const session = {
        options, prompts: [], notes: [], active: false, response: "Proposta preparata",
        async prompt(text) {
          this.prompts.push(text); this.active = true;
          try { if (sdk.onPrompt) await sdk.onPrompt(this, text); } finally { this.active = false; }
        },
        getLastAssistantText() { return this.response; },
        async sendCustomMessage(message, options) { this.notes.push({ message, options, whileActive: this.active }); },
        async abort() {}, dispose() {},
      };
      sessions.set(options.sessionManager.directory.split("contact-").at(-1), session);
      return { session };
    },
    sessions,
  };
  return sdk;
}
async function fixture(t, sendText = async () => [10]) {
  const sessionsDirectory = await mkdtemp(join(tmpdir(), "pi-outbound-test-"));
  t.after(() => rm(sessionsDirectory, { recursive: true, force: true }));
  const config = { sessionsDirectory, directory: directory(), pi: { workingDirectory: sessionsDirectory, agentDirectory: sessionsDirectory } };
  const sdk = mockSdk();
  const sent = [];
  const telegram = {
    async sendTyping() {}, async answerCallback() {}, async removeButtons() {},
    async sendText(chat, text, signal, markup) { sent.push({ chat, text, ...(markup ? { markup } : {}) }); return sendText(chat, text, signal); },
  };
  const sessions = new PiSessions(config, sdk, telegram);
  t.after(() => sessions.close());
  sdk.onPrompt = async (session) => {
    const tool = session.options.customTools.find((tool) => tool.name === "communication_prepare_send");
    await tool.execute("tool-call", proposal);
  };
  return { config, sdk, sessions, telegram, sent };
}

test("preparazione non consegna; conferma del proprietario consegna una sola volta", async () => {
  const delivered = [];
  const outbound = new Outbound(directory(), async (draft) => { delivered.push(draft); return { status: "delivered" }; });
  const draft = outbound.prepare(alice, proposal);
  assert.equal(delivered.length, 0);
  await assert.rejects(outbound.confirm(bob, draft.deliveryId), /non appartenente/);
  await outbound.confirm(alice, draft.deliveryId);
  assert.equal(delivered.length, 1);
  await assert.rejects(outbound.confirm(alice, draft.deliveryId), /assente/);
});

test("scadenza, annullamento e sostituzione delle proposte", async () => {
  let now = 0;
  const outbound = new Outbound(directory(), async () => assert.fail(), () => now);
  const first = outbound.prepare(alice, proposal);
  const second = outbound.prepare(alice, { ...proposal, text: "Nuovo testo" });
  await assert.rejects(outbound.confirm(alice, first.deliveryId), /assente/);
  outbound.cancel(alice, second.deliveryId);
  assert.equal(outbound.pendingFor(alice).length, 0);
  const third = outbound.prepare(alice, proposal);
  now = 600001;
  await assert.rejects(outbound.confirm(alice, third.deliveryId), /scaduta/);
});

test("ricontrolla permessi prima di consegnare e rifiuta canali futuri", async () => {
  const data = directory();
  const outbound = new Outbound(data, async () => assert.fail());
  const draft = outbound.prepare(alice, proposal);
  data.contacts[1].endpoints[0].permissions.canReceiveMessages = false;
  await assert.rejects(outbound.confirm(alice, draft.deliveryId), /non autorizzato/);
  data.contacts[1].endpoints.push({ channel: "discord", address: "987", permissions: { canReceiveMessages: true } });
  assert.throws(() => outbound.prepare(alice, { ...proposal, channel: "discord" }), /non ancora disponibile/);
  data.contacts[0].endpoints[0].permissions.canRequestSendMessages = false;
  assert.throws(() => outbound.prepare(alice, proposal), /non autorizzato/);
});

test("destinatari ambigui e testi troppo lunghi non generano consegne", () => {
  const data = directory(); data.contacts[1].aliases = ["Al"];
  const outbound = new Outbound(data, async () => assert.fail());
  assert.throws(() => outbound.prepare(alice, { ...proposal, recipient: "Al" }), /ambiguo/);
  assert.throws(() => outbound.prepare(alice, { ...proposal, text: "a".repeat(3001) }), /3000/);
  assert.throws(() => outbound.prepare(alice, { ...proposal, text: " " }), /Testo/);
});

test("conferme simultanee non duplicano l'invio; errore non autorizza retry automatico", async () => {
  let calls = 0;
  const outbound = new Outbound(directory(), async () => { calls++; throw new Error("errore"); });
  const draft = outbound.prepare(alice, proposal);
  await Promise.allSettled([outbound.confirm(alice, draft.deliveryId), outbound.confirm(alice, draft.deliveryId)]);
  assert.equal(calls, 1);
  assert.equal(outbound.pendingFor(alice).length, 0);
});

test("sessione destinataria consegna senza modello e conserva solo messaggio e mittente", async (t) => {
  const f = await fixture(t);
  await f.sessions.reply("alice", "Manda a Bob: Ci vediamo alle 18", alice);
  const draft = f.sessions.pendingFor(alice)[0];
  assert.equal(f.sent.length, 0);
  const result = await f.sessions.confirmSend(alice, draft.deliveryId);
  assert.equal(result.status, "delivered"); assert.equal(result.contextRecorded, true);
  assert.deepEqual(f.sent, [{ chat: "456", text: "Alice ti manda questo messaggio:\n\nCi vediamo alle 18" }]);
  const recipient = f.sdk.sessions.get("bob");
  assert.deepEqual(recipient.prompts, []);
  assert.ok(recipient.notes.every((note) => note.options.triggerTurn === false));
  assert.equal(recipient.notes[1].message.details.status, "delivered");
  assert.equal(recipient.notes[1].message.details.from.id, "alice");
  assert.ok(!JSON.stringify(recipient.notes).includes("Manda a Bob:"));
  const origin = f.sdk.sessions.get("alice");
  assert.equal(origin.notes.at(-1).message.customType, "communication-outbound-result");
  await assert.rejects(f.sessions.confirmSend(alice, draft.deliveryId), /assente/);
});

test("invio a sé stessi non attiva turni aggiuntivi né crea deadlock", async (t) => {
  const f = await fixture(t);
  f.sdk.onPrompt = async (session) => session.options.customTools.find((tool) => tool.name === "communication_prepare_send").execute("call", { recipient: "alice", text: "Prova per me" });
  await f.sessions.reply("alice", "Inviami Prova per me", alice);
  const draft = f.sessions.pendingFor(alice)[0];
  const result = await f.sessions.confirmSend(alice, draft.deliveryId);
  assert.equal(result.status, "delivered");
  assert.equal(f.sdk.sessions.size, 1);
  assert.equal(f.sdk.sessions.get("alice").prompts.length, 1);
});

test("destinatario in elaborazione riceve evento senza attivare o aspettare il modello", async (t) => {
  const f = await fixture(t); let release; let started;
  const wait = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const original = f.sdk.onPrompt;
  f.sdk.onPrompt = async (session, text) => { if (text === "occupato") { started(); await wait; } else await original(session, text); };
  const active = f.sessions.reply("bob", "occupato", bob);
  await ready;
  await f.sessions.reply("alice", "manda", alice);
  const draft = f.sessions.pendingFor(alice)[0];
  const result = await f.sessions.confirmSend(alice, draft.deliveryId);
  assert.equal(result.status, "delivered");
  assert.ok(f.sdk.sessions.get("bob").notes.some((note) => note.whileActive));
  assert.equal(f.sdk.sessions.get("bob").prompts.length, 1);
  release(); await active;
});

test("consegna non confermata non viene registrata come consegnata", async (t) => {
  const f = await fixture(t, async () => { throw new Error("rete"); });
  await f.sessions.reply("alice", "manda", alice);
  const draft = f.sessions.pendingFor(alice)[0];
  await assert.rejects(f.sessions.confirmSend(alice, draft.deliveryId), /Consegna non confermata/);
  const statuses = f.sdk.sessions.get("bob").notes.map((note) => note.message.details.status);
  assert.deepEqual(statuses, ["requested", "delivery_unconfirmed"]);
  assert.equal(f.sessions.pendingFor(alice).length, 0);
});

test("strumenti non possono preparare invii fuori da un messaggio diretto autorizzato", async (t) => {
  const f = await fixture(t);
  await f.sessions.reply("alice", "manda", alice);
  const tool = f.sdk.sessions.get("alice").options.customTools.find((tool) => tool.name === "communication_prepare_send");
  await assert.rejects(tool.execute("call", proposal), /Nessun messaggio diretto/);
});

function incoming(text, id = 123) {
  return { message: { text, chat: { type: "private", id }, from: { id, is_bot: false } } };
}

test("router mostra anteprima e bottoni; anche il comando di fallback bypassa il modello", async (t) => {
  const f = await fixture(t);
  const router = new MessageRouter({ directory: f.config.directory, sessions: f.sessions, telegram: f.telegram });
  await router.handle(incoming("Manda a Bob: Ci vediamo alle 18"));
  assert.ok(f.sent.some((message) => message.markup?.inline_keyboard[0][0].text === "Conferma"));
  assert.ok(f.sent.every((message) => message.chat === 123));
  const draft = f.sessions.pendingFor(alice)[0];
  await router.handle(incoming(draft.confirmCommand));
  assert.equal(f.sdk.sessions.get("alice").prompts.length, 1);
  assert.equal(f.sdk.sessions.get("bob").prompts.length, 0);
  assert.ok(f.sent.some((message) => message.chat === "456"));
});

test("conferme inoltrate e conferme di altri utenti sono escluse", async (t) => {
  const f = await fixture(t);
  const router = new MessageRouter({ directory: f.config.directory, sessions: f.sessions, telegram: f.telegram });
  await router.handle(incoming("manda"));
  const draft = f.sessions.pendingFor(alice)[0];
  const forwarded = incoming(draft.confirmCommand); forwarded.message.forward_origin = { type: "user" };
  await router.handle(forwarded);
  await router.handle(incoming(draft.confirmCommand, 456));
  assert.equal(f.sessions.pendingFor(alice).length, 1);
  assert.ok(!f.sent.some((message) => message.chat === "456"));
});
