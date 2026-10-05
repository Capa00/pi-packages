#!/usr/bin/env node
import { resolve } from "node:path";
import { loadConfiguration } from "../config/load.mjs";
import { checkConfiguration, formatConfigurationCheck } from "../config/check.mjs";
import { runService } from "./run.mjs";
import { defaultConfigPath, interactiveSetup } from "./setup.mjs";
import { serviceStatus, startBackground, stopBackground } from "./control.mjs";
import { systemdStatus, controlSystemd } from "./systemd.mjs";
import { inspectServiceLock } from "./state.mjs";

const args = process.argv.slice(2);
const help = `pi-communication

Servizio Telegram: long polling, chat private, utenti autorizzati.

Uso:
  pi-communication setup
  pi-communication check
  pi-communication start [--background | --foreground]
  pi-communication stop
  pi-communication status

Tutti i comandi accettano --config /percorso/config.json.
Default: ~/.pi/communication/config.json (nessuna variabile d'ambiente).
setup is interactive: create a new bot or edit an existing profile; hidden token and explicit save confirmation.
Choose Pi file-read, file-write, and shell-command permissions for each bot (not per user).
New managed profiles live in ~/.pi/communication/bots/<numeric-bot-id>/ with separate sessions.
On Linux, new setup enables systemd without starting it; existing setup asks about startup separately.
Per avvio al boot senza login occorre linger: il setup ne verifica lo stato.
check valida senza connessioni. start usa systemd se configurato, altrimenti il primo piano.
--foreground forza il primo piano (Ctrl+C); --background usa systemd o gestione Linux manuale.
stop non arresta processi non gestiti; non usa service.pid preesistenti.
L'installazione con pi non avvia il servizio né garantisce il bin nel PATH.
Setup suggestions: --sdk-module <path>, --working-directory <path>, --agent-directory <path>.
These flags only suggest interactive defaults; they do not configure a running bot.`;

if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(help);
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    const command = args[0];
    if (!["setup", "check", "start", "stop", "status"].includes(command)) throw new Error("Argomenti non validi. Usa --help per informazioni.");
    let configPath = defaultConfigPath();
    let background = false;
    let foreground = false;
    let configSeen = false;
    const setupDefaults = {};
    const setupFlags = { "--sdk-module": "sdkModule", "--working-directory": "workingDirectory", "--agent-directory": "agentDirectory" };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--config" && !configSeen && args[i + 1] && !args[i + 1].startsWith("--")) {
        configPath = resolve(args[++i]);
        configSeen = true;
      } else if (command === "setup" && setupFlags[args[i]] && !setupDefaults[setupFlags[args[i]]] && args[i + 1] && !args[i + 1].startsWith("--")) {
        setupDefaults[setupFlags[args[i]]] = resolve(args[++i]);
      } else if (args[i] === "--background" && command === "start" && !background && !foreground) {
        background = true;
      } else if (args[i] === "--foreground" && command === "start" && !foreground && !background) {
        foreground = true;
      } else throw new Error("Argomenti non validi. Usa --help per informazioni.");
    }
    if (command === "setup") {
      await interactiveSetup(configPath, { ...setupDefaults, directProfile: configSeen });
    } else if (command === "check") {
      const result = await checkConfiguration(configPath);
      console.log(formatConfigurationCheck(result));
      if (result.state !== "valid") process.exitCode = 1;
    } else {
      const config = await loadConfiguration(configPath);
      const unit = foreground ? undefined : await systemdStatus(config);
      if (command === "status") {
        const status = await serviceStatus(config);
        const lock = status.state === "unmanaged-or-stale-lock" ? await inspectServiceLock(config.sessionsDirectory) : undefined;
        const lockText = lock?.state === "active" ? "Lock di un processo attivo verificato: non rimuoverlo." : lock?.state === "stale" ? "Lock residuo verificato: nessuna rimozione automatica; controllare prima di rimuoverlo manualmente." : "Lock presente: processo non gestito o lock residuo non identificabile. Verificare manualmente.";
        if (unit) console.log(`Servizio systemd ${unit.name}: ${unit.active}/${unit.sub}; avvio automatico: ${unit.enabled}.`);
        if (!unit || status.state === "running") {
          console.log(status.state === "running" ? `Servizio gestito senza systemd attivo (PID ${status.pid}).` : status.state === "stopped" ? "Servizio fermo." : lockText);
        } else if (status.state === "unmanaged-or-stale-lock" && ["inactive", "failed"].includes(unit.active)) {
          console.log(lockText);
        }
      } else if (command === "stop") {
        if (unit) await controlSystemd(config, "stop");
        const stopped = await stopBackground(config);
        console.log(unit || stopped ? "Servizio arrestato." : "Servizio già fermo.");
      } else if (unit) {
        if (["active", "activating", "reloading"].includes(unit.active)) {
          console.log(`Servizio systemd già attivo: ${unit.name}.`);
        } else {
          if ((await serviceStatus(config)).state !== "stopped") throw new Error("Servizio attivo senza systemd o lock residuo; arrestare/verificare prima di avviare systemd");
          const started = await controlSystemd(config, "start");
          if (!["active", "activating"].includes(started.active)) throw new Error("Servizio systemd non attivo dopo l'avvio; consultare journalctl --user");
          console.log(`Avvio systemd richiesto: ${unit.name}. Verificare status e journalctl --user.`);
        }
      } else if (background) {
        const result = await startBackground(config);
        console.log(`Servizio avviato in background (PID ${result.pid}). Log: ${result.logPath}`);
      } else {
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        await runService(config, { signal: controller.signal, log(message) {
          console.log(message);
          if (message.startsWith("Servizio Telegram avviato") && process.connected) process.send({ ready: true });
        } });
      }
    }
  } catch (error) {
    // Non stampare errori grezzi di filesystem/import: potrebbero contenere dati segreti.
    const safe = /^(Argomenti|Configurazione|Rubrica|Contatto|Recapito|Permessi|Telegram|Token Telegram|Pi:|Modulo SDK:|Destinatario|Directory sessioni|Setup|Servizio|Processo|Metadati|Controllo|Avvio|Arresto|Operazione|Impossibile|Identità|Ricezione|Invio risposta|Stato Telegram|Stato outbound|Risposta Telegram|Update Telegram|Attesa Telegram)/;
    console.error(safe.test(error.message) ? error.message : "Operazione fallita; verificare configurazione, permessi e stato del servizio.");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
