import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeSetup } from "../src/service/setup.mjs";
import { serviceStatus, startBackground, stopBackground } from "../src/service/control.mjs";

const cli = new URL("../src/service/cli.mjs", import.meta.url).pathname;
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "communication-cli-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sdkModule = join(base, "sdk.mjs");
  await writeFile(sdkModule, "export const fake = true;");
  const values = { botToken: "123456:PRIVATE_SECRET", sdkModule, workingDirectory: base, agentDirectory: base, id: "me", name: "Me", address: "123456789" };
  return { base, values, path: join(base, "config.json") };
}

test("setup crea file esterni restrittivi, validati e non sovrascrivibili", async (t) => {
  const { base, values, path } = await fixture(t);
  const config = await writeSetup(path, values);
  assert.equal(config.directory.contacts[0].endpoints[0].permissions.canRequestSendMessages, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(base, "contacts.json"))).mode & 0o777, 0o600);
  }
  const original = await readFile(path, "utf8");
  await assert.rejects(writeSetup(path, { ...values, botToken: "99:DIFFERENT" }), /Nessun file esistente sovrascritto/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("setup annulla i nuovi file se la rubrica esiste, senza toccarla", async (t) => {
  const { base, values, path } = await fixture(t);
  await writeFile(join(base, "contacts.json"), "existing");
  await assert.rejects(writeSetup(path, values), /Setup non completato/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.equal(await readFile(join(base, "contacts.json"), "utf8"), "existing");
});

test("setup rifiuta token, ID e percorsi invalidi prima di scrivere", async (t) => {
  const { values, path } = await fixture(t);
  await assert.rejects(writeSetup(path, { ...values, botToken: "secret" }), /formato non valido/);
  await assert.rejects(writeSetup(path, { ...values, address: "username" }), /ID utente/);
  await assert.rejects(writeSetup(path, { ...values, sdkModule: "/nonexistent-sdk" }), /Modulo SDK/);
  await assert.rejects(writeSetup(new URL("../config-test.json", import.meta.url).pathname, values), /esterna al package/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("CLI check/status non aprono connessioni, setup richiede un terminale", async (t) => {
  const { values, path } = await fixture(t);
  await writeSetup(path, values);
  for (const [command, message] of [["check", /Configurazione valida/], ["status", /Servizio fermo/]]) {
    const result = spawnSync(process.execPath, [cli, command, "--config", path], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, message);
    assert.ok(!result.stdout.includes(values.botToken));
  }
  const result = spawnSync(process.execPath, [cli, "setup", "--config", path], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminale interattivo/);
});

test("CLI rifiuta opzioni ambigue o inappropriate", () => {
  for (const args of [["stop", "--background"], ["stop", "--foreground"], ["start", "--foreground", "--background"], ["start", "--background", "--foreground"], ["start", "--foreground", "--foreground"], ["start", "--background", "--background"], ["check", "--config"], ["check", "--wat"], ["check", "--config", "a", "--config", "b"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Argomenti non validi/);
  }
});

test("lock non gestiti non vengono rimossi né arrestati", async (t) => {
  const { values, path } = await fixture(t);
  const config = await writeSetup(path, values);
  const lock = join(config.sessionsDirectory, ".telegram-service.lock");
  await mkdir(lock, { recursive: true });
  assert.equal((await serviceStatus(config)).state, "unmanaged-or-stale-lock");
  await assert.rejects(stopBackground(config), /nessun segnale/);
  if (process.platform === "linux") await assert.rejects(startBackground(config), /nessuna nuova istanza/);
  assert.ok(await stat(lock));
});

test("PID riutilizzati e metadati invalidi non autorizzano segnali", { skip: process.platform !== "linux" }, async (t) => {
  const { base, values, path } = await fixture(t);
  const config = await writeSetup(path, values);
  const file = join(base, "managed-service.json");
  await writeFile(file, JSON.stringify({ pid: process.pid, identity: "not-the-start-time", configFile: config.configFile }));
  assert.equal((await serviceStatus(config)).state, "stopped");
  assert.equal(await stopBackground(config), false);
  await writeFile(file, JSON.stringify({ pid: -1, identity: "0", configFile: config.configFile }));
  await assert.rejects(stopBackground(config), /Metadati servizio invalidi/);
});

test("background gestito: ready, status, doppio avvio, stop senza Telegram", { skip: process.platform !== "linux" }, async (t) => {
  const { base, values, path } = await fixture(t);
  const config = await writeSetup(path, values);
  const entry = join(base, "fake-service.mjs");
  await writeFile(entry, `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); process.send({ready:true});`);
  t.after(async () => { try { await stopBackground(config, { timeout: 3000 }); } catch {} });
  const result = await startBackground(config, { entry, timeout: 3000 });
  assert.ok(result.pid > 1);
  assert.equal((await serviceStatus(config)).state, "running");
  await assert.rejects(startBackground(config, { entry }), /nessuna nuova istanza/);
  assert.equal(await stopBackground(config, { timeout: 3000 }), true);
  assert.equal((await serviceStatus(config)).state, "stopped");
  assert.equal(await stopBackground(config), false);
});

test("avvio background fallito non dichiara il servizio attivo", { skip: process.platform !== "linux" }, async (t) => {
  const { base, values, path } = await fixture(t);
  const config = await writeSetup(path, values);
  const entry = join(base, "failed-service.mjs");
  await writeFile(entry, "process.exit(1);");
  await assert.rejects(startBackground(config, { entry, timeout: 3000 }), /durante l'avvio/);
  assert.equal((await serviceStatus(config)).state, "stopped");
});
