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
    if (data === "\x1b[B") this.index = 1;
    else if (data === "\x1b[A") this.index = 0;
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

test("themed wizard asks only three fields, masks token, and confirms without typed yes", () => {
  const f = fixture({ hasToken: false, name: "", address: "", automaticStartup: true });
  const snapshots = [];
  const draw = () => { for (const width of [12, 40, 100]) { const lines = f.component.render(width); assert.ok(lines.every((line) => line.length <= width)); snapshots.push(lines.join("\n")); } };
  draw();
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN\x1b[201~");
  draw();
  f.component.handleInput("\r");
  f.component.handleInput("Alice"); draw(); f.component.handleInput("\r");
  f.component.handleInput("12345"); draw(); f.component.handleInput("\r"); draw();
  assert.equal(f.completions(), 0);
  assert.ok(snapshots.some((text) => text.includes("Confirm")));
  assert.doesNotMatch(snapshots.join("\n"), /PRIVATE_TOKEN|SDK entry|agent directory|working directory/);
  assert.ok(f.colors.includes("accent"));
  assert.ok(f.colors.includes("warning"));
  f.component.handleInput("\r");
  assert.deepEqual(f.result(), { botToken: "123:PRIVATE_TOKEN", name: "Alice", address: "12345" });
  assert.equal(f.completions(), 1);
  f.component.dispose();
});

test("Enter preserves existing values without ever placing the saved token in UI state", () => {
  const f = fixture({ hasToken: true, name: "Alice", address: "12345", existing: true });
  for (let i = 0; i < 3; i++) f.component.handleInput("\r");
  const output = f.component.render(100).join("\n");
  assert.match(output, /Bot token: unchanged/);
  assert.match(output, /Name: Alice/);
  f.component.handleInput("\r");
  assert.deepEqual(f.result(), { botToken: "", name: "Alice", address: "12345" });
});

test("Escape or selecting Cancel returns cancellation, never a successful draft", () => {
  const f = fixture({ hasToken: true, name: "Alice", address: "12345" });
  for (let i = 0; i < 3; i++) f.component.handleInput("\r");
  f.component.handleInput("\x1b[B");
  f.component.handleInput("\r");
  assert.equal(f.result(), undefined);
  assert.equal(f.completions(), 1);
  const early = fixture();
  early.component.handleInput("123:PRIVATE_TOKEN");
  early.component.handleInput("\x1b");
  assert.equal(early.result(), undefined);
  assert.equal(early.completions(), 1);
  assert.doesNotMatch(early.component.render(100).join("\n"), /PRIVATE_TOKEN/);
});

test("cancellation at every wizard step completes only once without returning secrets", () => {
  const steps = [
    [],
    ["123:PRIVATE_TOKEN", "\r"],
    ["123:PRIVATE_TOKEN", "\r", "Alice", "\r"],
    ["123:PRIVATE_TOKEN", "\r", "Alice", "\r", "12345", "\r"],
  ];
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
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN\r\x03\x1b[201~");
  assert.equal(f.completions(), 0);
  assert.match(f.component.render(100).join("\n"), /Step 1 of 3/);
  f.component.handleInput("\r");
  assert.match(f.component.render(100).join("\n"), /valid bot token/);
  f.component.dispose();
});

test("disposal ignores later input and clears pending secret paste", () => {
  const f = fixture();
  f.component.handleInput("\x1b[200~123:PRIVATE_TOKEN");
  f.component.dispose();
  f.component.handleInput("\x1b[201~");
  f.component.handleInput("\r");
  assert.equal(f.completions(), 0);
  assert.doesNotMatch(f.component.render(100).join("\n"), /PRIVATE_TOKEN|•/);
});

test("invalid input stays on its field with a safe, themed error", () => {
  const f = fixture({ hasToken: false });
  f.component.handleInput("PRIVATE_TOKEN");
  f.component.handleInput("\r");
  const output = f.component.render(100).join("\n");
  assert.match(output, /Step 1 of 3/);
  assert.match(output, /valid bot token/);
  assert.doesNotMatch(output, /PRIVATE_TOKEN/);
  assert.ok(f.colors.includes("error"));
  assert.equal(f.completions(), 0);
});
