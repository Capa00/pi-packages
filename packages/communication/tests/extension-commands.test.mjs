import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandArguments, hostSdkPath, registerCommunicationCommands } from "../src/service/extension-commands.mjs";

function harness(options = {}) {
  const commands = new Map(), executions = [], notifications = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    async exec(node, args, settings) { executions.push({ node, args, settings }); return { code: 0, stdout: "Verified output", stderr: "" }; },
  };
  registerCommunicationCommands(pi, { configPath: "/tmp/test-bot/config.json", selectProfile: async (_ctx, path) => path, ...options });
  const ctx = { cwd: "/tmp/work with spaces", mode: "tui", hasUI: true, waitForIdle: async () => {}, ui: { notify(text, level) { notifications.push({ text, level }); } } };
  return { command: commands.get("communication"), executions, notifications, ctx, pi };
}

test("loading registers commands without a process or setup", () => {
  const h = harness();
  assert.equal(h.executions.length, 0);
  assert.deepEqual(h.command.getArgumentCompletions("st").map((item) => item.value), ["start", "status", "stop"]);
});

test("service controls use the included absolute CLI without a shell or PATH lookup", async () => {
  const h = harness();
  for (const action of ["start", "status", "stop"]) await h.command.handler(action, h.ctx);
  assert.equal(h.executions.length, 3);
  for (const call of h.executions) {
    assert.equal(call.node, process.execPath);
    assert.equal(call.args[0], fileURLToPath(new URL("../src/service/cli.mjs", import.meta.url)));
    assert.equal(call.settings.cwd, h.ctx.cwd);
  }
  assert.deepEqual(h.executions[0].args.slice(1), ["start", "--background", "--config", "/tmp/test-bot/config.json"]);
});

test("invalid arguments cannot inject commands or token values", async () => {
  const h = harness();
  for (const value of ["", "start --foreground", "setup SECRET", "status; touch /tmp/unwanted", "--help"]) await h.command.handler(value, h.ctx);
  assert.equal(h.executions.length, 0);
  assert.ok(h.notifications.every(({ text }) => text.startsWith("Usage:")));
});

test("setup refuses non-TUI modes", async () => {
  const h = harness({ setup() { assert.fail("must not run"); } });
  for (const mode of ["rpc", "print", "json"]) await h.command.handler("setup", { ...h.ctx, mode });
  assert.equal(h.executions.length, 0);
  assert.match(h.notifications[0].text, /interactive pi terminal/);
});

test("setup waits for idle and passes detected host data without subprocesses", async () => {
  let waited = false, received;
  const showForm = () => {};
  const h = harness({ agentDirectory: "/host/agent", sdkModule: "/host/sdk.js", showForm,
    setup: async (_ctx, options) => { assert.equal(waited, true); received = options; return { state: "cancelled", message: "Setup cancelled." }; } });
  h.ctx.waitForIdle = async () => { waited = true; };
  await h.command.handler("setup", h.ctx);
  assert.equal(received.sdkModule, "/host/sdk.js");
  assert.equal(received.agentDirectory, "/host/agent");
  assert.equal(received.showForm, showForm);
  assert.equal(received.workingDirectory, undefined);
  assert.equal(h.executions.length, 0);
  assert.equal(h.notifications[0].text, "Setup cancelled.");
});

test("setup preserves cancellation, error, and partial-startup outcomes", async () => {
  for (const result of [{ state: "cancelled", message: "Cancelled" }, { state: "error", message: "Could not save" }, { state: "configured", warning: true, message: "Saved, startup unavailable" }]) {
    const h = harness({ setup: async () => result });
    await h.command.handler("setup", h.ctx);
    assert.equal(h.notifications[0].text, result.message);
    assert.equal(h.notifications[0].level, result.state === "error" ? "error" : result.warning ? "warning" : "info");
  }
});

test("check distinguishes absence, independent errors, and valid local configuration", async () => {
  for (const result of [{ state: "missing" }, { state: "invalid", errors: ["Token format invalid", "Contacts file missing"] }, { state: "valid", config: { directory: { contacts: [{}] } } }]) {
    const h = harness({ check: async () => result });
    await h.command.handler("check", h.ctx);
    assert.equal(h.executions.length, 0);
    assert.match(h.notifications[0].text, result.state === "missing" ? /Run \/communication setup/ : result.state === "invalid" ? /Token format invalid[\s\S]*Contacts file missing/ : /Configuration is valid/);
  }
});

test("concurrent controls are rejected", async () => {
  const h = harness();
  let complete;
  h.pi.exec = () => new Promise((resolve) => { complete = resolve; });
  const pending = h.command.handler("status", h.ctx);
  await h.command.handler("stop", h.ctx);
  assert.match(h.notifications[0].text, /already running/);
  await new Promise((resolve) => setImmediate(resolve));
  complete({ code: 0, stdout: "done", stderr: "" });
  await pending;
});

test("raw execution errors are not exposed", async () => {
  const h = harness();
  h.pi.exec = async () => { throw new Error("SECRET"); };
  await h.command.handler("status", h.ctx);
  assert.doesNotMatch(h.notifications[0].text, /SECRET/);
});

test("invalid host paths have no implicit global fallback", () => {
  assert.equal(hostSdkPath("/nonexistent/host.js"), undefined);
  assert.equal(commandArguments("unrecognized"), undefined);
  assert.equal(commandArguments("setup", { sdkModule: "/host/sdk.js" }), undefined);
});

test("setup-only default flags are rejected on other CLI commands", () => {
  const cli = fileURLToPath(new URL("../src/service/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "status", "--sdk-module", "/private"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Argomenti non validi/);
});
