import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { loadConfiguration } from "../config/load.mjs";
import { validateDirectory } from "../contacts/directory.mjs";
import { installSystemd } from "./systemd.mjs";

export const defaultConfigPath = () => resolve(homedir(), ".pi/communication/config.json");

async function assertExternal(directory) {
  let parent = directory;
  for (;;) {
    try {
      const actual = await realpath(parent);
      const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
      const diff = relative(root, actual);
      if (diff === "" || (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`))) {
        throw new Error("Setup: scegliere una directory esterna al package");
      }
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
}

export async function writeSetup(configPath, { botToken, sdkModule, workingDirectory, agentDirectory, id, name, address }) {
  const file = resolve(configPath);
  const base = dirname(file);
  await assertExternal(base);
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Token Telegram: formato non valido");
  for (const path of [workingDirectory, agentDirectory]) {
    try { if (!(await stat(path)).isDirectory()) throw new Error(); }
    catch { throw new Error("Pi: directory non accessibile"); }
  }
  try { if (!(await stat(sdkModule)).isFile()) throw new Error(); }
  catch { throw new Error("Modulo SDK: file non accessibile"); }
  const directory = validateDirectory({ version: 1, contacts: [{ id, name, aliases: [], preferredChannel: "telegram", endpoints: [{
    channel: "telegram", address, permissions: { canInteractWithPi: true, canReceiveMessages: true, canRequestSendMessages: true },
  }] }] });
  const contactsFile = resolve(base, "contacts.json");
  if (contactsFile === file) throw new Error("Setup: configurazione e rubrica devono essere file distinti");
  const config = { version: 1, telegram: { botToken }, pi: {
    sdkModule: resolve(sdkModule), workingDirectory: resolve(workingDirectory), agentDirectory: resolve(agentDirectory),
  }, contactsFile: "contacts.json", sessionsDirectory: "sessions" };
  await mkdir(base, { recursive: true, mode: 0o700 });
  const created = [];
  try {
    for (const [path, value] of [[file, config], [contactsFile, directory]]) {
      const handle = await open(path, "wx", 0o600);
      created.push(path);
      try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); }
      finally { await handle.close(); }
    }
    return await loadConfiguration(file);
  } catch {
    for (const path of created) await rm(path, { force: true });
    throw new Error("Setup non completato: controllare percorsi, permessi e file già esistenti. Nessun file esistente sovrascritto.");
  }
}

export async function setupSystemd(config, options = {}) {
  const result = await installSystemd(config, options);
  const log = options.log ?? console.log;
  if (!result.supported) {
    log("Systemd non configurato: integrazione disponibile solo su Linux. Usare avvio manuale.");
    return result;
  }
  log(`Unità ${result.name} creata e abilitata, ma non avviata. Log: journalctl --user -u ${result.name}`);
  if (result.linger === "yes") {
    log("Linger già attivo: servizio abilitato anche al boot senza login.");
  } else {
    log("Avvio senza login non ancora verificato/abilitato. Eseguire come amministratore:");
    log(`sudo loginctl enable-linger ${JSON.stringify(result.username)}`);
    log("Senza linger il servizio parte quando si avvia il gestore systemd utente, normalmente al login.");
  }
  return result;
}

export async function interactiveSetup(configPath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup richiede un terminale interattivo");
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const ask = async (label, fallback = "") => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  try {
    let exists = false;
    try { await stat(configPath); exists = true; }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Setup: configurazione non accessibile"); }
    if (exists) {
      const config = await loadConfiguration(configPath);
      console.log("Configurazione già presente: nessuna modifica a configurazione o rubrica.");
      if ((await ask("Creare/abilitare soltanto il servizio systemd senza avviarlo? Scrivi sì")).toLowerCase() === "sì") {
        await setupSystemd(config);
      } else console.log("Setup annullato.");
      return;
    }
    console.log("Configurazione locale: nessuna connessione Telegram, nessun avvio. Il contatto avrà tutti e tre i permessi.");
    console.log("Su Linux il setup crea e abilita anche il servizio systemd utente, senza avviarlo.");
    process.stdout.write("Token BotFather (nascosto): ");
    muted = true;
    let botToken;
    try { botToken = (await rl.question("")).trim(); }
    finally { muted = false; process.stdout.write("\n"); }
    let sdkDefault = "";
    try { sdkDefault = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); } catch {}
    const sdkModule = await ask("Entry point SDK pi (dist/index.js)", sdkDefault);
    const workingDirectory = await ask("Directory di lavoro", process.cwd());
    const agentDirectory = await ask("Directory agente pi", resolve(homedir(), ".pi/agent"));
    const id = await ask("ID interno contatto", "me");
    const name = await ask("Nome contatto");
    const address = await ask("ID numerico utente Telegram (non username)");
    console.log(`File: ${resolve(configPath)} e contacts.json nella stessa directory. Nessuna sovrascrittura.`);
    if ((await ask("Creare i file e configurare systemd su Linux? Scrivi sì")).toLowerCase() !== "sì") {
      console.log("Setup annullato.");
      return;
    }
    const config = await writeSetup(configPath, { botToken, sdkModule, workingDirectory, agentDirectory, id, name, address });
    console.log("Configurazione creata e validata. Avvia il bot in Telegram prima di usare il servizio.");
    await setupSystemd(config);
  } finally { rl.close(); }
}
