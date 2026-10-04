import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("release metadata identifies the public scoped package and MIT license", () => {
  assert.equal(manifest.name, "@capa00/pi-communication");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author, "Giuseppe Di Puglia Pugliese");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.repository.url, "git+https://github.com/Capa00/pi-packages.git");
  assert.equal(manifest.repository.directory, "packages/communication");
  assert.deepEqual(manifest.files, ["src", "README.md", "LICENSE"]);
  const license = readFileSync(new URL("LICENSE", root), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Giuseppe Di Puglia Pugliese/);
  assert.equal(license, readFileSync(new URL("../../LICENSE", root), "utf8"));
});

test("il package espone solo l'entry point pi esplicito", () => {
  assert.deepEqual(manifest.pi, { extensions: ["./src/extension.ts"] });
  assert.ok(manifest.keywords.includes("pi-package"));
  for (const path of manifest.pi.extensions) {
    assert.ok(existsSync(new URL(path, root)));
    assert.ok(manifest.files.includes(path.replace(/^\.\//, "").split("/")[0]));
  }
});

test("pi rimane una dipendenza peer, non una copia runtime bundled", () => {
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.dependencies?.[name], undefined);
  }
  assert.equal(manifest.bundleDependencies, undefined);
});

test("il bin dichiarato è incluso nei file distribuiti", () => {
  const path = manifest.bin["pi-communication"];
  assert.ok(existsSync(new URL(path, root)));
  assert.ok(manifest.files.includes("src"));
});

test("il comando workspace include il riferimento a pi", () => {
  const workspace = JSON.parse(readFileSync(new URL("../../package.json", root), "utf8"));
  assert.equal(workspace.scripts["pi-communication"], "node packages/communication/src/service/cli.mjs");
  assert.equal(workspace.scripts.communication, undefined);
});

test("il servizio mostra help senza avviare connessioni", () => {
  const result = spawnSync(process.execPath, [new URL("src/service/cli.mjs", root).pathname, "--help"], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /long polling/);
  assert.equal(result.stderr, "");
});

test("il servizio non parte senza un comando esplicito", () => {
  const result = spawnSync(process.execPath, [new URL("src/service/cli.mjs", root).pathname], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Argomenti non validi/);
});
