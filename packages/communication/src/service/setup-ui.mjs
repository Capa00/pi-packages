import { validateSetupField, validateSetupUsers } from "./setup-editor.mjs";
import { toolPermissionNames, validateToolPermissions } from "../config/tool-permissions.mjs";

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
  const answers = { users: structuredClone(current.users ?? []), permissions: validateToolPermissions(current.permissions) };
  let step = 0;
  let error;
  let focused = false;
  let finished = false;
  let input = new Input();
  let confirmation;
  let permissionChoice;
  let userChoice;
  let userMode;
  let newUser;
  const permissionLabels = { readFiles: "Read files and list/search directories", writeFiles: "Create, write, and edit files", executeCommands: "Execute shell commands" };
  const selectTheme = {
    selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
  };
  const advancePermissions = () => {
    if (step < 7) {
      const field = toolPermissionNames[step - 4];
      const enabled = answers.permissions[field];
      permissionChoice = new SelectList([
        { value: enabled, label: enabled ? "Enabled" : "Disabled" },
        { value: !enabled, label: enabled ? "Disabled" : "Enabled" },
      ], 2, selectTheme);
      permissionChoice.onSelect = (item) => {
        answers.permissions[field] = item.value;
        step++;
        advancePermissions();
        tui.requestRender();
      };
      permissionChoice.onCancel = () => finish(undefined);
    } else {
      confirmation = new SelectList([{ value: "confirm", label: "Confirm" }, { value: "cancel", label: "Cancel" }], 2, selectTheme);
      confirmation.onSelect = (item) => finish(item.value === "confirm" ? structuredClone(answers) : undefined);
      confirmation.onCancel = () => finish(undefined);
    }
  };
  const fields = ["profileName", "botToken", "name", "address"];
  const resetInput = (handler) => {
    input = new Input();
    input.focused = focused;
    input.onSubmit = handler;
    input.onEscape = () => finish(undefined);
  };
  const showUsers = () => {
    userMode = "menu";
    userChoice = new SelectList([
      { value: "continue", label: "Continue" },
      { value: "add", label: "Add user" },
      { value: "remove", label: "Remove user" },
    ], 3, selectTheme);
    userChoice.onCancel = () => finish(undefined);
    userChoice.onSelect = (item) => {
      error = undefined;
      if (item.value === "continue") {
        error = validateSetupUsers(answers.users);
        if (!error) { userMode = undefined; advancePermissions(); }
      } else if (item.value === "add") {
        userMode = "name";
        newUser = {};
        resetInput(submitUser);
      } else if (!answers.users.length) {
        error = "No users to remove.";
      } else {
        userMode = "remove";
        userChoice = new SelectList([
          ...answers.users.map((user, index) => ({ value: index, label: `${safeText(user.name)} · ${user.address}` })),
          { value: "back", label: "Back" },
        ], 8, selectTheme);
        userChoice.onCancel = () => finish(undefined);
        userChoice.onSelect = (selected) => {
          if (selected.value !== "back") answers.users.splice(selected.value, 1);
          showUsers();
          tui.requestRender();
        };
      }
      tui.requestRender();
    };
  };
  const submitUser = (value) => {
    const field = userMode === "name" ? "name" : "address";
    const next = value.trim();
    error = validateSetupField(field, next);
    if (!error && field === "address") error = validateSetupUsers([...answers.users, { ...newUser, address: next }]);
    if (error) { tui.requestRender(); return; }
    newUser[field] = next;
    if (field === "name") { userMode = "address"; resetInput(submitUser); }
    else { answers.users.push(newUser); newUser = undefined; showUsers(); }
    tui.requestRender();
  };
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
    if (step === 4) {
      const user = { ...answers.users[0], name: answers.name, address: answers.address };
      const users = answers.users.length ? [user, ...answers.users.slice(1)] : [user];
      error = validateSetupUsers(users);
      if (error) { step = 3; tui.requestRender(); return; }
      answers.users = users;
      delete answers.name;
      delete answers.address;
      showUsers();
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
      if (current.botId) add(`Bot ID: ${current.botId}`, "dim");
      if (step < 4) {
        add(`Step ${step + 1} of 7`, "dim");
        const field = fields[step];
        if (field === "botToken") {
          add("Bot token", "text");
          add(current.hasToken ? "Paste a replacement, or press Enter to keep the saved token." : "Paste the token from @BotFather. It is hidden and never sent to the model.");
          const available = Math.max(0, width - 3);
          const cursor = focused ? CURSOR_MARKER : "";
          add(truncateToWidth(`> ${secret.masked(available)}${cursor} `, width, ""), "accent");
          add("Backspace deletes · Ctrl+U clears", "dim");
        } else {
          add(field === "profileName" ? "Profile name (optional)" : field === "name" ? "Your name" : "Your Telegram user ID", "text");
          if (field === "profileName") add("A label for bot selection menus; the bot ID and file paths stay unchanged.");
          if (current[field]) add(`Current: ${safeText(current[field])} · Enter keeps it`);
          if (field === "address") add("Use a positive numeric user ID, not @username. You can get your own ID from a trusted Telegram ID lookup, such as @userinfobot.");
          input.focused = focused;
          container.addChild(input);
        }
        if (error) add(error, "error");
        add("Enter continues · Esc cancels without saving", "dim");
      } else if (userMode) {
        add("Telegram users", "text");
        if (userMode === "name" || userMode === "address") {
          add(userMode === "name" ? "User name" : "Telegram user ID", "text");
          if (userMode === "address") add("Use a positive numeric user ID, not @username.");
          container.addChild(input);
          add("Enter continues · Esc cancels without saving", "dim");
        } else {
          if (userMode === "menu") {
            for (const user of answers.users) add(`${safeText(user.name)} · ${user.address}`, "accent");
            add("New users can chat, receive messages, and request confirmed sends.");
            add("Existing permissions stay unchanged. Removing a user removes their Telegram endpoint, not their saved sessions.");
          } else add("Select the user to remove. Changes are saved only at final confirmation.");
          container.addChild(userChoice);
          add("↑↓ selects · Enter chooses · Esc cancels without saving", "dim");
        }
        if (error) add(error, "error");
      } else if (step < 7) {
        add(`Step ${step + 1} of 7 · Pi permissions for this bot`, "dim");
        add(permissionLabels[toolPermissionNames[step - 4]], "text");
        add("These permissions apply to every authorized user of this bot.");
        if (step === 6) add("Shell access can also read/write files and access credentials. This is not a sandbox or automatic root access.", "warning");
        container.addChild(permissionChoice);
        add("↑↓ selects · Enter continues · Esc cancels without saving", "dim");
      } else {
        add("Review your configuration", "text");
        add(`Profile name: ${safeText(answers.profileName || "(bot ID)")}`, "accent");
        add("Telegram users:", "text");
        for (const user of answers.users) add(`${safeText(user.name)} · ${user.address}`, "accent");
        for (const user of current.users ?? []) {
          if (!answers.users.some((item) => item.id === user.id)) add(`Remove user: ${safeText(user.name)} · ${user.address}`, "warning");
        }
        add(answers.botToken ? "Bot token: new value entered (hidden)" : "Bot token: unchanged", "dim");
        add("New users are authorized to chat, receive, and request confirmed sends; existing user permissions are preserved.");
        for (const field of toolPermissionNames) add(`${permissionLabels[field]}: ${answers.permissions[field] ? "enabled" : "disabled"}`, "accent");
        if (answers.permissions.executeCommands) add("Shell commands have the service account's access to the PC, including files and credentials. No per-command approval is added.", "warning");
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
      if (fields[step] === "botToken" && (secret.paste !== undefined || data.includes("\x1b[200~"))) secret.handle(data);
      else if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) finish(undefined);
      else if (userMode) {
        if (userMode === "name" || userMode === "address") input.handleInput(data);
        else userChoice.handleInput(data);
      }
      else if (step === 7) confirmation.handleInput(data);
      else if (step >= 4) permissionChoice.handleInput(data);
      else if (fields[step] === "botToken") {
        if (keys.matches(data, "tui.input.submit") || data === "\n") submit(secret.value);
        else secret.handle(decodeKittyPrintable(data) ?? data);
      } else input.handleInput(data);
      tui.requestRender();
    },
    invalidate() { input.invalidate(); confirmation?.invalidate(); permissionChoice?.invalidate(); userChoice?.invalidate(); },
    dispose() { secret.clear(); for (const field of [...fields, "users", "permissions"]) delete answers[field]; newUser = undefined; input = new Input(); finished = true; }
  };
}

export async function showSetupForm(ctx, current, ui) {
  return ctx.ui.custom((tui, theme, keys, done) => createSetupComponent(tui, theme, keys, done, current, ui));
}
