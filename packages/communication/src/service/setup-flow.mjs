import { defaultConfigPath } from "./setup.mjs";
import { prepareSetup, buildSetupDraft, saveSetup, configureStartup, SetupError } from "./setup-editor.mjs";

export async function runGuidedSetup(ctx, { sdkModule, agentDirectory, configPath = defaultConfigPath(), showForm, startupOptions = {}, prepare = prepareSetup, save = saveSetup } = {}) {
  try {
    // Detect technical requirements before a UI ever asks for the token.
    const prepared = await prepare(configPath, { sdkModule, agentDirectory });
    const answers = await showForm(ctx, { ...prepared.current, existing: prepared.existing, automaticStartup: !prepared.existing && process.platform === "linux" });
    if (!answers) return { state: "cancelled", message: "Setup cancelled. No files or services were changed." };
    const draft = buildSetupDraft(prepared, answers);
    const result = await save(prepared, draft);
    const message = result.state === "unchanged" ? "Already configured. No configuration values changed." : "Configuration saved and validated.";
    let startup;
    if (!prepared.existing && process.platform === "linux") {
      startup = await configureStartup(result.config, startupOptions);
    } else if (prepared.existing && process.platform === "linux" && await ctx.ui.confirm("Automatic startup", "Configure or verify automatic startup separately? This never starts or restarts the bot.")) {
      startup = await configureStartup(result.config, startupOptions);
    }
    return {
      state: result.state,
      warning: startup?.state === "failed" || result.restartRequired,
      message: [message, startup?.message,
        result.restartRequired ? "The service may be running. Changes require an explicit stop/start; it was not restarted." : "Use /communication check, then /communication start. Setup did not start the bot.",
      ].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return { state: "error", message: error instanceof SetupError ? error.message : "Setup failed. Check file access and pi installation. No bot was started." };
  }
}
