import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Outbound } from "../src/service/outbound.mjs";
import { OutboundStore } from "../src/service/outbound-store.mjs";
import { MessageRouter } from "../src/service/router.mjs";
import { prepareState, inspectServiceLock } from "../src/service/state.mjs";
import { validateDirectory } from "../src/contacts/directory.mjs";
import { runService } from "../src/service/run.mjs";

const alice = { channel: "telegram", address: "123" };
const bob = { channel: "telegram", address: "456" };
const proposal = { recipient: "bob", text: "Prova persistente" };
function directory() {
  return validateDirectory({ version: 1, contacts: [alice, bob].map((endpoint, i) => ({
    id: i ? "bob" : "alice", name: i ? "Bob" : "Alice", aliases: [], endpoints: [{ ...endpoint,
      permissions: { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true } }],
  })) });
}
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "pi-durable-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, store: new OutboundStore(path), directory: directory() };
}

test("proposta e binding ripresi dopo riavvio con scadenza originale e permessi ricontrollati", async (t) => {
  const f = await fixture(t); let now = 1000;
  const first = new Outbound(f.directory, async () => assert.fail(), () => now, f.store);
  const draft = first.prepare(alice, proposal);
  first.bindPreview(alice, draft.deliveryId, { deliveryId: draft.deliveryId, chatId: 123, messageId: 9 });
  now = 2000;
  const restored = new Outbound(f.directory, async () => assert.fail(), () => now, new OutboundStore(f.path));
  assert.deepEqual(restored.pendingFor(alice), [draft]);
  assert.equal(restored.previewForContact("alice").messageId, 9);
  await assert.rejects(restored.confirm(bob, draft.deliveryId), /non appartenente/);
  f.directory.contacts[1].endpoints[0].permissions.canReceiveMessages = false;
  await assert.rejects(restored.confirm(alice, draft.deliveryId), /non autorizzato/);
  now = draft.expiresAt;
  assert.equal(restored.pendingFor(alice).length, 0);
  assert.equal(f.store.load()[0].state, "expired");
});

test("annullamenti e sostituzioni non riappaiono dopo restart", async (t) => {
  const f = await fixture(t);
  let out = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  const old = out.prepare(alice, proposal);
  const current = out.prepare(alice, { ...proposal, text: "Nuova" });
  out = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  await assert.rejects(out.confirm(alice, old.deliveryId), /assente/);
  out.cancel(alice, current.deliveryId);
  out = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  assert.equal(out.pendingFor(alice).length, 0);
  await assert.rejects(out.confirm(alice, current.deliveryId), /assente/);
});

test("commit sending precede la consegna e replay dopo restart non reinvia", async (t) => {
  const f = await fixture(t); let count = 0;
  const out = new Outbound(f.directory, async () => {
    count++; assert.equal(f.store.load()[0].state, "sending");
    return { status: "delivered", messageIds: [42], contextRecorded: true };
  }, Date.now, f.store);
  const draft = out.prepare(alice, proposal);
  await Promise.allSettled([out.confirm(alice, draft.deliveryId), out.confirm(alice, draft.deliveryId)]);
  assert.equal(count, 1);
  assert.equal(f.store.load()[0].state, "delivered");
  const restored = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  await assert.rejects(restored.confirm(alice, draft.deliveryId), /assente/);
  assert.equal(restored.recentFor(alice)[0].status, "delivered");
  assert.equal(restored.recentFor(bob).length, 0);
});

