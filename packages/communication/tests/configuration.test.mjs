import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadConfiguration } from "../src/config/load.mjs";
import { validateDirectory, resolveContact, resolveRecipientEndpoint } from "../src/contacts/directory.mjs";
import { canInteract, canReceive, authorizeRequestedSend } from "../src/contacts/permissions.mjs";

const grants = { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true };
const sender = { channel: "telegram", address: "123" };
function contact(id = "alice", address = "123", permissions = grants) {
  return { id, name: id, aliases: [], endpoints: [{ channel: "telegram", address, permissions }], preferredChannel: "telegram" };
}
function directory(contacts = [contact()]) { return validateDirectory({ version: 1, contacts }); }

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "pi-communication-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const config = { version: 1, telegram: { botToken: "123:TEST_SECRET" }, contactsFile: "contacts.json", sessionsDirectory: "sessions", pi: { sdkModule: new URL("../src/service/cli.mjs", import.meta.url).pathname, workingDirectory: path, agentDirectory: path } };
  const configFile = join(path, "config.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(path, "contacts.json"), JSON.stringify({ version: 1, contacts: [contact()] }));
  return { path, config, configFile, save: () => writeFile(configFile, JSON.stringify(config)) };
}

test("utenti sconosciuti esclusi e permessi mancanti negati", () => {
  const data = directory([contact("alice", "123", {})]);
  assert.equal(canInteract(data, sender), false);
  assert.equal(canReceive(data, sender), false);
  assert.equal(canInteract(data, { ...sender, address: "999" }), false);
  assert.throws(() => authorizeRequestedSend(data, sender, "alice"), /non autorizzato/);
});

test("profili iniziali uguali consentono interazione e invio richiesto", () => {
  const data = directory([contact(), contact("bob", "456")]);
  assert.equal(canInteract(data, sender), true);
  assert.equal(canReceive(data, sender), true);
  assert.equal(authorizeRequestedSend(data, sender, "bob").endpoint.address, "456");
});

test("i permessi del mittente e del destinatario sono indipendenti", () => {
  const data = directory([contact(), contact("bob", "456", { ...grants, canReceiveMessages: false })]);
  assert.throws(() => authorizeRequestedSend(data, sender, "bob"), /Destinatario non autorizzato/);
  const restricted = directory([contact("alice", "123", { ...grants, canRequestSendMessages: false }), contact("bob", "456")]);
  assert.throws(() => authorizeRequestedSend(restricted, sender, "bob"), /mittente/);
});

test("rifiuta identificativi duplicati, recapiti duplicati, username Telegram e permessi errati", () => {
  assert.throws(() => directory([contact(), contact("alice", "456")]), /duplicato/);
  assert.throws(() => directory([contact(), contact("bob", "123")]), /duplicato/);
  assert.throws(() => directory([contact("alice", "@alice")]), /ID utente/);
  assert.throws(() => directory([contact("alice", "123", { canInteractWithPi: "true" })]), /booleano/);
  assert.throws(() => directory([contact("alice", "123", { canInterractWithPi: true })]), /campo non riconosciuto/);
});

test("nomi e recapiti ambigui richiedono chiarimenti", () => {
  const a = contact(); a.aliases = ["Amico"];
  const b = contact("bob", "456"); b.aliases = ["amico"];
  const data = directory([a, b]);
  assert.throws(() => resolveContact(data, "AMICO"), /ambiguo/);
  assert.equal(resolveContact(data, "ALICE").id, "alice");
  const multiple = { ...a, preferredChannel: undefined, endpoints: [...a.endpoints, { channel: "discord", address: "987", permissions: grants }] };
  assert.throws(() => resolveRecipientEndpoint(multiple), /ambiguo/);
  assert.equal(resolveRecipientEndpoint(multiple, "discord").address, "987");
});

test("supporta recapiti futuri e scope separati", () => {
  const a = contact();
  a.endpoints.push({ channel: "slack", address: "U123", scope: "W1", permissions: {} });
  const b = contact("bob", "456");
  b.endpoints.push({ channel: "slack", address: "U123", scope: "W2", permissions: grants });
  const data = directory([a, b]);
  assert.equal(canInteract(data, { channel: "slack", address: "U123", scope: "W1" }), false);
  assert.equal(canInteract(data, { channel: "slack", address: "U123", scope: "W2" }), true);
  assert.equal(canInteract(data, { channel: "slack", address: "U123" }), false);
});

test("carica solo file, risolve percorsi relativi e non crea sessioni", async (t) => {
  const { path, configFile } = await fixture(t);
  const config = await loadConfiguration(configFile);
  assert.equal(config.contactsFile, join(path, "contacts.json"));
  assert.equal(config.sessionsDirectory, join(path, "sessions"));
  assert.equal(config.directory.contacts.length, 1);
});

test("configurazione malformata non espone il token negli errori", async (t) => {
  const f = await fixture(t);
  await writeFile(f.configFile, '{"botToken":"SECRET_VALUE",');
  await assert.rejects(loadConfiguration(f.configFile), (error) => error.message === "Configurazione: JSON non valido");
  f.config.telegram.botToken = "SECRET_VALUE";
  await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /formato non valido/);
});

test("rifiuta permessi troppo aperti per il file segreto", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await chmod(f.configFile, 0o644);
  await assert.rejects(loadConfiguration(f.configFile), /chmod 600/);
});

test("rifiuta versioni, campi e percorsi rubrica errati", async (t) => {
  const f = await fixture(t);
  f.config.version = 2; await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /versione/);
  f.config.version = 1; f.config.extra = true; await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /campo non riconosciuto/);
  delete f.config.extra; f.config.contactsFile = "missing.json"; await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /file non accessibile/);
});

test("non accetta dati nel package neppure attraverso symlink", async (t) => {
  const f = await fixture(t);
  f.config.contactsFile = new URL("../package.json", import.meta.url).pathname;
  await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /esterno al package/);
  f.config.contactsFile = "contacts.json";
  await symlink(new URL("../src", import.meta.url).pathname, join(f.path, "internal"));
  f.config.sessionsDirectory = "internal/new-sessions"; await f.save();
  await assert.rejects(loadConfiguration(f.configFile), /esterna al package/);
});

test("CLI check valida senza mostrare segreti", async (t) => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [new URL("../src/service/cli.mjs", import.meta.url).pathname, "check", "--config", f.configFile], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Contacts: 1/);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(f.config.telegram.botToken));
});
