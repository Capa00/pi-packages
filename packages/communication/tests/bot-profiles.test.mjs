import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { botConfigPath, listBotProfiles, selectSetupProfile, selectExplicitSetupProfile, selectControlProfile, saveBotProfile } from "../src/service/profiles.mjs";
import { runGuidedSetup } from "../src/service/setup-flow.mjs";
import { prepareSetup, buildSetupDraft, saveSetup } from "../src/service/setup-editor.mjs";
import { validateToolPermissions, permittedToolNames } from "../src/config/tool-permissions.mjs";
import { loadConfiguration } from "../src/config/load.mjs";
import { checkConfiguration } from "../src/config/check.mjs";
import { PiSessions, loadSdk } from "../src/service/sessions.mjs";
import { unitLocation } from "../src/service/systemd.mjs";

const denied = { readFiles: false, writeFiles: false, executeCommands: false };
const full = { readFiles: true, writeFiles: true, executeCommands: true };
const sender = { channel: "telegram", address: "12345" };

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "pi-bot-profiles-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "communication/config.json"), agentDirectory = join(base, "agent"), sdkModule = join(base, "sdk.mjs");
  await mkdir(agentDirectory);
  await writeFile(sdkModule, 'throw new Error("No SDK import during setup");');
  const defaults = { sdkModule, agentDirectory };
  const create = (id, permissions = denied, extra = {}) => runGuidedSetup({ ui: {
    select: async (_title, choices) => choices[0], input: () => assert.fail("Bot ID must be derived from the token"),
  } }, { ...defaults, configPath: file, showForm: async () => ({ botToken: `${id}:PRIVATE_TOKEN`, name: "Alice", address: "12345", permissions }), startupOptions: { install: async () => ({ supported: false }) }, ...extra });
  return { base, file, defaults, create };
}

function fakeSdk() {
  const created = [], resources = [];
  return {
    created, resources,
    Type: { Object: (value) => value, String: (value) => value, Literal: (value) => value, Union: (value) => value, Optional: (value) => value },
    SettingsManager: { create: () => ({ getGlobalSettings: () => ({ defaultTools: ["bash", "write"], packages: ["untrusted"] }) }), inMemory: (value) => value },
    SessionManager: { continueRecent: (cwd, directory) => ({ cwd, directory }) },
    DefaultResourceLoader: class { constructor(options) { resources.push(options); } async reload() {} },
    async createAgentSession(options) {
      created.push(options);
      return { session: { async prompt() {}, getLastAssistantText: () => "OK", async abort() {}, dispose() {} } };
    },
  };
}

test("missing bot tool permissions deny access; invalid or unknown grants fail closed", () => {
  assert.deepEqual(validateToolPermissions(undefined), denied);
  assert.deepEqual(validateToolPermissions({ readFiles: true }), { ...denied, readFiles: true });
  for (const value of [null, [], { readFiles: "true" }, { executeCommands: 1 }, { root: true }]) assert.throws(() => validateToolPermissions(value));
  assert.deepEqual(permittedToolNames(undefined), []);
});

test("new managed bots have separate settings, contacts, sessions, workspaces, and units", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.create("100", full)).state, "configured");
  assert.equal((await f.create("200", { ...denied, readFiles: true })).state, "configured");
  const profiles = await listBotProfiles(f.file);
  assert.deepEqual(profiles.map((profile) => profile.id), ["100", "200"]);
  assert.doesNotMatch(JSON.stringify(profiles), /PRIVATE_TOKEN/);
  const [a, b] = await Promise.all(profiles.map((profile) => loadConfiguration(profile.configPath)));
  assert.deepEqual(a.pi.permissions, full);
  assert.deepEqual(b.pi.permissions, { ...denied, readFiles: true });
  for (const field of ["configFile", "contactsFile", "sessionsDirectory"]) assert.notEqual(a[field], b[field]);
  assert.notEqual(a.pi.workingDirectory, b.pi.workingDirectory);
  assert.notEqual(unitLocation(a).name, unitLocation(b).name);
  assert.notEqual(a.directory.contacts[0].id, b.directory.contacts[0].id);
  for (const config of [a, b]) {
    assert.equal((await checkConfiguration(config.configFile)).state, "valid");
    assert.equal((await stat(config.configFile)).mode & 0o777, 0o600);
    await assert.rejects(stat(config.sessionsDirectory), { code: "ENOENT" });
  }
});

