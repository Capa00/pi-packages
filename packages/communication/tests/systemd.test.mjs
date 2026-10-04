import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeSetup, setupSystemd } from "../src/service/setup.mjs";
import { renderUnit, unitLocation, installSystemd, installedUnit, systemdStatus, controlSystemd } from "../src/service/systemd.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "pi-systemd-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sdkModule = join(home, "sdk.mjs");
  await writeFile(sdkModule, "export const fake = true;");
  const config = await writeSetup(join(home, ".pi/communication/config.json"), {
    botToken: "123:TOP_SECRET", sdkModule, workingDirectory: home, agentDirectory: home,
    id: "me", name: "Me", address: "123456789",
  });
  const calls = [];
  const options = { home, platform: "linux", username: "alice", run: async (command, args) => {
    calls.push([command, args]);
    if (command === "loginctl") return "yes";
    return "";
  } };
  return { home, config, calls, options };
}

test("unità contiene percorsi assoluti e nessun token; nessun restart automatico dopo crash", async (t) => {
  const { config, options } = await fixture(t);
  const text = renderUnit(config);
  assert.match(text, /Type=simple/);
  assert.match(text, /start --foreground --config/);
  assert.match(text, /WantedBy=default.target/);
  assert.match(text, /Restart=no/);
  assert.match(text, /SendSIGKILL=no/);
  assert.match(text, /UMask=0077/);
  assert.ok(!text.includes(config.telegram.botToken));
  assert.equal(unitLocation(config, options).name, "pi-communication.service");
  assert.notEqual(unitLocation({ ...config, configFile: join(options.home, "other.json") }, options).name, "pi-communication.service");
});

test("escape systemd preserva spazi, virgolette, percentuali e dollari senza espansione", async (t) => {
  const { config } = await fixture(t);
  const text = renderUnit({ ...config, configFile: '/tmp/a %n $HOME "quoted" \\name.json' });
  assert.ok(text.includes('ExecStart=:'));
  assert.ok(text.includes('a %%n $HOME \\"quoted\\" \\\\name.json'));
  assert.throws(() => renderUnit({ ...config, configFile: "/tmp/config\nExecStart=evil" }), /caratteri di controllo/);
  assert.throws(() => renderUnit(config, { entry: "relative.mjs" }), /percorso assoluto/);
});

test("primo setup crea unità 600, reload e enable, mai start né sudo", async (t) => {
  const { config, calls, options } = await fixture(t);
  const logs = [];
  const result = await setupSystemd(config, { ...options, log: (line) => logs.push(line) });
  assert.equal(result.linger, "yes");
  assert.equal(await readFile(result.path, "utf8"), renderUnit(config));
  if (process.platform !== "win32") assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "pi-communication.service"]],
    ["loginctl", ["show-user", "alice", "--property=Linger", "--value"]],
  ]);
  assert.ok(logs.some((line) => line.includes("boot senza login")));
});

test("linger disabilitato/sconosciuto: istruzioni esplicite, niente privilegi automatici", async (t) => {
  const { config, options } = await fixture(t);
  for (const response of ["no", "unknown"]) {
    const logs = [];
    await setupSystemd(config, { ...options, run: async (command) => command === "loginctl" ? response : "", log: (line) => logs.push(line) });
    assert.ok(logs.some((line) => line.includes("sudo loginctl enable-linger")));
    assert.ok(logs.some((line) => line.includes("non ancora")));
  }
});

test("setup ripetuto idempotente, unità estranee non sovrascritte", async (t) => {
  const { config, options, calls } = await fixture(t);
  const result = await installSystemd(config, options);
  await installSystemd(config, options);
  assert.equal(calls.filter(([command, args]) => command === "systemctl" && args.includes("enable")).length, 2);
  await writeFile(result.path, "foreign unit\n");
  calls.length = 0;
  await assert.rejects(installSystemd(config, options), /nessuna sovrascrittura/);
  await assert.rejects(installedUnit(config, options), /non riconosciuta/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(result.path, "utf8"), "foreign unit\n");
});

test("enable fallito conserva configurazione e unità per ritentare", async (t) => {
  const { config, options } = await fixture(t);
  await assert.rejects(installSystemd(config, { ...options, run: async () => { throw new Error("manager unavailable"); } }), /manager unavailable/);
  assert.ok(await stat(config.configFile));
  assert.ok(await stat(unitLocation(config, options).path));
  assert.equal((await installSystemd(config, options)).supported, true);
});

test("non Linux non crea unità né esegue comandi", async (t) => {
  const { config, options, calls } = await fixture(t);
  const result = await installSystemd(config, { ...options, platform: "darwin" });
  assert.deepEqual(result, { supported: false });
  assert.equal(calls.length, 0);
  await assert.rejects(stat(unitLocation(config, options).path), { code: "ENOENT" });
});

test("status/start/stop verificano unità caricata e usano soltanto systemctl --user", async (t) => {
  const { config, options, calls } = await fixture(t);
  const unit = await installSystemd(config, options);
  calls.length = 0;
  let active = "inactive";
  const run = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("show")) return `ActiveState=${active}\nSubState=${active === "active" ? "running" : "dead"}\nUnitFileState=enabled\nFragmentPath=${unit.path}`;
    if (args.includes("start")) active = "active";
    if (args.includes("stop")) active = "inactive";
    return "";
  };
  assert.equal((await systemdStatus(config, { ...options, run })).active, "inactive");
  assert.equal((await controlSystemd(config, "start", { ...options, run })).active, "active");
  assert.equal((await controlSystemd(config, "stop", { ...options, run })).active, "inactive");
  assert.ok(calls.every(([command, args]) => command === "systemctl" && args[0] === "--user"));
  await assert.rejects(controlSystemd(config, "start", { ...options, run: async () => "ActiveState=active\nFragmentPath=/nonexistent" }), /non caricata/);
});

test("unità generata valida per systemd-analyze senza avviare processi", { skip: process.platform !== "linux" }, async (t) => {
  if (spawnSync("systemd-analyze", ["--version"]).error) { t.skip("systemd-analyze non disponibile"); return; }
  const { config, options } = await fixture(t);
  const result = await installSystemd(config, options);
  const verification = spawnSync("systemd-analyze", ["verify", result.path], { encoding: "utf8", timeout: 10000 });
  assert.equal(verification.status, 0, verification.stderr);
});
