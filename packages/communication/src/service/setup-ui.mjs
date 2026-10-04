import { validateSetupField } from "./setup-editor.mjs";

// A dedicated secret buffer has no editor history, undo stack, clipboard/kill ring,
// or plaintext renderer. Only this instance owns the newly entered token.
export class SecretBuffer {
  value = "";
  paste = undefined;
  handle(data) {
    if (data.includes("\x1b[200~")) { this.paste = ""; data = data.replace("\x1b[200~", ""); }
    if (this.paste !== undefined) {
      this.paste = (this.paste + data).slice(0, 4096);
      const end = this.paste.indexOf("\x1b[201~");
      if (end !== -1) {
        const text = this.paste.slice(0, end).trim();
        this.paste = undefined;
        if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) this.value = (this.value + text).slice(0, 4096);
      }
      return;
    }
    if (data === "\x7f" || data === "\b") this.value = this.value.slice(0, -1);
    else if (data === "\x15") this.value = "";
    else if (!/[\x00-\x1f\x7f-\x9f]/.test(data)) this.value = (this.value + data).slice(0, 4096);
  }
  clear() { this.value = ""; this.paste = undefined; }
  masked(width) { return "•".repeat(Math.min(this.value.length, Math.max(0, width))); }
}

export function createSetupComponent(tui, theme, keys, done, current, ui) {
  const { Input, SelectList, Text, Container, CURSOR_MARKER, truncateToWidth, decodeKittyPrintable, matchesKey, Key } = ui;
  const secret = new SecretBuffer();
  const answers = {};
  let step = 0;
  let error;
  let focused = false;
  let finished = false;
  let input = new Input();
  let confirmation;
  const fields = ["botToken", "name", "address"];
  const finish = (result) => {
    if (finished) return;
    finished = true;
    secret.clear();
    input = new Input();
    done(result);
  };
  const effective = (field, value) => value.trim() || (field === "botToken" ? "" : current[field] ?? "");
  const submit = (value) => {
    const field = fields[step];
    const next = effective(field, value);
    error = validateSetupField(field, next, current);
    if (error) { tui.requestRender(); return; }
    answers[field] = next;
    if (field === "botToken") secret.clear();
    step++;
    input = new Input();
    input.focused = focused;
    input.onSubmit = submit;
    input.onEscape = () => finish(undefined);
    if (step === 3) {
      confirmation = new SelectList([{ value: "confirm", label: "Confirm" }, { value: "cancel", label: "Cancel" }], 2, {
        selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
      });
      confirmation.onSelect = (item) => finish(item.value === "confirm" ? { ...answers } : undefined);
      confirmation.onCancel = () => finish(undefined);
    }
    tui.requestRender();
  };
  input.onSubmit = submit;
  input.onEscape = () => finish(undefined);
  const safeText = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return {
    get focused() { return focused; },
    set focused(value) { focused = value; input.focused = value; },
    render(width) {
      const container = new Container();
      const add = (text, color = "muted") => container.addChild(new Text(theme.fg(color, text), 0, 0));
      add("─".repeat(Math.max(0, width)), "accent");
      add(theme.bold("Communication · Telegram setup"), "accent");
      if (step < 3) {
        add(`Step ${step + 1} of 3`, "dim");
        const field = fields[step];
        if (field === "botToken") {
          add("Bot token", "text");
          add(current.hasToken ? "Paste a replacement, or press Enter to keep the saved token." : "Paste the token from @BotFather. It is hidden and never sent to the model.");
          const available = Math.max(0, width - 3);
          const cursor = focused ? CURSOR_MARKER : "";
          add(truncateToWidth(`> ${secret.masked(available)}${cursor} `, width, ""), "accent");
          add("Backspace deletes · Ctrl+U clears", "dim");
        } else {
          add(field === "name" ? "Your name" : "Your Telegram user ID", "text");
          if (current[field]) add(`Current: ${safeText(current[field])} · Enter keeps it`);
          if (field === "address") add("Use a positive numeric user ID, not @username. You can get your own ID from a trusted Telegram ID lookup, such as @userinfobot.");
          input.focused = focused;
          container.addChild(input);
        }
        if (error) add(error, "error");
        add("Enter continues · Esc cancels without saving", "dim");
      } else {
        add("Review your configuration", "text");
        add(`Name: ${safeText(answers.name)}`, "accent");
        add(`Telegram ID: ${answers.address}`, "accent");
        add(answers.botToken ? "Bot token: new value entered (hidden)" : "Bot token: unchanged", "dim");
        add("This contact is authorized to chat, receive, and request confirmed sends for a new setup; existing permissions are preserved.");
        add(current.automaticStartup ? "Confirm saves the files and configures automatic startup on Linux." : "Confirm saves changes. Automatic startup is a separate choice.");
        add("The bot will not be started or restarted.", "warning");
        container.addChild(confirmation);
        add("↑↓ selects · Enter confirms your choice · Esc cancels", "dim");
      }
      add("─".repeat(Math.max(0, width)), "accent");
      return container.render(width).map((line) => truncateToWidth(line, width, ""));
    },
    handleInput(data) {
      if (finished) return;
      // Never interpret a bracketed secret paste as a submit or cancel key.
      if (step === 0 && (secret.paste !== undefined || data.includes("\x1b[200~"))) secret.handle(data);
      else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) finish(undefined);
      else if (step === 3) confirmation.handleInput(data);
      else if (step === 0) {
        if (keys.matches(data, "tui.input.submit") || data === "\n") submit(secret.value);
        else secret.handle(decodeKittyPrintable(data) ?? data);
      } else input.handleInput(data);
      tui.requestRender();
    },
    invalidate() { input.invalidate(); confirmation?.invalidate(); },
    dispose() { secret.clear(); for (const field of fields) delete answers[field]; input = new Input(); finished = true; },
  };
}

export async function showSetupForm(ctx, current, ui) {
  return ctx.ui.custom((tui, theme, keys, done) => createSetupComponent(tui, theme, keys, done, current, ui));
}