test("editing changes only the selected bot permissions and preserves contacts and sessions", async (t) => {
  const f = await fixture(t);
  await f.create("100"); await f.create("200");
  const path = botConfigPath(f.file, "100"), other = botConfigPath(f.file, "200");
  const config = await loadConfiguration(path), otherBytes = await readFile(other, "utf8"), contactsBytes = await readFile(config.contactsFile, "utf8");
  await mkdir(config.sessionsDirectory);
  await writeFile(join(config.sessionsDirectory, "keep.txt"), "SESSION");
  let current;
  const result = await runGuidedSetup({ ui: {
    select: async (_title, choices) => choices.find((choice) => choice.startsWith("Edit") && choice.includes("100")), confirm: async () => false,
  } }, { ...f.defaults, configPath: f.file, showForm: async (_ctx, value) => { current = value; return { permissions: full }; } });
  assert.equal(result.state, "configured");
  assert.equal(current.botId, "100");
  assert.equal(current.hasToken, true);
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE_TOKEN/);
  assert.deepEqual((await loadConfiguration(path)).pi.permissions, full);
  assert.equal(await readFile(other, "utf8"), otherBytes);
  assert.equal(await readFile(config.contactsFile, "utf8"), contactsBytes);
  assert.equal(await readFile(join(config.sessionsDirectory, "keep.txt"), "utf8"), "SESSION");
});

test("legacy default profile remains editable without moving its data", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSetup(f.file, f.defaults);
  await saveSetup(prepared, buildSetupDraft(prepared, { botToken: "100:PRIVATE_TOKEN", name: "Alice", address: "12345" }));
  const profiles = await listBotProfiles(f.file);
  assert.equal(profiles[0].configPath, f.file);
  const selected = await selectSetupProfile({ ui: { select: async (_title, choices) => choices[1] } }, f.file);
  assert.equal(selected.id, "100");
  assert.equal(selected.creating, false);
  assert.equal((await f.create("100")).state, "error");
  assert.equal((await listBotProfiles(f.file)).length, 1);
  await assert.rejects(stat(botConfigPath(f.file, "100")), { code: "ENOENT" });
});

test("profile names persist, appear in menus, and rename without moving data", async (t) => {
  const f = await fixture(t);
  await f.create("100"); await f.create("200");
  const path = botConfigPath(f.file, "100");
  const before = await loadConfiguration(path);
  const contacts = await readFile(before.contactsFile, "utf8");
  await mkdir(before.sessionsDirectory);
  await writeFile(join(before.sessionsDirectory, "keep.txt"), "SESSION");
  for (const profileName of ["Work", "Personal", ""]) {
    const prepared = await prepareSetup(path, f.defaults);
    await saveSetup(prepared, buildSetupDraft(prepared, { profileName }));
    const config = await loadConfiguration(path);
    assert.equal(config.profileName, profileName || undefined);
    assert.equal(config.sessionsDirectory, before.sessionsDirectory);
    assert.equal(config.pi.workingDirectory, before.pi.workingDirectory);
    assert.equal(unitLocation(config).name, unitLocation(before).name);
    assert.equal(await readFile(config.contactsFile, "utf8"), contacts);
    assert.equal(await readFile(join(config.sessionsDirectory, "keep.txt"), "utf8"), "SESSION");
    const profiles = await listBotProfiles(f.file);
    assert.equal(profiles[0].label, `${profileName ? `${profileName} · ` : ""}Telegram bot 100`);
    assert.equal(await selectControlProfile({ hasUI: true, ui: { select: async (_title, choices) => choices[0] } }, f.file), path);
  }
  const prepared = await prepareSetup(path, f.defaults);
  for (const profileName of ["x".repeat(81), "bad\u001bname", "bad\nname"]) {
    assert.throws(() => buildSetupDraft(prepared, { profileName }), /Profile name/);
  }
  const raw = JSON.parse(await readFile(path, "utf8"));
  for (const profileName of [42, null, " bad", "bad\u001bname", "x".repeat(81)]) {
    await writeFile(path, JSON.stringify({ ...raw, profileName }));
    await assert.rejects(loadConfiguration(path), /Profile name/);
    await assert.rejects(listBotProfiles(f.file), /invalid bot configuration/);
    await assert.rejects(prepareSetup(path, f.defaults), /cannot be safely edited/);
  }
});

