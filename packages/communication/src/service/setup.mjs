import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { toolPermissionNames } from "../config/tool-permissions.mjs";
import { runGuidedSetup } from "./setup-flow.mjs";
import { selectExplicitSetupProfile } from "./profiles.mjs";
import { validateSetupUsers } from "./setup-editor.mjs";

export const defaultConfigPath = () => resolve(homedir(), ".pi/communication/config.json");

export async function interactiveSetup(configPath, defaults = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup richiede un terminale interattivo");
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const ask = async (label, fallback = "") => (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
  try {
    let sdkDefault = defaults.sdkModule ?? "";
    if (!sdkDefault) {
      try { sdkDefault = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); } catch {}
    }
    console.log("Communication setup: create or edit a bot. No network connection or bot startup.");
    const sdkModule = await ask("Pi SDK entry point (dist/index.js)", sdkDefault);
    const agentDirectory = await ask("Pi agent directory", defaults.agentDirectory ?? resolve(homedir(), ".pi/agent"));
    const ctx = { ui: {
      async select(title, choices) {
        console.log(title);
        choices.forEach((choice, index) => console.log(`${index + 1}. ${choice}`));
        const value = await ask("Choice (number or cancel)");
        if (!value || value.toLowerCase() === "cancel") return undefined;
        if (!/^[1-9][0-9]*$/.test(value) || !choices[Number(value) - 1]) throw new Error("Setup: invalid choice.");
        return choices[Number(value) - 1];
      },
      async input(title, hint) { console.log(hint); return (await ask(title)) || undefined; },
      async confirm(title, message) { console.log(`${title}: ${message}`); return (await ask("Confirm? Type yes", "no")).toLowerCase() === "yes"; },
    } };
    const result = await runGuidedSetup(ctx, {
      configPath, sdkModule, agentDirectory, workingDirectory: defaults.workingDirectory,
      ...(defaults.directProfile ? { selectProfile: selectExplicitSetupProfile } : {}),
      showForm: async (_ctx, current) => {
        console.log(current.existing ? `Telegram bot ${current.botId}. Blank fields preserve existing values.` : "New Telegram bot. Its ID is derived from the token.");
        const profileName = await ask("Profile name (optional)", current.profileName);
        process.stdout.write("BotFather token (hidden; Enter keeps existing): ");
        muted = true;
        let botToken;
        try { botToken = (await rl.question("")).trim(); }
        finally { muted = false; process.stdout.write("\n"); }
        const name = await ask("Your name", current.name);
        const address = await ask("Your numeric Telegram user ID", current.address);
        const users = structuredClone(current.users ?? []);
        const first = { ...users[0], name, address };
        if (users.length) users[0] = first;
        else users.push(first);
        for (;;) {
          const error = validateSetupUsers(users);
          if (error) throw new Error(`Setup: ${error}`);
          console.log(users.map((user) => `${user.name} · ${user.address}`).join("\n"));
          const action = await ctx.ui.select("Telegram users", ["Continue", "Add user", "Remove user"]);
          if (action === undefined) return undefined;
          if (action === "Continue") break;
          if (action === "Add user") {
            const user = { name: await ask("User name"), address: await ask("Telegram user ID") };
            const error = validateSetupUsers([...users, user]);
            if (error) { console.log(error); continue; }
            users.push(user);
          } else {
            const labels = users.map((user) => `${user.name} · ${user.address}`);
            const selected = await ctx.ui.select("Remove user", [...labels, "Back"]);
            if (selected === undefined) return undefined;
            if (selected !== "Back") {
              if (users.length === 1) { console.log("Add another user before removing the last one."); continue; }
              users.splice(labels.indexOf(selected), 1);
            }
          }
        }
        console.log("New users can chat, receive messages, and request confirmed sends. Existing permissions stay unchanged.");
        for (const user of current.users ?? []) {
          if (!users.some((item) => item.id === user.id)) console.log(`Remove user: ${user.name} · ${user.address}. Saved sessions are retained.`);
        }
        const permissions = {};
        for (const field of toolPermissionNames) {
          if (field === "executeCommands") console.log("Shell access can read/write files and access credentials. Not a sandbox or automatic root access.");
          const value = (await ask(`Allow ${field}? Type yes/no`, current.permissions[field] ? "yes" : "no")).toLowerCase();
          if (!["yes", "no"].includes(value)) throw new Error("Setup: permissions require yes or no.");
          permissions[field] = value === "yes";
        }
        console.log(`Bot permissions: ${JSON.stringify(permissions)}. All authorized users share them; commands have no per-call approval.`);
        if (!await ctx.ui.confirm("Save bot configuration", "Save private files and configure automatic startup for a new Linux bot? The bot will not start or restart.")) return undefined;
        return { botToken, users, profileName, permissions };
      },
    });
    console.log(result.message);
    if (result.state === "error") throw new Error("Setup: configuration was not saved.");
  } finally { rl.close(); }
}
