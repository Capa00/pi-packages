import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, rename, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSetup, buildSetupDraft, saveSetup, configureStartup } from "../src/service/setup-editor.mjs";
import { runGuidedSetup as guidedSetup } from "../src/service/setup-flow.mjs";
const runGuidedSetup = (ctx, options) => guidedSetup(ctx, { selectProfile: async () => ({ configPath: options.configPath, id: "123", creating: false }), ...options });
import { checkConfiguration, formatConfigurationCheck } from "../src/config/check.mjs";

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "pi-setup-editor-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agent = join(base, "agent"), sdk = join(base, "sdk.mjs"), file = join(base, "communication/config.json");
  await mkdir(agent);
  await writeFile(sdk, 'throw new Error("SDK must not be imported during setup");');
  const defaults = { sdkModule: sdk, agentDirectory: agent };
  const prepare = () => prepareSetup(file, defaults);
  const initial = async () => {
    const prepared = await prepare();
    return saveSetup(prepared, buildSetupDraft(prepared, { botToken: "123:PRIVATE_TOKEN", name: "Alice", address: "12345" }));
  };
  return { base, agent, sdk, file, defaults, prepare, initial, contacts: join(base, "communication/contacts.json") };
}

test("preflight detects host paths without asking for or saving a token", async (t) => {
  const f = await fixture(t);
  const p = await f.prepare();
  assert.equal(p.current.hasToken, false);
  assert.equal(p.pi.workingDirectory, join(f.base, "communication/workspace"));
  await assert.rejects(stat(join(f.base, "communication")), { code: "ENOENT" });
  await assert.rejects(prepareSetup(f.file, { ...f.defaults, sdkModule: "/missing" }), /before entering a token/);
});

test("new setup generates a stable internal ID and private files, without creating sessions", async (t) => {
  const f = await fixture(t);
  const result = await f.initial();
  assert.equal(result.state, "configured");
  assert.match(result.config.directory.contacts[0].id, /^self-/);
  for (const file of [f.file, f.contacts]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(result.config.pi.workingDirectory)).mode & 0o777, 0o700);
  await assert.rejects(stat(result.config.sessionsDirectory), { code: "ENOENT" });
  assert.equal((await checkConfiguration(f.file)).state, "valid");
});

test("empty values preserve current values and exact source bytes", async (t) => {
  const f = await fixture(t);
  const first = await f.initial();
  const before = await Promise.all([readFile(f.file, "utf8"), readFile(f.contacts, "utf8")]);
  const p = await f.prepare();
  const result = await saveSetup(p, buildSetupDraft(p, { botToken: "", name: "", address: "" }));
  assert.equal(result.state, "unchanged");
  assert.equal(result.config.directory.contacts[0].id, first.config.directory.contacts[0].id);
  assert.deepEqual(await Promise.all([readFile(f.file, "utf8"), readFile(f.contacts, "utf8")]), before);
});

test("editing preserves other contacts, aliases, channels, permissions, sessions, and stable identity", async (t) => {
  const f = await fixture(t);
  const first = await f.initial();
  const directory = JSON.parse(await readFile(f.contacts, "utf8"));
  directory.contacts[0].aliases.push("Owner");
  directory.contacts[0].endpoints[0].permissions.canRequestSendMessages = false;
  directory.contacts[0].endpoints.push({ channel: "discord", address: "abc", permissions: {} });
  const bob = { id: "bob", name: "Bob", aliases: ["B"], endpoints: [{ channel: "telegram", address: "67890", permissions: {} }] };
  directory.contacts.push(bob);
  await writeFile(f.contacts, JSON.stringify(directory));
  await mkdir(first.config.sessionsDirectory);
  await writeFile(join(first.config.sessionsDirectory, "keep.txt"), "SESSION");
  const p = await f.prepare();
  const result = await saveSetup(p, buildSetupDraft(p, { botToken: "123:NEW_SECRET", name: "Alice New", address: "22222" }), { status: async () => ({ state: "running" }) });
  assert.equal(result.restartRequired, true);
  assert.equal(result.config.telegram.botToken, "123:NEW_SECRET");
  assert.equal(result.config.directory.contacts[0].id, first.config.directory.contacts[0].id);
  const updated = JSON.parse(await readFile(f.contacts, "utf8"));
  assert.deepEqual(updated.contacts[1], bob);
  assert.deepEqual(updated.contacts[0].aliases, ["Owner"]);
  assert.equal(updated.contacts[0].endpoints[0].permissions.canRequestSendMessages, false);
  assert.deepEqual(updated.contacts[0].endpoints[1], directory.contacts[0].endpoints[1]);
  assert.equal(await readFile(join(first.config.sessionsDirectory, "keep.txt"), "utf8"), "SESSION");
  await assert.rejects(stat(join(f.base, "communication/.setup-edit.lock")), { code: "ENOENT" });
});

