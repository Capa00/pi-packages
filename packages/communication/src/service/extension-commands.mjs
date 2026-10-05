import { createRequire } from "node:module";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuidedSetup } from "./setup-flow.mjs";
import { checkConfiguration, formatConfigurationCheck } from "../config/check.mjs";
import { defaultConfigPath } from "./setup.mjs";
import { selectControlProfile } from "./profiles.mjs";

const cliPath = fileURLToPath(new URL("./cli.mjs", import.meta.url));
export const commandUsage = "Usage: /communication setup|check|start|status|stop. Do not enter tokens in the pi chat; setup prompts privately in the terminal.";

export function commandArguments(action, defaults = {}) {
  if (!["check", "start", "status", "stop"].includes(action)) return undefined;
  const args = [cliPath, action];
  if (action === "start") args.push("--background");
  if (defaults.configPath) args.push("--config", defaults.configPath);
  return args;
}

export function hostSdkPath(entry = process.argv[1]) {
  if (!entry) return undefined;
  try { return createRequire(entry).resolve("@earendil-works/pi-coding-agent"); }
  catch { /* Import-only package exports need the running host's manifest. */ }
  try {
    let directory = dirname(realpathSync(entry));
    for (let depth = 0; depth < 4; depth++) {
      try {
        const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
        if (manifest.name === "@earendil-works/pi-coding-agent") {
          const target = manifest.exports?.["."]?.import ?? manifest.main;
          if (typeof target !== "string") return undefined;
          const path = resolve(directory, target);
          return statSync(path).isFile() ? path : undefined;
        }
      } catch { /* Inspect only ancestors of the explicit running CLI path. */ }
      directory = dirname(directory);
    }
  } catch { /* Ask for the SDK path interactively when the host cannot be resolved. */ }
  return undefined;
}

export function registerCommunicationCommands(pi, { agentDirectory, sdkModule = hostSdkPath(), showForm, setup = runGuidedSetup, check = checkConfiguration, configPath = defaultConfigPath(), selectProfile = selectControlProfile } = {}) {
  let busy = false;
  pi.registerCommand("communication", {
    description: "Configure and control the communication service",
    getArgumentCompletions: (prefix) => ["setup", "check", "start", "status", "stop"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (input, ctx) => {
      const action = input.trim();
      const report = (text, level = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.log(text);
      };
      if (!["setup", "check", "start", "status", "stop"].includes(action)) { report(commandUsage, "warning"); return; }
      if (busy) { report("A communication command is already running.", "warning"); return; }
      if (action === "setup" && ctx.mode !== "tui") {
        report("Setup requires the interactive pi terminal. No files or services were changed.", "warning");
        return;
      }
      busy = true;
      try {
        if (action === "setup") {
          await ctx.waitForIdle();
          const result = await setup(ctx, { sdkModule, agentDirectory, configPath, showForm });
          report(result.message, result.state === "error" ? "error" : result.warning ? "warning" : "info");
        } else {
          const selected = await selectProfile(ctx, configPath);
          if (!selected) { report("Bot selection cancelled. No service was changed."); return; }
          if (action === "check") {
            const result = await check(selected);
            report(formatConfigurationCheck(result), result.state === "invalid" ? "error" : result.state === "missing" ? "warning" : "info");
          } else {
            const selectedArgs = commandArguments(action, { configPath: selected });
            const result = await pi.exec(process.execPath, selectedArgs, { cwd: ctx.cwd, timeout: 45000 });
            report([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "Command completed.", result.code === 0 ? "info" : "error");
          }
        }
      } catch {
        // Never expose raw subprocess exceptions or input to model context.
        report("Communication command failed. Check configuration and service state.", "error");
      } finally { busy = false; }
    },
  });
}
