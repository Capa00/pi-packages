import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfiguration } from "../src/config/load.mjs";
import { unitLocation } from "../src/service/systemd.mjs";
import { botConfigPath } from "../src/service/profiles.mjs";

const cli = new URL("../src/service/cli.mjs", import.meta.url).pathname;
// Un PTY reale esercita readline e mascheramento; gli eseguibili systemd sono stub
// nella directory temporanea. Nessuna unità o connessione reale viene creata.
const driver = String.raw`
import os, sys, json, pty, select, subprocess, time, errno
request = json.load(sys.stdin)
master, slave = pty.openpty()
process = subprocess.Popen(request['argv'], stdin=slave, stdout=slave, stderr=slave,
                           env=request['env'], cwd=request['cwd'])
os.close(slave)
output = bytearray()
position = 0
deadline = time.monotonic() + 12

def receive():
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            block = os.read(master, 65536)
            if block: output.extend(block)
        except OSError as error:
            if error.errno != errno.EIO: raise

try:
    for prompt, answer in request['steps']:
        expected = prompt.encode('utf-8')
        while output.find(expected, position) < 0:
            if time.monotonic() > deadline: raise RuntimeError('Prompt timeout: ' + prompt)
            receive()
            if process.poll() is not None and output.find(expected, position) < 0:
                raise RuntimeError('Setup terminated before prompt: ' + prompt)
        position = output.find(expected, position) + len(expected)
        os.write(master, answer.encode('utf-8') + b'\n')
    while process.poll() is None:
        if time.monotonic() > deadline: raise RuntimeError('Setup exit timeout')
        receive()
    for _ in range(5): receive()
    print(json.dumps({'status': process.returncode, 'output': output.decode('utf-8', errors='replace')}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
`;