test("crash reale di un worker dopo commit: sending diventa incerto, mai reinviato", async (t) => {
  const f = await fixture(t);
  const worker = join(f.path, "worker.mjs");
  await writeFile(worker, `import {Outbound} from ${JSON.stringify(new URL("../src/service/outbound.mjs", import.meta.url).href)};
import {OutboundStore} from ${JSON.stringify(new URL("../src/service/outbound-store.mjs", import.meta.url).href)};
const out = new Outbound(${JSON.stringify(f.directory)}, async () => { console.log('IN_FLIGHT'); await new Promise(() => {}); }, Date.now, new OutboundStore(${JSON.stringify(f.path)}));
const draft = out.prepare(${JSON.stringify(alice)}, ${JSON.stringify(proposal)});
setInterval(() => {}, 1000);
await out.confirm(${JSON.stringify(alice)}, draft.deliveryId);`);
  const child = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exit = once(child, "exit");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker timeout")), 5000);
    child.stdout.once("data", (data) => { clearTimeout(timer); assert.match(String(data), /IN_FLIGHT/); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const id = f.store.load()[0].draft.id;
  child.kill("SIGKILL"); await exit;
  const restored = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  assert.equal(restored.pendingFor(alice).length, 0);
  assert.equal(restored.recentFor(alice)[0].status, "delivery_unconfirmed");
  await assert.rejects(restored.confirm(alice, id), /assente/);
  assert.equal(f.store.load()[0].state, "delivery_unconfirmed");
});

test("errore di consegna persistito come incerto senza retry", async (t) => {
  const f = await fixture(t);
  const out = new Outbound(f.directory, async () => { throw new Error("rete"); }, Date.now, f.store);
  const draft = out.prepare(alice, proposal);
  await assert.rejects(out.confirm(alice, draft.deliveryId), /rete/);
  const restored = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  assert.equal(restored.recentFor(alice)[0].status, "delivery_unconfirmed");
});

test("errore di persistenza prima della rete blocca l'invio e altre operazioni", async (t) => {
  const f = await fixture(t); let saves = 0;
  const store = { load: () => f.store.load(), save: (entries) => { if (++saves === 2) throw new Error("disco"); f.store.save(entries); } };
  const out = new Outbound(f.directory, async () => assert.fail(), Date.now, store);
  const draft = out.prepare(alice, proposal);
  await assert.rejects(out.confirm(alice, draft.deliveryId), /disco/);
  assert.throws(() => out.prepare(alice, proposal), /Stato outbound/);
});

test("Telegram riuscito ma commit finale fallito: risultato riuscito con avviso, restart incerto", async (t) => {
  const f = await fixture(t); let saves = 0;
  const store = { load: () => f.store.load(), save: (entries) => { if (++saves === 3) throw new Error("disco"); f.store.save(entries); } };
  const out = new Outbound(f.directory, async () => ({ status: "delivered", contextRecorded: true, messageIds: [10] }), Date.now, store);
  const draft = out.prepare(alice, proposal);
  const result = await out.confirm(alice, draft.deliveryId);
  assert.equal(result.status, "delivered"); assert.equal(result.journalRecorded, false);
  const restored = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  assert.equal(restored.recentFor(alice)[0].status, "delivery_unconfirmed");
});

test("registro corrotto o troppo aperto rifiutato senza ripararlo o esporre contenuto", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store.file, "PRIVATE_SECRET", { mode: 0o600 });
  assert.throws(() => f.store.load(), /Stato outbound/);
  assert.equal(await readFile(f.store.file, "utf8"), "PRIVATE_SECRET");
  await writeFile(f.store.file, JSON.stringify({ version: 1, entries: [] }));
  if (process.platform !== "win32") {
    await chmod(f.store.file, 0o644);
    assert.throws(() => f.store.load(), /Stato outbound/);
  }
});

test("registro non valido blocca il servizio prima di Telegram e rilascia il proprio lock", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store.file, "INVALID_SECRET", { mode: 0o600 });
  const config = { sessionsDirectory: f.path, directory: f.directory, telegram: { botToken: "fake" } };
  await assert.rejects(runService(config, { sdk: {}, telegram: { getUpdates: async () => assert.fail() }, log: () => {} }), /Stato outbound/);
  await assert.rejects(stat(join(f.path, ".telegram-service.lock")), { code: "ENOENT" });
});

function wrapper(out, sent) {
  return new MessageRouter({ directory: directory(), sessions: {
    pendingFor: (sender) => out.pendingFor(sender), recentFor: (sender) => out.recentFor(sender),
    previewForContact: (id) => out.previewForContact(id), bindPreview: (...args) => out.bindPreview(...args),
    confirmSend: (...args) => out.confirm(...args), cancelSend: (...args) => out.cancel(...args), reply: async () => "Risposta ordinaria",
  }, telegram: { async answerCallback() {}, async removeButtons() {},
    async sendText(chat, text, signal, markup) { sent.push({ chat, text, markup }); return [sent.length + 10]; }, async sendTyping() {},
  } });
}
const message = (text) => ({ message: { from: { id: 123 }, chat: { id: 123, type: "private" }, text } });
const callback = (id, messageId, user = 123) => ({ callback_query: { id: "click", from: { id: user }, data: `out:conferma:${id}`,
  message: { chat: { id: user, type: "private" }, message_id: messageId } } });

