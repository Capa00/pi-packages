import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareSetup, buildSetupDraft, saveSetup } from "../src/service/setup-editor.mjs";
import { serviceStatus, startBackground, stopBackground } from "../src/service/control.mjs";

const cli = new URL("../src/service/cli.mjs", import.meta.url).pathname;
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "communication-cli-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sdkModule = join(base, "sdk.mjs");
  await writeFile(sdkModule, "export const fake = true;");
  const values = { botToken: "123456:PRIVATE_SECRET", sdkModule, workingDirectory: base, agentDirectory: base, name: "Me", address: "123456789" };
  const path = join(base, "config.json");
  const create = async (overrides = {}, file = path) => {
    const answers = { ...values, ...overrides };
    const prepared = await prepareSetup(file, answers);
    return (await saveSetup(prepared, buildSetupDraft(prepared, answers))).config;
  };
  return { base, values, path, create };
}

test("setup creates private external files and refuses a token from another bot", async (t) => {
  const { base, path, create } = await fixture(t);
  const config = await create();
  assert.equal(config.directory.contacts[0].endpoints[0].permissions.canRequestSendMessages, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(base, "contacts.json"))).mode & 0o777, 0o600);
  }
  const original = await readFile(path, "utf8");
  await assert.rejects(create({ botToken: "99:DIFFERENT" }), /different bot/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("setup refuses orphaned contacts without modifying them", async (t) => {
  const { base, path, create } = await fixture(t);
  await writeFile(join(base, "contacts.json"), "existing", { mode: 0o600 });
  await assert.rejects(create(), /will not overwrite/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.equal(await readFile(join(base, "contacts.json"), "utf8"), "existing");
});

test("setup rejects invalid tokens, user IDs, and paths before writing", async (t) => {
  const { path, create } = await fixture(t);
  await assert.rejects(create({ botToken: "secret" }), /valid bot token/);
  await assert.rejects(create({ address: "username" }), /numeric Telegram user ID/);
  await assert.rejects(create({ sdkModule: "/nonexistent-sdk" }), /before entering a token/);
  await assert.rejects(create({}, new URL("../config-test.json", import.meta.url).pathname), /outside the installed package/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("CLI check/status non aprono connessioni, setup richiede un terminale", async (t) => {
  const { values, path, create } = await fixture(t);
  await create();
  for (const [command, message] of [["check", /Configuration is valid/], ["status", /Servizio fermo/]]) {
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
  const { create } = await fixture(t);
  const config = await create();
  const lock = join(config.sessionsDirectory, ".telegram-service.lock");
  await mkdir(lock, { recursive: true });
  assert.equal((await serviceStatus(config)).state, "unmanaged-or-stale-lock");
  await assert.rejects(stopBackground(config), /nessun segnale/);
  if (process.platform === "linux") await assert.rejects(startBackground(config), /nessuna nuova istanza/);
  assert.ok(await stat(lock));
});

test("PID riutilizzati e metadati invalidi non autorizzano segnali", { skip: process.platform !== "linux" }, async (t) => {
  const { base, create } = await fixture(t);
  const config = await create();
  const file = join(base, "managed-service.json");
  await writeFile(file, JSON.stringify({ pid: process.pid, identity: "not-the-start-time", configFile: config.configFile }));
  assert.equal((await serviceStatus(config)).state, "stopped");
  assert.equal(await stopBackground(config), false);
  await writeFile(file, JSON.stringify({ pid: -1, identity: "0", configFile: config.configFile }));
  await assert.rejects(stopBackground(config), /Metadati servizio invalidi/);
});

test("background gestito: ready, status, doppio avvio, stop senza Telegram", { skip: process.platform !== "linux" }, async (t) => {
  const { base, create } = await fixture(t);
  const config = await create();
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
  const { base, create } = await fixture(t);
  const config = await create();
  const entry = join(base, "failed-service.mjs");
  await writeFile(entry, "process.exit(1);");
  await assert.rejects(startBackground(config, { entry, timeout: 3000 }), /durante l'avvio/);
  assert.equal((await serviceStatus(config)).state, "stopped");
});