test("creation derives identity from the token; duplicates and token reassignment are rejected", async (t) => {
  const f = await fixture(t);
  const created = await f.create("100", denied, { showForm: async () => ({ botToken: "200:PRIVATE_TOKEN", name: "Alice", address: "12345" }) });
  assert.equal(created.state, "configured");
  assert.equal((await listBotProfiles(f.file))[0].id, "200");
  await assert.rejects(stat(botConfigPath(f.file, "100")), { code: "ENOENT" });
  await f.create("100");
  const original = await readFile(botConfigPath(f.file, "100"), "utf8");
  assert.equal((await f.create("100")).state, "error");
  assert.equal(await readFile(botConfigPath(f.file, "100"), "utf8"), original);
  const prepared = await prepareSetup(botConfigPath(f.file, "100"), f.defaults);
  assert.throws(() => buildSetupDraft(prepared, { botToken: "200:PRIVATE_TOKEN" }), /different bot/);
  const rotated = buildSetupDraft(prepared, { botToken: "100:ROTATED_TOKEN" });
  assert.equal(JSON.parse(rotated.configText).telegram.botToken, "100:ROTATED_TOKEN");
});

test("profile selection cancellation and invalid IDs do not write files", async (t) => {
  const f = await fixture(t);
  const result = await runGuidedSetup({ ui: { select: async () => undefined } }, { ...f.defaults, configPath: f.file, showForm: () => assert.fail() });
  assert.equal(result.state, "cancelled");
  for (const id of ["", "0", "001", "../other", "@bot", "123:SECRET"]) assert.throws(() => botConfigPath(f.file, id));
  await assert.rejects(stat(join(f.base, "communication")), { code: "ENOENT" });
});

test("token-derived creation cancels safely and rejects invalid tokens before writing", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.create("100", denied, { showForm: async () => undefined })).state, "cancelled");
  for (const botToken of ["", "0:SECRET", "001:SECRET", "../other:SECRET"]) {
    const result = await f.create("100", denied, { showForm: async () => ({ botToken, name: "Alice", address: "12345" }) });
    assert.equal(result.state, "error");
    assert.doesNotMatch(result.message, /SECRET/);
  }
  const invalidHost = await f.create("100", denied, { sdkModule: "/missing", showForm: () => assert.fail("Host validation must precede token entry") });
  assert.equal(invalidHost.state, "error");
  await assert.rejects(stat(join(f.base, "communication")), { code: "ENOENT" });
});

test("controls select the intended bot and noninteractive multi-bot use fails rather than guessing", async (t) => {
  const f = await fixture(t);
  assert.equal(await selectControlProfile({}, f.file), f.file);
  await f.create("100");
  assert.equal(await selectControlProfile({}, f.file), botConfigPath(f.file, "100"));
  await f.create("200");
  await assert.rejects(selectControlProfile({ hasUI: false }, f.file), /multiple bots/);
  assert.equal(await selectControlProfile({ hasUI: true, ui: { select: async (_title, choices) => choices[1] } }, f.file), botConfigPath(f.file, "200"));
  assert.equal(await selectControlProfile({ hasUI: true, ui: { select: async () => undefined } }, f.file), undefined);
});

test("profile commit rejects a newly duplicated ID and clears its own lock", async (t) => {
  const f = await fixture(t); await f.create("100");
  await assert.rejects(saveBotProfile(f.file, { id: "100", configPath: botConfigPath(f.file, "100"), creating: true }, () => assert.fail()), /already configured/);
  await assert.rejects(stat(join(dirname(f.file), ".profiles-edit.lock")), { code: "ENOENT" });
});

test("unsafe profile directories and duplicate configuration identities are rejected", async (t) => {
  const f = await fixture(t); await f.create("100");
  const copied = botConfigPath(f.file, "200");
  await mkdir(dirname(copied));
  await writeFile(copied, await readFile(botConfigPath(f.file, "100")), { mode: 0o600 });
  await assert.rejects(listBotProfiles(f.file), /does not match/);
  await rm(dirname(copied), { recursive: true });
  await symlink(dirname(botConfigPath(f.file, "100")), dirname(copied));
  await assert.rejects(listBotProfiles(f.file), /symlinks/);
});