test("bottoni persistiti restano validi dopo restart, ma altre chat escluse", async (t) => {
  const f = await fixture(t); let delivered = 0;
  const first = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  const draft = first.prepare(alice, proposal);
  first.bindPreview(alice, draft.deliveryId, { deliveryId: draft.deliveryId, chatId: 123, messageId: 9 });
  const restored = new Outbound(f.directory, async () => { delivered++; return { status: "delivered", to: { name: "Bob" }, contextRecorded: true }; }, Date.now, f.store);
  const router = wrapper(restored, []);
  await router.handle(callback(draft.deliveryId, 9, 456));
  assert.equal(delivered, 0);
  await router.handle(callback(draft.deliveryId, 9));
  await router.handle(callback(draft.deliveryId, 9));
  assert.equal(delivered, 1);
});

test("/sends restores previews on request and invalidates old buttons", async (t) => {
  const f = await fixture(t);
  const out = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  const draft = out.prepare(alice, proposal);
  out.bindPreview(alice, draft.deliveryId, { deliveryId: draft.deliveryId, chatId: 123, messageId: 9 });
  const sent = []; const router = wrapper(out, sent);
  await router.handle(message("ciao"));
  assert.equal(sent.filter((m) => m.markup).length, 0);
  await router.handle(message("/sends"));
  assert.equal(sent.filter((m) => m.markup).length, 1);
  assert.notEqual(out.previewForContact("alice").messageId, 9);
  await router.handle(callback(draft.deliveryId, 9));
  assert.equal(out.pendingFor(alice).length, 1);
});

test("/sends shows uncertain delivery only to the sender without sending", async (t) => {
  const f = await fixture(t);
  const out = new Outbound(f.directory, async () => { throw new Error("network failure"); }, Date.now, f.store);
  const draft = out.prepare(alice, proposal);
  await assert.rejects(out.confirm(alice, draft.deliveryId));
  const restored = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  const sent = []; const router = wrapper(restored, sent);
  await router.handle(message("/sends"));
  assert.match(sent[0].text, /delivery uncertain/);
  assert.equal(sent[0].chat, 123);
  assert.equal(sent[0].markup, undefined);
});

test("/sends supports the bot suffix and does not expose another user's proposals", async (t) => {
  const f = await fixture(t);
  const out = new Outbound(f.directory, async () => assert.fail(), Date.now, f.store);
  out.prepare(alice, proposal);
  const sent = []; const router = wrapper(out, sent);
  await router.handle({ message: { from: { id: 456 }, chat: { id: 456, type: "private" }, text: "/sends@PiCommunicationBot" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 456);
  assert.equal(sent[0].text, "No pending proposals or recent sends.");
  assert.equal(sent[0].markup, undefined);
  assert.equal(out.pendingFor(alice).length, 1);
});

test("lock identifica processo vivo, PID riutilizzato e vecchio boot senza rimuoverli", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t); const state = await prepareState(f.path);
  const file = join(f.path, ".telegram-service.lock/owner.json");
  const owner = JSON.parse(await readFile(file, "utf8"));
  assert.equal((await inspectServiceLock(f.path)).state, "active");
  await assert.rejects(prepareState(f.path), /già attivo/);
  await writeFile(file, JSON.stringify({ ...owner, identity: "reused-pid" }));
  assert.equal((await inspectServiceLock(f.path)).state, "stale");
  await assert.rejects(prepareState(f.path), /lock residuo verificato/);
  assert.ok(await stat(file));
  await writeFile(file, JSON.stringify({ ...owner, boot: "old-boot" }));
  assert.equal((await inspectServiceLock(f.path)).state, "stale");
  await writeFile(file, JSON.stringify(owner));
  await state.close();
});

test("lock sconosciuto e proprietario cambiato non vengono rimossi", async (t) => {
  const f = await fixture(t); const state = await prepareState(f.path);
  const file = join(f.path, ".telegram-service.lock/owner.json");
  const owner = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...owner, token: "different-owner" }));
  await assert.rejects(state.close(), /proprietario.*cambiato/);
  assert.ok(await stat(file));
  await writeFile(file, "invalid");
  assert.equal((await inspectServiceLock(f.path)).state, "unknown");
  await assert.rejects(prepareState(f.path), /non identificabile/);
  assert.ok(await stat(file));
});
