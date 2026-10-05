import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { keys, text, validateProfileName } from "../config/validation.mjs";
import { validateDirectory } from "../contacts/directory.mjs";
import { loadConfiguration } from "../config/load.mjs";
import { serviceStatus } from "./control.mjs";
import { installSystemd } from "./systemd.mjs";
import { validateToolPermissions } from "../config/tool-permissions.mjs";
import { telegramBotId } from "./profiles.mjs";

export class SetupError extends Error {}
const fail = (message) => { throw new SetupError(message); };
const grants = { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true };
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

async function external(path) {
  let parent = path;
  for (;;) {
    try {
      const actual = await realpath(parent);
      const root = await realpath(packageRoot);
      const diff = relative(root, actual);
      if (diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`))) fail("Setup files and workspace must be outside the installed package.");
      return;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      if (error.code !== "ENOENT") fail("Setup directory is not accessible.");
      const next = dirname(parent);
      if (next === parent) fail("Setup directory is not accessible.");
      parent = next;
    }
  }
}

async function snapshot(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail("Setup cannot edit symlinks or non-regular files.");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) fail("Setup files must have private permissions (chmod 600).");
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof SetupError) throw error;
    if (error.code === "ENOENT") return undefined;
    fail("Setup file is not accessible.");
  }
}

export function validateSetupField(field, value, current = {}) {
  if (field === "botToken") {
    if (!value && current.hasToken) return undefined;
    return /^[1-9][0-9]*:[A-Za-z0-9_-]+$/.test(value) ? undefined : "Paste a valid bot token from @BotFather.";
  }
  if (field === "profileName") {
    try { validateProfileName(value); return undefined; }
    catch (error) { return error.message; }
  }
  if (field === "name") return value && !/[\x00-\x1f\x7f-\x9f]/.test(value) ? undefined : "Enter your name.";
  if (field === "address") return /^[1-9][0-9]*$/.test(value) ? undefined : "Enter your positive numeric Telegram user ID, not a username.";
  return "Unknown setup field.";
}

export function validateSetupUsers(users) {
  if (!Array.isArray(users) || users.length === 0) return "Add at least one Telegram user.";
  const addresses = new Set();
  const ids = new Set();
  for (const user of users) {
    if (!user || typeof user !== "object" || Array.isArray(user) || Object.keys(user).some((key) => !["id", "name", "address"].includes(key))) return "Invalid Telegram user.";
    for (const field of ["name", "address"]) {
      if (typeof user[field] !== "string") return "Invalid Telegram user.";
      const error = validateSetupField(field, user[field]);
      if (error) return error;
    }
    if (addresses.has(user.address)) return "This Telegram user ID is already listed.";
    addresses.add(user.address);
    if (user.id !== undefined) {
      if (typeof user.id !== "string" || ids.has(user.id)) return "Invalid or duplicate user identity.";
      ids.add(user.id);
    }
  }
}

export async function validateSetupEnvironment({ sdkModule, agentDirectory }) {
  for (const [path, label, type] of [[sdkModule, "The running pi SDK", "file"], [agentDirectory, "The current pi agent directory", "directory"]]) {
    try {
      if (!path || !isAbsolute(path)) throw new Error();
      const info = await stat(path);
      if (type === "file" ? !info.isFile() : !info.isDirectory()) throw new Error();
    } catch { fail(`${label} could not be detected or accessed. Fix the pi installation before entering a token.`); }
  }
}

export async function prepareSetup(configPath, defaults) {
  const file = resolve(configPath);
  await external(dirname(file));
  const configText = await snapshot(file);
  let config, directory, contactsFile, contactsText, contact;
  if (configText !== undefined) {
    let data;
    try {
      data = JSON.parse(configText);
      keys(data, ["version", "profileName", "telegram", "contactsFile", "sessionsDirectory", "pi"], "Configuration");
      if (data.version !== 1) throw new Error();
      keys(data.telegram, ["botToken"], "Telegram");
      if (data.pi !== undefined) {
        keys(data.pi, ["sdkModule", "workingDirectory", "agentDirectory", "permissions"], "Pi");
        validateToolPermissions(data.pi.permissions);
      }
      contactsFile = resolve(dirname(file), text(data.contactsFile, "Contacts path"));
      const sessionsDirectory = resolve(dirname(file), text(data.sessionsDirectory, "Sessions path"));
      await external(contactsFile);
      await external(sessionsDirectory);
      contactsText = await snapshot(contactsFile);
      directory = JSON.parse(contactsText);
      validateDirectory(directory);
      config = { profileName: validateProfileName(data.profileName), configFile: file, contactsFile, sessionsDirectory, directory, telegram: { botToken: data.telegram.botToken }, pi: data.pi };
    } catch (error) {
      if (error instanceof SetupError) throw error;
      fail("Configuration or contacts cannot be safely edited. Run /communication check for details; no files were changed.");
    }
    const telegramContacts = directory.contacts.filter((item) => item.endpoints.some((endpoint) => endpoint.channel === "telegram"));
    if (telegramContacts.some((item) => item.endpoints.filter((endpoint) => endpoint.channel === "telegram").length !== 1)) {
      fail("A contact has multiple Telegram IDs. Edit the contacts file explicitly; no contact was changed.");
    }
    const candidates = telegramContacts.filter((item) => item.id.startsWith("self-") || item.id === "me");
    contact = candidates.length === 1 ? candidates[0] : telegramContacts[0];
  } else {
    contactsFile = resolve(dirname(file), "contacts.json");
    contactsText = await snapshot(contactsFile);
    if (contactsText !== undefined) fail("A contacts file already exists without configuration. Setup will not overwrite it.");
    directory = { version: 1, contacts: [] };
  }
  const sdkModule = defaults.sdkModule;
  const agentDirectory = defaults.agentDirectory;
  let workingDirectory = defaults.workingDirectory ? resolve(defaults.workingDirectory) : resolve(dirname(file), "workspace");
  if (typeof config?.pi?.workingDirectory === "string" && config.pi.workingDirectory.trim()) {
    const previous = resolve(dirname(file), config.pi.workingDirectory);
    try { if ((await stat(previous)).isDirectory()) workingDirectory = previous; }
    catch { /* Restore an inaccessible technical workspace using the stable default. */ }
  }
  await validateSetupEnvironment({ sdkModule, agentDirectory });
  await external(workingDirectory);
  try { if (!(await stat(workingDirectory)).isDirectory()) fail("The service workspace is not a directory."); }
  catch (error) { if (error instanceof SetupError) throw error; if (error.code !== "ENOENT") fail("The service workspace is inaccessible."); }
  return {
    file, contactsFile, configText, contactsText, directory, contact,
    pi: { sdkModule, agentDirectory, workingDirectory },
    current: { users: directory.contacts.filter((item) => item.endpoints.some((endpoint) => endpoint.channel === "telegram")).sort((a, b) => a.id === contact?.id ? -1 : b.id === contact?.id ? 1 : 0).map((item) => ({ id: item.id, name: item.name, address: item.endpoints.find((endpoint) => endpoint.channel === "telegram").address })), profileName: config?.profileName ?? "", hasToken: typeof config?.telegram.botToken === "string" && /^[0-9]+:[A-Za-z0-9_-]+$/.test(config.telegram.botToken), name: contact?.name ?? "", address: contact?.endpoints.find((endpoint) => endpoint.channel === "telegram")?.address ?? "", permissions: validateToolPermissions(config?.pi?.permissions) },
    existing: Boolean(config), config,
  };
}

export function buildSetupDraft(prepared, answers) {
  const values = {
    botToken: (answers.botToken ?? "").trim() || prepared.config?.telegram.botToken,
    profileName: answers.profileName === undefined ? prepared.current.profileName : answers.profileName.trim(),
    name: (answers.name ?? "").trim() || prepared.current.name,
    address: (answers.address ?? "").trim() || prepared.current.address,
  };
  for (const field of answers.users === undefined ? ["botToken", "name", "address", "profileName"] : ["botToken", "profileName"]) {
    const error = validateSetupField(field, values[field] ?? "");
    if (error) fail(error);
  }
  if (prepared.config && telegramBotId(values.botToken) !== telegramBotId(prepared.config.telegram.botToken)) {
    fail("This token belongs to a different bot. Create a new profile instead; existing sessions must not be reassigned.");
  }
  const pi = { ...prepared.pi };
  if (answers.permissions !== undefined) pi.permissions = validateToolPermissions(answers.permissions);
  else if (prepared.config?.pi?.permissions !== undefined) pi.permissions = validateToolPermissions(prepared.config.pi.permissions);
  else if (!prepared.existing) pi.permissions = validateToolPermissions(undefined);
  const directory = structuredClone(prepared.directory);
  if (answers.users !== undefined) {
    const error = validateSetupUsers(answers.users);
    if (error) fail(error);
    const existingUsers = prepared.current.users;
    for (const user of answers.users) {
      if (user.id !== undefined && !existingUsers.some((item) => item.id === user.id)) fail("Unknown user identity. No contacts were changed.");
    }
    for (const user of existingUsers) {
      if (answers.users.some((item) => item.id === user.id)) continue;
      const contact = directory.contacts.find((item) => item.id === user.id);
      contact.endpoints = contact.endpoints.filter((endpoint) => endpoint.channel !== "telegram");
      if (contact.preferredChannel === "telegram") delete contact.preferredChannel;
      if (!contact.endpoints.length) directory.contacts = directory.contacts.filter((item) => item.id !== user.id);
    }
    for (const user of answers.users) {
      const contact = user.id === undefined ? undefined : directory.contacts.find((item) => item.id === user.id);
      if (contact) {
        contact.name = user.name;
        contact.endpoints.find((endpoint) => endpoint.channel === "telegram").address = user.address;
      } else {
        directory.contacts.push({ id: `self-${randomUUID()}`, name: user.name, aliases: [], preferredChannel: "telegram", endpoints: [{ channel: "telegram", address: user.address, permissions: { ...grants } }] });
      }
    }
  } else {
    let contact = prepared.contact ? directory.contacts.find((item) => item.id === prepared.contact.id) : undefined;
    if (!contact) {
      contact = { id: `self-${randomUUID()}`, name: values.name, aliases: [], preferredChannel: "telegram", endpoints: [{ channel: "telegram", address: values.address, permissions: grants }] };
      directory.contacts.push(contact);
    } else {
      contact.name = values.name;
      contact.endpoints.find((endpoint) => endpoint.channel === "telegram").address = values.address;
    }
  }
  try { validateDirectory(directory); }
  catch { fail("The contact change is invalid or duplicates another Telegram ID. No files were changed."); }
  const config = prepared.configText === undefined ? {
    version: 1, telegram: { botToken: values.botToken }, pi,
    contactsFile: "contacts.json", sessionsDirectory: "sessions",
  } : { ...JSON.parse(prepared.configText), telegram: { botToken: values.botToken }, pi };
  if (values.profileName) config.profileName = values.profileName;
  else delete config.profileName;
  // Keep unchanged source bytes, including formatting, whenever possible.
  const configText = prepared.configText !== undefined && isDeepStrictEqual(JSON.parse(prepared.configText), config)
    ? prepared.configText : JSON.stringify(config, null, 2) + "\n";
  const contactsText = prepared.contactsText !== undefined && isDeepStrictEqual(JSON.parse(prepared.contactsText), directory)
    ? prepared.contactsText : JSON.stringify(directory, null, 2) + "\n";
  return { configText, contactsText };
}

async function atomicFile(path, content, move = rename) {
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = undefined;
    await move(temp, path);
  } finally {
    if (handle) await handle.close();
    await rm(temp, { force: true });
  }
}

export async function saveSetup(prepared, draft, { move = rename, status = serviceStatus } = {}) {
  const base = dirname(prepared.file);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const lock = resolve(base, ".setup-edit.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { fail("Setup is already running or a setup lock remains. No files were changed."); }
  const applied = [];
  let running = false;
  try {
    if (await snapshot(prepared.file) !== prepared.configText || await snapshot(prepared.contactsFile) !== prepared.contactsText) {
      fail("Configuration or contacts changed while setup was open. Run setup again; nothing was overwritten.");
    }
    if (prepared.config) {
      try { running = (await status(prepared.config)).state !== "stopped"; }
      catch { running = true; }
    }
    await mkdir(prepared.pi.workingDirectory, { recursive: true, mode: 0o700 });
    for (const [path, content, previous] of [[prepared.contactsFile, draft.contactsText, prepared.contactsText], [prepared.file, draft.configText, prepared.configText]]) {
      if (content === previous) continue;
      await atomicFile(path, content, move);
      applied.push({ path, previous });
    }
    const config = await loadConfiguration(prepared.file);
    return { state: applied.length ? "configured" : "unchanged", config, restartRequired: running && applied.length > 0 };
  } catch (error) {
    let rollbackFailed = false;
    for (const { path, previous } of applied.reverse()) {
      try { if (previous === undefined) await rm(path); else await atomicFile(path, previous); }
      catch { rollbackFailed = true; }
    }
    if (rollbackFailed) fail("Setup failed and could not restore all files. Do not start the bot; inspect configuration and contacts.");
    if (error instanceof SetupError) throw error;
    fail("Setup could not save the files. Previous configuration and contacts were retained; no bot was started.");
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function configureStartup(config, options = {}) {
  try {
    const result = await (options.install ?? installSystemd)(config, options);
    if (!result.supported) return { state: "unsupported", message: "Automatic startup is unavailable on this platform. No bot was started." };
    const linger = result.linger === "yes" ? "Boot startup without login is enabled." : `Boot startup without login is not enabled/verified. Ask an administrator to run: sudo loginctl enable-linger ${JSON.stringify(result.username)}.`;
    return { state: "enabled", message: `Automatic startup configured; the bot was not started. ${linger}` };
  } catch {
    return { state: "failed", message: "Configuration is saved, but automatic startup could not be configured. Check the systemd user manager or a conflicting unit; no bot was started." };
  }
}
