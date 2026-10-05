import assert from "node:assert/strict";
import test from "node:test";
import { SecretBuffer, createSetupComponent } from "../src/service/setup-ui.mjs";

class Input {
  value = "";
  focused = false;
  handleInput(data) {
    if (data === "\r") this.onSubmit?.(this.value);
    else if (data === "\x1b") this.onEscape?.();
    else if (data === "\x15") this.value = "";
    else this.value += data;
  }
  render(width) { return [("> " + this.value).slice(0, width)]; }
  invalidate() {}
}
class SelectList {
  index = 0;
  constructor(items) { this.items = items; }
  handleInput(data) {
    if (data === "\x1b[B") this.index = Math.min(this.items.length - 1, this.index + 1);
    else if (data === "\x1b[A") this.index = Math.max(0, this.index - 1);
    else if (data === "\r") this.onSelect?.(this.items[this.index]);
  }
  render() { return this.items.map((item, index) => `${index === this.index ? ">" : " "} ${item.label}`); }
  invalidate() {}
}
class Text {
  constructor(value) { this.value = value; }
  render(width) { return [this.value.slice(0, width)]; }
}
class Container {
  children = [];
  addChild(child) { this.children.push(child); }
  render(width) { return this.children.flatMap((child) => child.render(width)); }
}
function fixture(current = {}) {
  const colors = [];
  let result, completions = 0;
  const theme = { fg(color, text) { colors.push(color); return text; }, bold(text) { return text; } };
  const keys = { matches(data, binding) { return data === (binding === "tui.input.submit" ? "\r" : "\x1b"); } };
  const ui = { Input, SelectList, Text, Container, CURSOR_MARKER: "", truncateToWidth: (text, width) => text.slice(0, width), decodeKittyPrintable: () => undefined, matchesKey: (data) => data === "\x03", Key: { ctrl: () => "ctrl+c" } };
  const component = createSetupComponent({ requestRender() {} }, theme, keys, (value) => { result = value; completions++; }, current, ui);
  component.focused = true;
  return { component, colors, result: () => result, completions: () => completions };
}

test("secret buffer supports split bracketed paste without history or plaintext rendering", () => {
  const buffer = new SecretBuffer();
  buffer.handle("\x1b[200~123:PRIVATE");
  assert.equal(buffer.value, "");
  buffer.handle("_TOKEN\x1b[201~");
  assert.equal(buffer.value, "123:PRIVATE_TOKEN");
  assert.match(buffer.masked(5), /^•{5}$/);
  buffer.handle("\x1b[A");
  assert.equal(buffer.value, "123:PRIVATE_TOKEN");
  buffer.handle("\x7f");
  assert.equal(buffer.value, "123:PRIVATE_TOKE");
  buffer.handle("\x15");
  assert.equal(buffer.value, "");
  buffer.handle("\x1b[200~PENDING");
  buffer.clear();
  assert.equal(buffer.paste, undefined);
});

