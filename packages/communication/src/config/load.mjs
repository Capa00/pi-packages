import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keys, text } from "./validation.mjs";
import { validateDirectory } from "../contacts/directory.mjs";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function inside(path, root) {
  const diff = relative(root, path);
  return diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`));
}

async function externalFile(path, label) {
  let actual;
  try { actual = await realpath(path); } catch { throw new Error(`${label}: file non accessibile`); }
  const root = await realpath(packageRoot);
  if (inside(actual, root)) throw new Error(`${label}: il file deve essere esterno al package`);
  return actual;
}

async function jsonFile(path, label) {
  let contents;
  try { contents = await readFile(path, "utf8"); } catch { throw new Error(`${label}: lettura fallita`); }
  try { return JSON.parse(contents); } catch { throw new Error(`${label}: JSON non valido`); }
}

/** Nessun fallback a variabili d'ambiente. Non restituisce errori con contenuti dei file. */
export async function loadConfiguration(configPath) {
  const configFile = await externalFile(resolve(configPath), "Configurazione");
  const info = await stat(configFile);
  if (!info.isFile()) throw new Error("Configurazione: file regolare richiesto");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Configurazione: permessi troppo aperti; usare chmod 600");
  }
  const data = await jsonFile(configFile, "Configurazione");
  keys(data, ["version", "telegram", "contactsFile", "sessionsDirectory", "pi"], "Configurazione");
  if (data.version !== 1) throw new Error("Configurazione: versione non supportata");
  keys(data.telegram, ["botToken"], "Telegram");
  const botToken = text(data.telegram.botToken, "Token Telegram");
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Token Telegram: formato non valido");
  const base = dirname(configFile);
  const contactsFile = await externalFile(resolve(base, text(data.contactsFile, "Percorso rubrica")), "Rubrica");
  const sessionsDirectory = resolve(base, text(data.sessionsDirectory, "Directory sessioni"));
  // Verifica anche i genitori esistenti per evitare directory interne tramite symlink.
  let parent = sessionsDirectory;
  for (;;) {
    try {
      const actual = await realpath(parent);
      if (inside(actual, await realpath(packageRoot))) throw new Error("Directory sessioni: deve essere esterna al package");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw new Error("Directory sessioni: percorso non valido");
      parent = next;
    }
  }
  let pi;
  if (data.pi !== undefined) {
    keys(data.pi, ["sdkModule", "workingDirectory", "agentDirectory"], "Pi");
    pi = {
      ...(data.pi.sdkModule === undefined ? {} : { sdkModule: resolve(base, text(data.pi.sdkModule, "Modulo SDK")) }),
      workingDirectory: resolve(base, text(data.pi.workingDirectory, "Directory di lavoro pi")),
      agentDirectory: resolve(base, text(data.pi.agentDirectory, "Directory agente pi")),
    };
    for (const path of [pi.workingDirectory, pi.agentDirectory]) {
      try { if (!(await stat(path)).isDirectory()) throw new Error(); }
      catch { throw new Error("Pi: directory non accessibile"); }
    }
  }
  const directory = validateDirectory(await jsonFile(contactsFile, "Rubrica"));
  return { configFile, telegram: { botToken }, contactsFile, sessionsDirectory, directory, pi };
}
