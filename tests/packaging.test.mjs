import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const profile = JSON.parse(fs.readFileSync(new URL("../profiles/offline-dotnet-v1.json", import.meta.url), "utf8"));

const bundledInProfile = profile.packages.filter((pkg) => pkg.tier === "bundled");

test("every bundled profile package is an exact-pinned dependency", () => {
  assert.ok(bundledInProfile.length > 0);
  for (const pkg of bundledInProfile) {
    assert.equal(manifest.dependencies?.[pkg.name], pkg.version, `${pkg.name} pin drifted from the profile`);
  }
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    bundledInProfile.map((pkg) => pkg.name).sort(),
    "package.json dependencies and profile bundled tier must list the same packages"
  );
});

test("dependencies are exact versions, not ranges", () => {
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${version}`);
  }
});

test("bundled packages ship inside the tarball and are loaded by the manifest", () => {
  // pi docs: other pi packages must be in dependencies AND bundledDependencies
  // and referenced through node_modules/ paths, or an npm-sourced install puts
  // them outside this package's root and nothing loads them.
  assert.deepEqual([...manifest.bundledDependencies].sort(), Object.keys(manifest.dependencies).sort());
  for (const name of Object.keys(manifest.dependencies)) {
    assert.ok(
      manifest.pi.extensions.some((entry) => entry.startsWith(`node_modules/${name}/`)),
      `${name} is installed but no manifest entry loads it`
    );
  }
  assert.equal(manifest.pi.extensions[0], "./extensions/index.ts");
});

test("optional and deferred packages stay out of the automatic install", () => {
  for (const pkg of profile.packages.filter((x) => x.tier !== "bundled")) {
    assert.equal(manifest.dependencies?.[pkg.name], undefined, `${pkg.name} (${pkg.tier}) must not be auto-installed`);
  }
});

test("pins vscode-languageserver-protocol below its exports map", () => {
  // pi-lsp-extension@1.3.0 asks for ^3.17.5 and imports the file path
  // "vscode-languageserver-protocol/node.js". 3.18.0 added an `exports` map
  // exposing only "./node", so a fresh install resolves 3.18.x and the
  // extension dies at load with:
  //   Package subpath './node.js' is not defined by "exports"
  // 3.17.5 is the last version without that map and it ships a root node.js.
  // There is no newer pi-lsp-extension to upgrade to (1.3.0 is latest).
  assert.equal(manifest.overrides?.["vscode-languageserver-protocol"], "3.17.5");
});

test("ships the resolved tree that was actually verified", () => {
  // pi runs `npm install --omit=dev` inside the clone, so a committed lockfile
  // makes every install reproduce the tree the install gate checked -- and it
  // is what keeps the override above from being re-resolved away.
  const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(lock.lockfileVersion >= 3);
  assert.equal(lock.packages["node_modules/vscode-languageserver-protocol"].version, "3.17.5");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} missing or mismatched in lockfile`);
  }
});

test("peer-dependency resolution is disabled for git installs", () => {
  // pi runs a plain `npm install --omit=dev` in git clones; without this npm
  // would install a second pi core to satisfy pi-lean-edit's ^0.84 peer.
  const npmrc = fs.readFileSync(new URL("../.npmrc", import.meta.url), "utf8");
  assert.match(npmrc, /^legacy-peer-deps=true$/m);
});