test("themed wizard asks four fields and three permissions, masks token, and confirms without typed yes", () => {
  const f = fixture({ hasToken: false, name: "", address: "", automaticStartup: true });
  const snapshots = [];
  const draw = () => { for (const width of [12, 40, 100]) { const lines = f.component.render(width); assert.ok(lines.every((line) => line.length <= width)); snapshots.push(lines.join("\n")); } };
  draw();
  assert.match(f.component.render(100).join("\n"), /Profile name \(optional\)/);
  f.component.handleInput("Personal assistant"); draw(); f.component.handleInput("\r"); draw();
  assert.match(f.component.render(100).join("\n"), /Bot token/);
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN\x1b[201~");
  draw();
  f.component.handleInput("\r");
  f.component.handleInput("Alice"); draw(); f.component.handleInput("\r");
  f.component.handleInput("12345"); draw(); f.component.handleInput("\r"); draw();
  assert.match(f.component.render(100).join("\n"), /Add user/);
  assert.match(f.component.render(100).join("\n"), /Remove user/);
  for (let i = 0; i < 4; i++) { f.component.handleInput("\r"); draw(); }
  assert.equal(f.completions(), 0);
  assert.ok(snapshots.some((text) => text.includes("Confirm")));
  assert.doesNotMatch(snapshots.join("\n"), /PRIVATE_TOKEN|SDK entry|agent directory|working directory/);
  assert.ok(f.colors.includes("accent"));
  assert.ok(f.colors.includes("warning"));
  f.component.handleInput("\r");
  assert.deepEqual(f.result(), { botToken: "123:PRIVATE_TOKEN", users: [{ name: "Alice", address: "12345" }], profileName: "Personal assistant", permissions: { readFiles: false, writeFiles: false, executeCommands: false } });
  assert.equal(f.completions(), 1);
  f.component.dispose();
});

test("Enter preserves existing values without ever placing the saved token in UI state", () => {
  const f = fixture({ hasToken: true, name: "Alice", address: "12345", profileName: "Personal", existing: true });
  for (let i = 0; i < 8; i++) f.component.handleInput("\r");
  const output = f.component.render(100).join("\n");
  assert.match(output, /Bot token: unchanged/);
  assert.match(output, /Alice · 12345/);
  f.component.handleInput("\r");
  assert.deepEqual(f.result(), { botToken: "", users: [{ name: "Alice", address: "12345" }], profileName: "Personal", permissions: { readFiles: false, writeFiles: false, executeCommands: false } });
});

test("Escape or selecting Cancel returns cancellation, never a successful draft", () => {
  const f = fixture({ hasToken: true, name: "Alice", address: "12345" });
  for (let i = 0; i < 8; i++) f.component.handleInput("\r");
  f.component.handleInput("\x1b[B");
  f.component.handleInput("\r");
  assert.equal(f.result(), undefined);
  assert.equal(f.completions(), 1);
  const early = fixture();
  early.component.handleInput("\r");
  early.component.handleInput("123:PRIVATE_TOKEN");
  early.component.handleInput("\x1b");
  assert.equal(early.result(), undefined);
  assert.equal(early.completions(), 1);
  assert.doesNotMatch(early.component.render(100).join("\n"), /PRIVATE_TOKEN/);
});

test("cancellation at every wizard step completes only once without returning secrets", () => {
  const events = ["Personal", "\r", "123:PRIVATE_TOKEN", "\r", "Alice", "\r", "12345", "\r", "\r", "\r", "\r", "\r"];
  const steps = [0, 2, 4, 6, 8, 9, 10, 11, 12].map((length) => events.slice(0, length));
  for (const cancel of ["\x1b", "\x03"]) {
    for (const events of steps) {
      const f = fixture();
      for (const event of events) f.component.handleInput(event);
      f.component.handleInput(cancel);
      f.component.handleInput("\r");
      assert.equal(f.result(), undefined);
      assert.equal(f.completions(), 1);
      assert.doesNotMatch(f.component.render(100).join("\n"), /PRIVATE_TOKEN/);
      f.component.dispose();
    }
  }
});

test("secret paste containing control keys never confirms or cancels the form", () => {
  const f = fixture();
  f.component.handleInput("\r");
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN\r\x03\x1b[201~");
  assert.equal(f.completions(), 0);
  assert.match(f.component.render(100).join("\n"), /Step 2 of 7/);
  f.component.handleInput("\r");
  assert.match(f.component.render(100).join("\n"), /valid bot token/);
  f.component.dispose();
});

test("disposal ignores later input and clears pending secret paste", () => {
  const f = fixture();
  f.component.handleInput("\r");
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN");
  f.component.dispose();
  f.component.handleInput("\x1b[201~");
  f.component.handleInput("\r");
  assert.equal(f.completions(), 0);
  assert.doesNotMatch(f.component.render(100).join("\n"), /PRIVATE_TOKEN|•/);
});

test("invalid input stays on its field with a safe, themed error", () => {
  const f = fixture({ hasToken: false });
  f.component.handleInput("\r");
  f.component.handleInput("PRIVATE_TOKEN");
  f.component.handleInput("\r");
  const output = f.component.render(100).join("\n");
  assert.match(output, /Step 2 of 7/);
  assert.match(output, /valid bot token/);
  assert.doesNotMatch(output, /PRIVATE_TOKEN/);
  assert.ok(f.colors.includes("error"));
  assert.equal(f.completions(), 0);
});

test("Add user and Remove user manage multiple IDs without saving before confirmation", () => {
  const users = [{ id: "alice", name: "Alice", address: "12345" }];
  const f = fixture({ hasToken: true, name: "Alice", address: "12345", users });
  const send = (...events) => events.forEach((event) => f.component.handleInput(event));
  send("\r", "\r", "\r", "\r");
  send("\x1b[B", "\r"); // Add user.
  assert.match(f.component.render(100).join("\n"), /User name/);
  send("Bob", "\r", "@bob", "\r");
  assert.match(f.component.render(100).join("\n"), /positive numeric/);
  send("\x15", "12345", "\r");
  assert.match(f.component.render(100).join("\n"), /already listed/);
  send("\x15", "67890", "\r");
  assert.match(f.component.render(100).join("\n"), /Bob · 67890/);
  send("\x1b[B", "\x1b[B", "\r", "\r"); // Remove Alice.
  assert.match(f.component.render(100).join("\n"), /Bob · 67890/);
  assert.doesNotMatch(f.component.render(100).join("\n"), /Alice ·/);
  send("\r", "\r", "\r", "\r"); // Continue and permissions.
  assert.equal(f.completions(), 0);
  assert.match(f.component.render(100).join("\n"), /Remove user: Alice/);
  send("\r");
  assert.deepEqual(f.result().users, [{ name: "Bob", address: "67890" }]);
  assert.deepEqual(users, [{ id: "alice", name: "Alice", address: "12345" }]);
});

test("empty user lists cannot continue; cancellation discards additions and removals", () => {
  const current = { hasToken: true, name: "Alice", address: "12345", users: [{ id: "alice", name: "Alice", address: "12345" }] };
  const f = fixture(current);
  for (let i = 0; i < 4; i++) f.component.handleInput("\r");
  for (const event of ["\x1b[B", "\x1b[B", "\r", "\r", "\r"]) f.component.handleInput(event);
  assert.match(f.component.render(100).join("\n"), /at least one/);
  f.component.handleInput("\x1b");
  assert.equal(f.result(), undefined);
  assert.equal(f.completions(), 1);
  assert.equal(current.users.length, 1);
  for (const events of [["\x1b[B", "\r"], ["\x1b[B", "\r", "Bob", "\r"], ["\x1b[B", "\x1b[B", "\r"]]) {
    const g = fixture(current);
    for (let i = 0; i < 4; i++) g.component.handleInput("\r");
    for (const event of [...events, "\x03"]) g.component.handleInput(event);
    assert.equal(g.result(), undefined);
    assert.equal(g.completions(), 1);
  }
});

test("permission selectors preserve existing values and toggle each grant before final confirmation", () => {
  const f = fixture({ hasToken: true, name: "Alice", address: "12345", permissions: { readFiles: true, writeFiles: false, executeCommands: true } });
  for (let i = 0; i < 5; i++) f.component.handleInput("\r");
  assert.match(f.component.render(100).join("\n"), /> Enabled/);
  f.component.handleInput("\r"); // Keep read enabled.
  f.component.handleInput("\x1b[B"); f.component.handleInput("\r"); // Enable write.
  assert.match(f.component.render(100).join("\n"), /Shell access/);
  f.component.handleInput("\x1b[B"); f.component.handleInput("\r"); // Disable commands.
  assert.equal(f.completions(), 0);
  f.component.handleInput("\r");
  assert.deepEqual(f.result().permissions, { readFiles: true, writeFiles: true, executeCommands: false });
});
