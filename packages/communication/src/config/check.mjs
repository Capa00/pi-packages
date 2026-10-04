import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfiguration } from "./load.mjs";
import { keys, text } from "./validation.mjs";
import { validateDirectory } from "../contacts/directory.mjs";

// Only validation errors produced by our validators are displayed. File contents,
// parse exceptions, SDK imports, and raw filesystem errors are never exposed.
export function safeConfigurationError(error) {
  const message = error?.message ?? "";
  return /^(Configurazione|Rubrica|Contatto|Recapito|Permessi|Telegram|Token Telegram|Pi:|Modulo SDK|Directory sessioni|Percorso rubrica|Directory di lavoro pi|Directory agente pi)/.test(message)
    ? message : "Configuration could not be checked. Verify file access and permissions.";
}

export async function checkConfiguration(configPath) {
  const file = resolve(configPath);
  try { await lstat(file); }
  catch (error) {
    return error.code === "ENOENT"
      ? { state: "missing", errors: [] }
      : { state: "invalid", errors: ["Configuration file is not accessible."] };
  }
  const errors = [];
  const record = (message) => { if (!errors.includes(message)) errors.push(message); };
  let config;
  try { config = await loadConfiguration(file); }
  catch (error) { record(safeConfigurationError(error)); }
  // Collect independent errors when the configuration file is safe to read.
  let data;
  try {
    const info = await stat(file);
    if (info.isFile() && (process.platform === "win32" || (info.mode & 0o077) === 0)) {
      data = JSON.parse(await readFile(file, "utf8"));
    }
  } catch { /* The loader already reports inaccessible/invalid JSON files. */ }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const inspect = (action) => { try { action(); } catch (error) { record(safeConfigurationError(error)); } };
    inspect(() => keys(data, ["version", "telegram", "contactsFile", "sessionsDirectory", "pi"], "Configurazione"));
    if (data.version !== 1) record("Configuration version must be 1.");
    inspect(() => {
      keys(data.telegram, ["botToken"], "Telegram");
      if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(text(data.telegram.botToken, "Token Telegram"))) record("Telegram token format is invalid.");
    });
    inspect(() => text(data.contactsFile, "Percorso rubrica"));
    inspect(() => text(data.sessionsDirectory, "Directory sessioni"));
    if (typeof data.contactsFile === "string" && data.contactsFile.trim()) {
      try { validateDirectory(JSON.parse(await readFile(resolve(dirname(file), data.contactsFile), "utf8"))); }
      catch (error) { record(error.code || error instanceof SyntaxError ? "Contacts file is inaccessible or contains invalid JSON." : safeConfigurationError(error)); }
    }
    if (!data.pi) record("Pi configuration is missing. Run /communication setup.");
    else {
      inspect(() => keys(data.pi, ["sdkModule", "workingDirectory", "agentDirectory"], "Pi"));
      for (const [key, label, kind] of [["sdkModule", "Pi SDK entry point", "file"], ["workingDirectory", "Service workspace", "directory"], ["agentDirectory", "Pi agent directory", "directory"]]) {
        if (key === "sdkModule" && data.pi[key] === undefined) continue;
        try {
          const value = text(data.pi[key], "Pi:");
          const info = await stat(resolve(dirname(file), value));
          if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error();
        } catch { record(`${label} is missing or inaccessible.`); }
      }
    }
  }
  return errors.length ? { state: "invalid", errors } : { state: "valid", errors: [], config };
}

export function formatConfigurationCheck(result) {
  if (result.state === "missing") return "Configuration is missing. Run /communication setup.";
  if (result.state === "invalid") return `Configuration errors:\n${result.errors.map((error) => `• ${error}`).join("\n")}`;
  return `Configuration is valid. Contacts: ${result.config.directory.contacts.length}. Local checks passed; Telegram and model connections were not tested.`;
}
