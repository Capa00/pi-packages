import { constants, openSync, readFileSync, fstatSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const states = ["awaiting_confirmation", "sending", "delivered", "delivery_unconfirmed", "cancelled", "expired", "superseded"];
export function validateOutboundState(data) {
  if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 2000) throw new Error();
  const ids = new Set(); const senders = new Set();
  for (const entry of data.entries) {
    const d = entry?.draft;
    if (!states.includes(entry?.state) || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 ||
        !d || !/^[0-9a-f-]{36}$/.test(d.id) || ids.has(d.id) ||
        d.sender?.channel !== "telegram" || typeof d.sender.address !== "string" || !/^[1-9][0-9]*$/.test(d.sender.address) || d.sender.scope !== undefined ||
        d.endpoint?.channel !== "telegram" || typeof d.endpoint.address !== "string" || !/^[1-9][0-9]*$/.test(d.endpoint.address) || d.endpoint.scope !== undefined ||
        ![d.senderContactId, d.recipientContactId].every((id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) ||
        ![d.senderName, d.recipientName].every((name) => typeof name === "string" && name.trim()) ||
        typeof d.text !== "string" || !d.text.trim() || d.text.length > 3000 || !Number.isSafeInteger(d.expiresAt) || d.expiresAt < 0) throw new Error();
    ids.add(d.id);
    if (entry.state === "awaiting_confirmation") {
      if (senders.has(d.sender.address)) throw new Error();
      senders.add(d.sender.address);
    }
    if (entry.binding && (entry.binding.deliveryId !== d.id || !Number.isSafeInteger(entry.binding.chatId) ||
        String(entry.binding.chatId) !== d.sender.address || !Number.isSafeInteger(entry.binding.messageId) || entry.binding.messageId <= 0)) throw new Error();
    if (entry.messageIds !== undefined && (!Array.isArray(entry.messageIds) || !entry.messageIds.every((id) => Number.isSafeInteger(id) && id > 0))) throw new Error();
  }
  return structuredClone(data.entries);
}

/** Accessi sincroni brevi: ogni transizione viene resa durevole prima di consegnare. */
export class OutboundStore {
  constructor(directory) { this.directory = directory; this.file = join(directory, "outbound.json"); }
  load() {
    let fd;
    try {
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > 8 * 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error();
      return validateOutboundState(JSON.parse(readFileSync(fd, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Stato outbound non valido o non leggibile; arresto senza invii o riparazioni automatiche");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  save(entries) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      validateOutboundState({ version: 1, entries });
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, entries }) + "\n");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.file);
      if (process.platform !== "win32") {
        const dir = openSync(this.directory, "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } catch { throw new Error("Stato outbound non salvato; nessun nuovo invio autorizzato"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
    }
  }
}
