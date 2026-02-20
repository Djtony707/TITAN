const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "titan-cli-npm-installer"
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "titan-cli-npm-installer"
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close(resolve);
          });
        }
      )
      .on("error", (err) => {
        fs.unlink(destination, () => reject(err));
      });
  });
}

async function main() {
  const assetName = platformAssetName();
  if (!assetName) {
    console.warn(
      `Skipping TITAN binary install: unsupported platform ${process.platform}/${process.arch}`
    );
    return;
  }

  const vendorDir = path.join(__dirname, "..", "vendor");
  fs.mkdirSync(vendorDir, { recursive: true });
  const destination = path.join(vendorDir, assetName);

  try {
    const release = await fetchJson("https://api.github.com/repos/Djtony707/TITAN/releases/latest");
    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (!asset) {
      throw new Error(`Release asset not found: ${assetName}`);
    }

    await downloadFile(asset.browser_download_url, destination);

    if (process.platform !== "win32") {
      fs.chmodSync(destination, 0o755);
    }

    console.log(`Installed TITAN binary: ${assetName}`);
  } catch (error) {
    console.warn(`TITAN postinstall warning: ${error.message}`);
    console.warn("You can still install TITAN using scripts/install.sh or scripts/install.ps1.");
  }
}

main();