test("duplicate endpoint changes and stale snapshots cannot overwrite other contacts", async (t) => {
  const f = await fixture(t);
  await f.initial();
  const p = await f.prepare();
  await writeFile(f.contacts, p.contactsText + "\n");
  await assert.rejects(saveSetup(p, buildSetupDraft(p, { name: "New" })), /changed while setup was open/);
  const directory = JSON.parse(await readFile(f.contacts, "utf8"));
  directory.contacts.push({ id: "bob", name: "Bob", aliases: [], endpoints: [{ channel: "telegram", address: "67890", permissions: {} }] });
  await writeFile(f.contacts, JSON.stringify(directory));
  const next = await f.prepare();
  assert.throws(() => buildSetupDraft(next, { address: "67890" }), /duplicates another Telegram ID/);
});

test("failed second commit rolls back the first commit without exposing secrets", async (t) => {
  const f = await fixture(t);
  await f.initial();
  const p = await f.prepare();
  const before = [p.configText, p.contactsText];
  await assert.rejects(saveSetup(p, buildSetupDraft(p, { name: "Changed", botToken: "123:NEW_SECRET" }), {
    move: async (source, target) => { if (target === f.file) throw new Error("PRIVATE_TOKEN disk failure"); await rename(source, target); },
  }), (error) => !error.message.includes("PRIVATE_TOKEN") && /retained/.test(error.message));
  assert.deepEqual(await Promise.all([readFile(f.file, "utf8"), readFile(f.contacts, "utf8")]), before);
});

test("failed initial configuration commit removes the newly written contacts", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const draft = buildSetupDraft(prepared, { botToken: "123:PRIVATE_TOKEN", name: "Alice", address: "12345" });
  await assert.rejects(saveSetup(prepared, draft, {
    move: async (source, target) => {
      if (target === f.file) throw new Error("PRIVATE_TOKEN disk failure");
      await rename(source, target);
    },
  }), (error) => /retained/.test(error.message) && !error.message.includes("PRIVATE_TOKEN"));
  for (const path of [f.file, f.contacts, join(f.base, "communication/.setup-edit.lock")]) {
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
});

test("cancellation performs no writes, no automatic-startup calls, and no fake success", async (t) => {
  const f = await fixture(t);
  const result = await runGuidedSetup({ ui: {} }, { ...f.defaults, configPath: f.file, showForm: async (_ctx, current) => {
    assert.deepEqual(Object.keys(current).sort(), ["address", "automaticStartup", "botId", "existing", "hasToken", "name", "permissions", "profileName", "users"]);
    return undefined;
  }, startupOptions: { install: () => assert.fail("must not run") } });
  assert.equal(result.state, "cancelled");
  assert.match(result.message, /cancelled/);
  await assert.rejects(stat(join(f.base, "communication")), { code: "ENOENT" });
});

test("invalid host fails before the form opens", async (t) => {
  const f = await fixture(t);
  const result = await runGuidedSetup({}, { configPath: f.file, sdkModule: "/missing", agentDirectory: f.agent, showForm: () => assert.fail("must not ask token") });
  assert.equal(result.state, "error");
  assert.match(result.message, /before entering a token/);
});

test("saved configuration and failed automatic startup are reported separately", async (t) => {
  const f = await fixture(t);
  const result = await runGuidedSetup({ ui: {} }, { ...f.defaults, configPath: f.file, showForm: async () => ({ botToken: "123:PRIVATE_TOKEN", name: "Alice", address: "12345" }), startupOptions: { install: async () => { throw new Error("SECRET"); } } });
  assert.equal(result.state, "configured");
  if (process.platform === "linux") { assert.equal(result.warning, true); assert.match(result.message, /saved, but automatic startup/); }
  assert.equal((await checkConfiguration(f.file)).state, "valid");
  assert.doesNotMatch(result.message, /PRIVATE_TOKEN|SECRET/);
});

test("existing startup is a separate explicit choice and never starts a service", async (t) => {
  const f = await fixture(t);
  await f.initial();
  let requested = false;
  const result = await runGuidedSetup({ ui: { confirm: async () => { requested = true; return false; } } }, { ...f.defaults, configPath: f.file, showForm: async () => ({}), startupOptions: { install: () => assert.fail("declined startup") } });
  assert.equal(result.state, "unchanged");
  if (process.platform === "linux") assert.equal(requested, true);
});

