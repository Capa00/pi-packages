import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { processIdentity } from "./control.mjs";

export async function inspectServiceLock(directory) {
  const lock = join(directory, ".telegram-service.lock");
  let owner;
  try { owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); }
  catch { return { state: "unknown" }; }
  if (process.platform !== "linux" || owner?.version !== 1 || typeof owner.identity !== "string" || typeof owner.boot !== "string" ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || typeof owner.token !== "string") return { state: "unknown" };
  let boot;
  try { boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
  catch { return { state: "unknown" }; }
  if (boot !== owner.boot) return { state: "stale" };
  try {
    return { state: await processIdentity(owner.pid) === owner.identity ? "active" : "stale" };
  } catch (error) {
    return { state: ["ENOENT", "ESRCH"].includes(error.code) ? "stale" : "unknown" };
  }
}

export async function prepareState(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = join(directory, ".telegram-service.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch {
    const info = await inspectServiceLock(directory);
    throw new Error(info.state === "active" ? "Servizio già attivo: lock appartenente a un processo verificato; non rimuoverlo" : info.state === "stale" ? "Servizio fermo con lock residuo verificato: rimuovere manualmente .telegram-service.lock solo dopo controllo" : "Servizio già attivo o lock residuo non identificabile: verificare prima di rimuovere .telegram-service.lock");
  }
  const token = randomUUID();
  try {
    const owner = { version: 1, pid: process.pid, token };
    if (process.platform === "linux") {
      owner.identity = await processIdentity(process.pid);
      owner.boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    }
    await writeFile(join(lock, "owner.json"), JSON.stringify(owner) + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    await rm(lock, { recursive: true, force: true });
    throw new Error("Servizio: registrazione del proprietario del lock fallita");
  }
  const file = join(directory, "telegram-offset.json");
  return {
    async readOffset() {
      let contents;
      try { contents = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return 0; throw new Error("Stato Telegram non leggibile"); }
      try {
        const data = JSON.parse(contents);
        if (!Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error();
        return data.offset;
      } catch { throw new Error("Stato Telegram non valido; arresto per evitare replay involontari"); }
    },
    async writeOffset(offset) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset non valido");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ offset }) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    },
    async close() {
      let owner;
      try { owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); }
      catch { return; }
      if (owner.token !== token) throw new Error("Servizio: proprietario del lock cambiato, nessuna rimozione");
      await rm(lock, { recursive: true, force: true });
    },
  };
}
