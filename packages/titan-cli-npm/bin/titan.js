#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

function platformAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") return "titan-linux-x86_64";
  if (platform === "linux" && arch === "arm64") return "titan-linux-aarch64";
  if (platform === "darwin" && arch === "x64") return "titan-macos-x86_64";
  if (platform === "darwin" && arch === "arm64") return "titan-macos-aarch64";
  if (platform === "win32" && arch === "x64") return "titan-windows-x86_64.exe";
  if (platform === "win32" && arch === "arm64") return "titan-windows-aarch64.exe";
  return null;
}

const asset = platformAssetName();
if (!asset) {
  console.error(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const binPath = path.join(__dirname, "..", "vendor", asset);
if (!existsSync(binPath)) {
  console.error("TITAN binary not installed. Reinstall package or run postinstall manually.");
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