test("check distinguishes absence and multiple errors without printing file contents", async (t) => {
  const f = await fixture(t);
  assert.equal((await checkConfiguration(f.file)).state, "missing");
  await f.initial();
  const raw = JSON.parse(await readFile(f.file, "utf8"));
  raw.telegram.botToken = "PRIVATE_TOKEN";
  raw.pi.sdkModule = "/missing/sdk";
  raw.pi.agentDirectory = "/missing/agent";
  await writeFile(f.file, JSON.stringify(raw));
  await writeFile(f.contacts, "BROKEN_PRIVATE_JSON");
  const checked = await checkConfiguration(f.file);
  assert.equal(checked.state, "invalid");
  assert.ok(checked.errors.length >= 4);
  assert.doesNotMatch(formatConfigurationCheck(checked), /PRIVATE_TOKEN|BROKEN_PRIVATE_JSON/);
  await assert.rejects(f.prepare(), /cannot be safely edited[\s\S]*\/communication check/);
});

test("setup refuses symlinks and insecure files without modifying them", async (t) => {
  const f = await fixture(t);
  await f.initial();
  if (process.platform !== "win32") {
    await chmod(f.contacts, 0o644);
    await assert.rejects(f.prepare(), /private permissions/);
    await chmod(f.contacts, 0o600);
  }
  const original = await readFile(f.file, "utf8");
  await rename(f.file, f.file + ".original");
  await symlink(f.file + ".original", f.file);
  await assert.rejects(f.prepare(), /symlinks/);
  assert.equal(await readFile(f.file, "utf8"), original);
});

test("user management adds and removes Telegram access while preserving other data", async (t) => {
  const f = await fixture(t);
  const initial = await f.initial();
  const directory = JSON.parse(await readFile(f.contacts, "utf8"));
  const alice = directory.contacts[0];
  alice.aliases = ["Owner"];
  alice.endpoints[0].permissions.canRequestSendMessages = false;
  alice.endpoints.push({ channel: "discord", address: "keep", permissions: {} });
  directory.contacts.push({ id: "other", name: "Other", aliases: [], endpoints: [{ channel: "slack", address: "keep", permissions: {} }] });
  await writeFile(f.contacts, JSON.stringify(directory));
  await mkdir(initial.config.sessionsDirectory);
  await writeFile(join(initial.config.sessionsDirectory, "keep.txt"), "SESSION");
  let p = await f.prepare();
  assert.equal(p.current.users[0].id, alice.id);
  const added = await saveSetup(p, buildSetupDraft(p, { users: [...p.current.users, { name: "Bob", address: "67890" }] }));
  assert.deepEqual(JSON.parse(await readFile(f.contacts, "utf8")).contacts[0], alice);
  const bob = added.config.directory.contacts.find((item) => item.name === "Bob");
  assert.deepEqual(bob.endpoints[0].permissions, { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true });
  p = await f.prepare();
  await saveSetup(p, buildSetupDraft(p, { users: p.current.users.filter((item) => item.id === bob.id) }));
  const after = JSON.parse(await readFile(f.contacts, "utf8"));
  const retained = { ...alice, endpoints: [alice.endpoints[1]] };
  delete retained.preferredChannel;
  assert.deepEqual(after.contacts.find((item) => item.id === alice.id), retained);
  assert.deepEqual(after.contacts.find((item) => item.id === "other"), directory.contacts[1]);
  assert.equal(await readFile(join(initial.config.sessionsDirectory, "keep.txt"), "utf8"), "SESSION");
  p = await f.prepare();
  const unchanged = await saveSetup(p, buildSetupDraft(p, { users: p.current.users }));
  assert.equal(unchanged.state, "unchanged");
  p = await f.prepare();
  await saveSetup(p, buildSetupDraft(p, { users: [{ name: "Carol", address: "33333" }] }));
  assert.ok(!JSON.parse(await readFile(f.contacts, "utf8")).contacts.some((item) => item.id === bob.id));
});

test("user management rejects invalid lists and respects stale snapshots and rollback", async (t) => {
  const f = await fixture(t);
  await f.initial();
  const p = await f.prepare();
  for (const users of [null, [], [{ name: "Bob", address: "@bob" }], [{ name: "Bob", address: "0" }], [{ id: "unknown", name: "Bob", address: "22222" }], [...p.current.users, { name: "Duplicate", address: "12345" }], [{ name: "Bob", address: "22222", permissions: {} }]]) {
    assert.throws(() => buildSetupDraft(p, { users }));
  }
  const draft = buildSetupDraft(p, { profileName: "Changed", users: [{ name: "Bob", address: "22222" }] });
  await assert.rejects(saveSetup(p, draft, { move: async (source, target) => {
    if (target === f.file) throw new Error("disk failure");
    await rename(source, target);
  } }), /retained/);
  assert.equal(await readFile(f.contacts, "utf8"), p.contactsText);
  await writeFile(f.contacts, p.contactsText + "\n");
  await assert.rejects(saveSetup(p, draft), /changed while setup was open/);
});

test("automatic-startup helper never forwards raw errors", async () => {
  const result = await configureStartup({}, { install: async () => { throw new Error("SECRET"); } });
  assert.equal(result.state, "failed");
  assert.doesNotMatch(result.message, /SECRET/);
});
