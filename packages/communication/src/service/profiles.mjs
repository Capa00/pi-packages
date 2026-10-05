import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateProfileName } from "../config/validation.mjs";

export function telegramBotId(token) {
  if (typeof token !== "string" || !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Setup: invalid Telegram bot token.");
  }
  return token.split(":", 1)[0];
}

export function botConfigPath(defaultFile, id) {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Setup: enter a positive numeric Telegram bot ID.");
  return join(dirname(resolve(defaultFile)), "bots", id, "config.json");
}

// Discovery never imports the SDK, connects to Telegram, or exposes token values.
export async function listBotProfiles(defaultFile) {
  const file = resolve(defaultFile);
  const paths = [file];
  const bots = join(dirname(file), "bots");
  try {
    const info = await lstat(bots);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Setup: unsafe bot profiles directory.");
    for (const entry of (await readdir(bots, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Setup: bot profile directories must not be symlinks or non-directories.");
      paths.push(botConfigPath(file, entry.name));
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const profiles = [];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077))) {
        throw new Error("Setup: bot configuration must be a private regular file.");
      }
      let id, profileName;
      try {
        const data = JSON.parse(await readFile(path, "utf8"));
        id = telegramBotId(data?.telegram?.botToken);
        profileName = validateProfileName(data.profileName);
      }
      catch { throw new Error("Setup: invalid bot configuration; repair it before selecting a profile."); }
      if (path !== file && path !== botConfigPath(file, id)) throw new Error("Setup: bot ID does not match its profile directory.");
      if (profiles.some((profile) => profile.id === id)) throw new Error("Setup: duplicate Telegram bot ID across profiles.");
      profiles.push({ id, configPath: path, label: `${profileName ? `${profileName} · ` : ""}Telegram bot ${id}${path === file ? " (default)" : ""}` });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return profiles;
}

export async function selectSetupProfile(ctx, defaultFile) {
  const profiles = await listBotProfiles(defaultFile);
  const create = "Create a new Telegram bot";
  const choice = await ctx.ui.select("Communication setup", [create, ...profiles.map((profile) => `Edit ${profile.label}`)]);
  if (choice === undefined) return undefined;
  if (choice === create) return { creating: true };
  const selected = profiles.find((profile) => `Edit ${profile.label}` === choice);
  if (!selected) throw new Error("Setup: invalid profile selection.");
  return { ...selected, creating: false };
}

// An explicit CLI --config targets exactly that file instead of a managed profile.
export async function selectExplicitSetupProfile(ctx, configFile) {
  const file = resolve(configFile);
  const existing = (await listBotProfiles(file)).find((profile) => profile.configPath === file);
  const label = existing ? `Edit ${existing.label}` : "Create a bot at the selected configuration path";
  const choice = await ctx.ui.select("Communication setup", [label]);
  if (choice === undefined) return undefined;
  if (choice !== label) throw new Error("Setup: invalid profile selection.");
  if (existing) return { ...existing, creating: false };
  return { configPath: file, creating: true };
}

export async function selectControlProfile(ctx, defaultFile) {
  const profiles = await listBotProfiles(defaultFile);
  if (!profiles.length) return resolve(defaultFile);
  if (profiles.length === 1) return profiles[0].configPath;
  if (!ctx.hasUI) throw new Error("Setup: multiple bots configured; select a profile interactively or use the CLI --config option.");
  const choice = await ctx.ui.select("Select Telegram bot", profiles.map((profile) => profile.label));
  if (choice === undefined) return undefined;
  const selected = profiles.find((profile) => profile.label === choice);
  if (!selected) throw new Error("Setup: invalid profile selection.");
  return selected.configPath;
}

// Serialize managed profile commits, including the final duplicate-ID check.
export async function saveBotProfile(defaultFile, selected, save) {
  const base = dirname(resolve(defaultFile));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const lock = join(base, ".profiles-edit.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("Setup: another profile edit is running or a profile lock remains."); }
  try {
    const profiles = await listBotProfiles(defaultFile);
    if (profiles.some((profile) => profile.id === selected.id && (selected.creating || profile.configPath !== selected.configPath))) {
      throw new Error("Setup: this bot is already configured; no profile was overwritten.");
    }
    return await save();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
