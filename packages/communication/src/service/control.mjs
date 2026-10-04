import { fork } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("cli.mjs", import.meta.url));
const recordPath = (config) => join(dirname(config.configFile), "managed-service.json");

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("PID non valido");
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z") return undefined;
  return fields[19]; // Linux starttime: distingue PID riutilizzati.
}

export async function serviceStatus(config) {
  let record;
  try { record = JSON.parse(await readFile(recordPath(config), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Metadati servizio non leggibili o invalidi; nessun processo sarà arrestato");
  }
  if (record) {
    if (record.configFile !== config.configFile || typeof record.identity !== "string" || !Number.isSafeInteger(record.pid) || record.pid <= 1) {
      throw new Error("Metadati servizio invalidi; nessun processo sarà arrestato");
    }
    if (process.platform !== "linux") throw new Error("Controllo del processo gestito disponibile solo su Linux");
    try {
      if (await processIdentity(record.pid) === record.identity) return { state: "running", ...record };
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new Error("Impossibile verificare il processo; nessun processo sarà arrestato"); }
  }
  try {
    await stat(join(config.sessionsDirectory, ".telegram-service.lock"));
    return { state: "unmanaged-or-stale-lock" };
  } catch (error) { if (error.code !== "ENOENT") throw new Error("Impossibile leggere lo stato del servizio"); }
  return { state: "stopped" };
}

async function controlled(config, action) {
  const lock = join(dirname(config.configFile), ".service-control.lock");
  const reserved = [lock, recordPath(config), join(dirname(config.configFile), "service.log")];
  if ([config.configFile, config.contactsFile].some((file) => reserved.includes(file))) {
    throw new Error("Configurazione: nome file in conflitto con i file di controllo del servizio");
  }
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("Operazione di controllo già in corso o lock residuo .service-control.lock; verificare manualmente"); }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function startBackground(config, { entry = cliPath, timeout = 15000 } = {}) {
  if (process.platform !== "linux") throw new Error("Avvio background gestito disponibile solo su Linux; usare start in primo piano");
  return controlled(config, async () => {
    const status = await serviceStatus(config);
    if (status.state !== "stopped") throw new Error("Servizio attivo o lock da verificare: nessuna nuova istanza avviata");
    const logPath = join(dirname(config.configFile), "service.log");
    const log = await open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let child;
    try {
      await log.chmod(0o600);
      child = fork(entry, ["start", "--foreground", "--config", config.configFile], {
        detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"], execArgv: [],
      });
      const ready = new Promise((resolve, reject) => {
        child.once("message", (message) => message?.ready === true ? resolve() : reject(new Error("Avvio non confermato")));
        child.once("error", () => reject(new Error("Avvio processo fallito")));
        child.once("exit", () => reject(new Error("Servizio arrestato durante l'avvio; consultare service.log")));
      });
      let timer;
      try {
        await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Avvio non confermato entro il timeout; consultare service.log")), timeout); })]);
      } finally { clearTimeout(timer); }
      const identity = await processIdentity(child.pid);
      if (!identity) throw new Error("Processo non attivo");
      await rm(recordPath(config), { force: true });
      const handle = await open(recordPath(config), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: child.pid, identity, configFile: config.configFile }) + "\n"); }
      finally { await handle.close(); }
      child.disconnect();
      child.unref();
      return { pid: child.pid, logPath };
    } catch (error) {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      throw error;
    } finally { await log.close(); }
  });
}

export async function stopBackground(config, { timeout = 15000 } = {}) {
  return controlled(config, async () => {
    const status = await serviceStatus(config);
    if (status.state === "stopped") return false;
    if (status.state !== "running") throw new Error("Processo non gestito o lock residuo: verificare manualmente; nessun segnale inviato");
    // Ricontrolla immediatamente prima del segnale; non usa il vecchio service.pid.
    if (await processIdentity(status.pid) !== status.identity) throw new Error("Identità processo cambiata; arresto annullato");
    try { process.kill(status.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw new Error("Arresto non consentito"); }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let identity;
      try { identity = await processIdentity(status.pid); }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new Error("Verifica arresto fallita"); }
      if (identity !== status.identity) {
        await rm(recordPath(config), { force: true });
        return true;
      }
      await delay(100);
    }
    throw new Error("Arresto ancora in corso; ricontrollare status. Nessun SIGKILL inviato.");
  });
}
