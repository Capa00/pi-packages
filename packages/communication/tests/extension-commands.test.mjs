import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandArguments, hostSdkPath, registerCommunicationCommands, runTerminalSetup } from "../src/service/extension-commands.mjs";

function harness(options = {}) {
  const commands = new Map();
  const executions = [];
  const notifications = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    async exec(node, args, settings) { executions.push({ node, args, settings }); return { code: 0, stdout: "Verified output", stderr: "" }; },
  };
  registerCommunicationCommands(pi, options);
  const ctx = { cwd: "/tmp/work with spaces", mode: "tui", hasUI: true, ui: { notify(text, level) { notifications.push({ text, level }); } } };
  return { command: commands.get("communication"), executions, notifications, ctx, pi };
}

test("loading registers a user command without starting a process", () => {
  const h = harness();
  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.command.getArgumentCompletions("st").map((item) => item.value), ["start", "status", "stop"]);
});

test("commands invoke the included absolute CLI path without a shell or PATH lookup", async () => {
  const h = harness();
  for (const action of ["check", "start", "status", "stop"]) await h.command.handler(action, h.ctx);
  assert.equal(h.executions.length, 4);
  for (const call of h.executions) {
    assert.equal(call.node, process.execPath);
    assert.equal(call.args[0], fileURLToPath(new URL("../src/service/cli.mjs", import.meta.url)));
    assert.equal(call.settings.cwd, h.ctx.cwd);
  }
  assert.deepEqual(h.executions[1].args.slice(1), ["start", "--background"]);
  assert.equal(h.notifications.length, 4);
});

test("invalid arguments cannot inject commands, tokens, or foreground startup", async () => {
  const h = harness();
  for (const value of ["", "start --foreground", "setup SECRET", "status; touch /tmp/unwanted", "--help"]) await h.command.handler(value, h.ctx);
  assert.equal(h.executions.length, 0);
  assert.ok(h.notifications.every(({ text }) => text.startsWith("Usage:")));
});

test("setup refuses RPC and print modes without starting anything", async () => {
  const h = harness({ terminalSetup() { assert.fail("must not run"); } });
  for (const mode of ["rpc", "print"]) await h.command.handler("setup", { ...h.ctx, mode });
  assert.equal(h.executions.length, 0);
  assert.match(h.notifications[0].text, /interactive pi terminal/);
});

test("setup defaults are suggestions passed as separate arguments, never secrets", () => {
  assert.deepEqual(commandArguments("setup", { sdkModule: "/host/sdk.js", workingDirectory: "/work with spaces", agentDirectory: "/agent" }).slice(1),
    ["setup", "--sdk-module", "/host/sdk.js", "--working-directory", "/work with spaces", "--agent-directory", "/agent"]);
  assert.equal(hostSdkPath(undefined), undefined);
  assert.equal(hostSdkPath("/nonexistent/host.js"), undefined);
});

test("terminal ownership and rendering are restored after success or spawn failure", () => {
  for (const throws of [false, true]) {
    const events = [];
    const tui = { stop() { events.push("stop"); }, start() { events.push("start"); }, requestRender(force) { assert.equal(force, true); events.push("render"); } };
    const invoke = () => runTerminalSetup(tui, ["cli.mjs", "setup"], {
      write() { events.push("clear"); },
      spawn(node, args, options) {
        assert.equal(node, process.execPath);
        assert.deepEqual(args, ["cli.mjs", "setup"]);
        assert.deepEqual(options, { stdio: "inherit", shell: false });
        if (throws) throw new Error("PRIVATE ERROR");
        return { status: 0 };
      },
    });
    if (throws) assert.throws(invoke); else assert.equal(invoke(), 0);
    assert.deepEqual(events, ["stop", "clear", "clear", "start", "render"]);
  }
});

test("interactive setup waits for idle and forwards host defaults without model messages", async () => {
  const descriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  try {
    let setupArgs;
    const h = harness({ agentDirectory: "/host/agent", sdkModule: "/host/sdk.js", terminalSetup(_tui, args) { setupArgs = args; return 0; } });
    let waited = false;
    h.ctx.waitForIdle = async () => { waited = true; };
    h.ctx.ui.custom = async (factory) => { let result; factory({}, {}, {}, (code) => { result = code; }); return result; };
    await h.command.handler("setup", h.ctx);
    assert.equal(waited, true);
    assert.ok(setupArgs.includes("/host/agent"));
    assert.ok(setupArgs.includes("/host/sdk.js"));
    assert.ok(setupArgs.includes(h.ctx.cwd));
    assert.equal(h.executions.length, 0);
    assert.match(h.notifications[0].text, /bot was not started/);
  } finally {
    [process.stdin, process.stdout].forEach((stream, index) => {
      if (descriptors[index]) Object.defineProperty(stream, "isTTY", descriptors[index]); else delete stream.isTTY;
    });
  }
});

test("concurrent control commands are rejected until the current operation finishes", async () => {
  const h = harness();
  let complete;
  h.pi.exec = () => new Promise((resolve) => { complete = resolve; });
  const pending = h.command.handler("status", h.ctx);
  await h.command.handler("stop", h.ctx);
  assert.match(h.notifications[0].text, /already running/);
  complete({ code: 0, stdout: "done", stderr: "" });
  await pending;
});

test("raw execution errors are not exposed", async () => {
  const h = harness();
  h.pi.exec = async () => { throw new Error("SECRET"); };
  await h.command.handler("status", h.ctx);
  assert.doesNotMatch(h.notifications[0].text, /SECRET/);
});

test("setup-only default flags are rejected on other CLI commands", () => {
  const cli = fileURLToPath(new URL("../src/service/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "status", "--sdk-module", "/private"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Argomenti non validi/);
});