test("configuration rejects malformed bot tool permissions without exposing secrets", async (t) => {
  const f = await fixture(t); await f.create("100");
  const path = botConfigPath(f.file, "100"), raw = JSON.parse(await readFile(path, "utf8"));
  raw.pi.permissions = { executeCommands: "PRIVATE_TOKEN" };
  await writeFile(path, JSON.stringify(raw));
  await assert.rejects(loadConfiguration(path), (error) => /permissions/.test(error.message) && !error.message.includes("PRIVATE_TOKEN"));
  const checked = await checkConfiguration(path);
  assert.equal(checked.state, "invalid");
  assert.doesNotMatch(JSON.stringify(checked), /PRIVATE_TOKEN/);
});

test("all eight permission combinations select exactly their tools and keep host resources disabled", async (t) => {
  const f = await fixture(t); await f.create("100");
  const config = await loadConfiguration(botConfigPath(f.file, "100"));
  for (let bits = 0; bits < 8; bits++) {
    const permissions = { readFiles: Boolean(bits & 1), writeFiles: Boolean(bits & 2), executeCommands: Boolean(bits & 4) };
    const sdk = fakeSdk();
    const sessions = new PiSessions({ ...config, pi: { ...config.pi, permissions } }, sdk, {});
    try {
      await sessions.reply(config.directory.contacts[0].id, "Test", sender);
      assert.deepEqual(sdk.created[0].tools, [...permittedToolNames(permissions), "communication_contacts", "communication_prepare_send"]);
      assert.equal(sdk.created[0].noTools, "all");
      assert.deepEqual(sdk.created[0].settingsManager.defaultTools, []);
      assert.deepEqual(sdk.created[0].settingsManager.packages, []);
      assert.equal(sdk.resources[0].noExtensions, true);
      assert.equal(sdk.resources[0].noSkills, true);
      assert.equal(sdk.resources[0].noPromptTemplates, true);
      assert.match(sdk.resources[0].appendSystemPrompt.join(" "), /Computer tools enabled for this bot/);
      if (bits) await assert.rejects(sessions.reply(config.directory.contacts[0].id, "Unauthorized"), /autorizzato/);
    } finally { await sessions.close(); }
  }
});

test("explicit CLI setup targets exactly its config file instead of silently creating a nested profile", async (t) => {
  const f = await fixture(t);
  const ctx = { ui: { select: async (_title, choices) => choices[0], input: () => assert.fail("No separate bot ID prompt") } };
  const selected = await selectExplicitSetupProfile(ctx, f.file);
  assert.equal(selected.configPath, f.file);
  assert.equal(selected.creating, true);
  const result = await f.create("100", full, { selectProfile: () => selected });
  assert.equal(result.state, "configured");
  assert.equal((await selectExplicitSetupProfile(ctx, f.file)).creating, false);
  await assert.rejects(stat(botConfigPath(f.file, "100")), { code: "ENOENT" });
});

test("concurrent managed profile commits cannot bypass duplicate checking", async (t) => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const selected = { id: "100", configPath: botConfigPath(f.file, "100"), creating: true };
  const first = saveBotProfile(f.file, selected, async () => { enter(); await gate; return "saved"; });
  await entered;
  await assert.rejects(saveBotProfile(f.file, selected, () => assert.fail()), /another profile edit/);
  release();
  assert.equal(await first, "saved");
  await assert.rejects(stat(join(dirname(f.file), ".profiles-edit.lock")), { code: "ENOENT" });
});

test("real host SDK exposes exactly the configured bot tools without model or network calls", { skip: !process.env.PI_COMMUNICATION_TEST_SDK }, async (t) => {
  const f = await fixture(t); await f.create("100");
  const config = await loadConfiguration(botConfigPath(f.file, "100"));
  config.pi.sdkModule = process.env.PI_COMMUNICATION_TEST_SDK;
  const sdk = await loadSdk(config);
  const created = [];
  const wrapped = { ...sdk, async createAgentSession(options) {
    const result = await sdk.createAgentSession(options);
    created.push(result.session);
    // Exercise the real factory and tool registry, never prompt a model.
    result.session.prompt = async () => {};
    result.session.getLastAssistantText = () => "OK";
    return result;
  } };
  for (const permissions of [denied, { ...denied, readFiles: true }, { ...denied, writeFiles: true }, { ...denied, executeCommands: true }, full]) {
    const sessions = new PiSessions({ ...config, pi: { ...config.pi, permissions } }, wrapped, {});
    try {
      await sessions.reply(config.directory.contacts[0].id, "Test", sender);
      assert.deepEqual(created.at(-1).getActiveToolNames().sort(), [...permittedToolNames(permissions), "communication_contacts", "communication_prepare_send"].sort());
    } finally { await sessions.close(); }
  }
});
