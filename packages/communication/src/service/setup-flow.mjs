import { defaultConfigPath } from "./setup.mjs";
import { validateToolPermissions } from "../config/tool-permissions.mjs";
import { prepareSetup, validateSetupEnvironment, buildSetupDraft, saveSetup, configureStartup, SetupError } from "./setup-editor.mjs";
import { selectSetupProfile, saveBotProfile, telegramBotId, botConfigPath } from "./profiles.mjs";

export async function runGuidedSetup(ctx, { sdkModule, agentDirectory, workingDirectory, configPath = defaultConfigPath(), showForm, startupOptions = {}, prepare = prepareSetup, save = saveSetup, selectProfile = selectSetupProfile } = {}) {
  try {
    let selected = await selectProfile(ctx, configPath);
    if (!selected) return { state: "cancelled", message: "Setup cancelled. No files or services were changed." };
    const defaults = { sdkModule, agentDirectory, workingDirectory };
    // Managed creation cannot choose a directory until the token supplies the bot ID.
    await validateSetupEnvironment(defaults);
    let prepared = selected.configPath ? await prepare(selected.configPath, defaults) : undefined;
    if (selected.creating && prepared?.existing) throw new SetupError("This profile already exists. Select Edit instead.");
    const answers = await showForm(ctx, { ...(prepared?.current ?? { profileName: "", hasToken: false, name: "", address: "", permissions: validateToolPermissions(undefined) }), botId: selected.id, existing: prepared?.existing ?? false, automaticStartup: !prepared?.existing && process.platform === "linux" });
    if (!answers) return { state: "cancelled", message: "Setup cancelled. No files or services were changed." };
    if (selected.creating) {
      const id = telegramBotId(answers.botToken?.trim());
      selected = { ...selected, id, configPath: selected.configPath ?? botConfigPath(configPath, id) };
      prepared ??= await prepare(selected.configPath, defaults);
      if (prepared.existing) throw new SetupError("This profile already exists. Select Edit instead.");
    }
    const draft = buildSetupDraft(prepared, answers);
    if (selected.id && telegramBotId(JSON.parse(draft.configText).telegram.botToken) !== selected.id) {
      throw new SetupError("The token does not match the selected bot ID. No files were changed.");
    }
    const result = await saveBotProfile(configPath, selected, () => save(prepared, draft));
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
    return { state: "error", message: error instanceof SetupError || /^Setup:/.test(error?.message ?? "") ? error.message : "Setup failed. Check file access and pi installation. No bot was started." };
  }
}