async function fixture(t) {
  if (process.platform !== "linux" || spawnSync("python3", ["--version"]).error) {
    t.skip("Collaudo PTY richiede Linux e Python 3"); return;
  }
  try {
    const runtime = await stat(`/run/user/${process.getuid()}`);
    if (!runtime.isDirectory() || runtime.uid !== process.getuid() || (runtime.mode & 0o077) !== 0) throw new Error();
  } catch { t.skip("Directory runtime utente non disponibile per il trasporto systemctl"); return; }
  const home = await mkdtemp(join(tmpdir(), "pi-setup-pty-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  const calls = join(home, "commands.jsonl");
  const sdk = join(home, "sdk.mjs");
  const guard = join(home, "guard.mjs");
  await writeFile(sdk, 'throw new Error("Il setup non deve importare SDK");');
  await writeFile(guard, 'globalThis.fetch = () => { throw new Error("Rete vietata nel collaudo setup"); };');
  const path = join(home, ".pi/communication/config.json");
  const profilePath = botConfigPath(path, "123456");
  const { name: unitName, path: unit } = unitLocation({ configFile: profilePath }, { home });
  for (const command of ["systemctl", "loginctl", "sudo"]) {
    await writeFile(join(bin, command), `#!${process.execPath}
import {appendFileSync, mkdirSync, symlinkSync, existsSync} from 'node:fs';
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
const reload = command === 'systemctl' && JSON.stringify(args) === JSON.stringify(['--user','daemon-reload']);
const enable = command === 'systemctl' && JSON.stringify(args) === JSON.stringify(['--user','enable',${JSON.stringify(unitName)}]);
const linger = command === 'loginctl' && args.length === 4 && args[0] === 'show-user' && args[2] === '--property=Linger' && args[3] === '--value';
if (!reload && !enable && !linger) { console.error('Comando vietato nel collaudo'); process.exit(1); }
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([command,args])+'\\n');
if (enable) {
  const directory = ${JSON.stringify(join(home, ".config/systemd/user/default.target.wants"))};
  mkdirSync(directory, {recursive:true});
  const link = directory + '/' + ${JSON.stringify(unitName)};
  if (!existsSync(link)) symlinkSync(${JSON.stringify(unit)}, link);
}
if (linger) console.log('yes');
`, { mode: 0o700 });
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: "" };
  return { home, sdk, unit, unitName, calls, path, profilePath, env, guard };
}

function runSetup(f, steps, additionalArgs = []) {
  const result = spawnSync("python3", ["-c", driver], {
    input: JSON.stringify({ argv: [process.execPath, "--import", f.guard, cli, "setup", ...additionalArgs], env: f.env, cwd: f.home, steps }),
    encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.status, 0, answer.output);
  return answer.output;
}

function firstSteps(f, confirmation = "yes") {
  return [
    ["Pi SDK entry point (dist/index.js)", f.sdk],
    ["Pi agent directory", f.home],
    ["Choice (number or cancel)", "1"],
    ["Profile name (optional)", "Test bot"],
    ["BotFather token (hidden; Enter keeps existing): ", "123456:PTY_PRIVATE_TOKEN"],
    ["Your name", "\x1b[ATest User"], // Up must not retrieve the secret from readline history.
    ["Your numeric Telegram user ID", "123456789"],
    ["Choice (number or cancel)", "1"],
    ["Allow readFiles? Type yes/no", "yes"],
    ["Allow writeFiles? Type yes/no", "no"],
    ["Allow executeCommands? Type yes/no", "no"],
    ["Confirm? Type yes", confirmation],
  ];
}

async function recordedCalls(f) {
  return (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("setup completo da zero in PTY: token nascosto, file validi e unità abilitata senza avvio", async (t) => {
  const f = await fixture(t); if (!f) return;
  const output = runSetup(f, firstSteps(f));
  assert.ok(!output.includes("PTY_PRIVATE_TOKEN"), "Il token non deve apparire sul terminale neppure con freccia su");
  assert.match(output, /Configuration saved and validated/);
  assert.match(output, /Automatic startup configured; the bot was not started/);
  const config = await loadConfiguration(f.profilePath);
  assert.deepEqual(config.pi.permissions, { readFiles: true, writeFiles: false, executeCommands: false });
  assert.equal(config.directory.contacts[0].name, "Test User");
  assert.equal(config.profileName, "Test bot");
  assert.equal(config.pi.sdkModule, f.sdk);
  for (const path of [f.profilePath, config.contactsFile, f.unit]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const calls = await recordedCalls(f);
  assert.deepEqual(calls.map(([command, args]) => [command, args[command === "systemctl" ? 1 : 0]]), [
    ["systemctl", "daemon-reload"], ["systemctl", "enable"], ["loginctl", "show-user"],
  ]);
  assert.ok(await stat(join(f.home, ".config/systemd/user/default.target.wants", f.unitName)));
  await assert.rejects(stat(config.sessionsDirectory), { code: "ENOENT" });
});

test("extension setup suggestions can be accepted with hidden terminal input", async (t) => {
  const f = await fixture(t); if (!f) return;
  const steps = firstSteps(f).map(([prompt, answer]) => {
    if (prompt === "Pi SDK entry point (dist/index.js)") return [`${prompt} [${f.sdk}]`, ""];
    if (prompt === "Pi agent directory") return [`${prompt} [${f.home}]`, ""];
    return [prompt, answer];
  });
  const output = runSetup(f, steps, ["--sdk-module", f.sdk, "--working-directory", f.home, "--agent-directory", f.home]);
  assert.ok(!output.includes("PTY_PRIVATE_TOKEN"));
  const config = await loadConfiguration(f.profilePath);
  assert.equal(config.pi.sdkModule, f.sdk);
  assert.equal(config.pi.workingDirectory, f.home);
  assert.equal(config.pi.agentDirectory, f.home);
  await assert.rejects(stat(config.sessionsDirectory), { code: "ENOENT" });
  assert.equal((await recordedCalls(f)).length, 3);
});

test("PTY setup adds multiple users and removes one only on final confirmation", async (t) => {
  const f = await fixture(t); if (!f) return;
  const steps = firstSteps(f);
  const index = steps.findIndex(([prompt]) => prompt === "Your numeric Telegram user ID") + 1;
  steps.splice(index, 1,
    ["Choice (number or cancel)", "2"],
    ["User name", "Bob"], ["Telegram user ID", "67890"],
    ["Choice (number or cancel)", "2"],
    ["User name", "Carol"], ["Telegram user ID", "33333"],
    ["Choice (number or cancel)", "3"],
    ["Choice (number or cancel)", "2"],
    ["Choice (number or cancel)", "1"],
  );
  const output = runSetup(f, steps);
  assert.ok(!output.includes("PTY_PRIVATE_TOKEN"));
  const config = await loadConfiguration(f.profilePath);
  assert.deepEqual(config.directory.contacts.map((user) => [user.name, user.endpoints[0].address]), [["Test User", "123456789"], ["Carol", "33333"]]);
});

test("annullamento interattivo non crea configurazione, rubrica o unità", async (t) => {
  const f = await fixture(t); if (!f) return;
  const output = runSetup(f, firstSteps(f, "no"));
  assert.match(output, /Setup cancelled/);
  assert.ok(!output.includes("PTY_PRIVATE_TOKEN"));
  for (const path of [f.path, f.profilePath, join(f.home, ".pi/communication/bots/123456/contacts.json"), f.unit, f.calls]) {
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
});

test("repeated PTY setup edits an existing profile without changing its token or contacts", async (t) => {
  const f = await fixture(t); if (!f) return;
  runSetup(f, firstSteps(f));
  const original = await readFile(f.profilePath, "utf8");
  const contactsPath = join(f.home, ".pi/communication/bots/123456/contacts.json");
  const contacts = await readFile(contactsPath, "utf8");
  let choices = 0;
  const editSteps = firstSteps(f).map(([prompt, answer]) => {
    if (prompt === "Choice (number or cancel)" && choices++ === 0) return [prompt, "2"];
    if (["BotFather token (hidden; Enter keeps existing): ", "Your name", "Your numeric Telegram user ID", "Profile name (optional)"].includes(prompt)) return [prompt, ""];
    return [prompt, answer];
  });
  editSteps.push(["Confirm? Type yes", "yes"]); // Separate automatic-startup choice.
  const output = runSetup(f, editSteps);
  assert.match(output, /Already configured/);
  assert.ok(!output.includes("PTY_PRIVATE_TOKEN"));
  assert.equal(await readFile(f.profilePath, "utf8"), original);
  assert.equal(await readFile(contactsPath, "utf8"), contacts);
  assert.equal((await recordedCalls(f)).length, 6);
  const cancelled = runSetup(f, firstSteps(f).slice(0, 2).concat([["Choice (number or cancel)", "cancel"]]));
  assert.match(cancelled, /Setup cancelled/);
  assert.equal((await recordedCalls(f)).length, 6);
});
