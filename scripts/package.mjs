#!/usr/bin/env node
/**
 * Build a folder someone can be handed.
 *
 * This is honest about what it is: a bundle that still needs Node on the
 * machine. It is not yet the double-clickable download this product needs —
 * see "Known limits" in the README — but it does remove every terminal step
 * after the first, which is the part that was in the way while iterating.
 *
 *   node scripts/package.mjs [outdir]
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = resolve(root, process.argv[2] ?? "build/LocalHarness");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(resolve(root, "dist"), resolve(out, "dist"), { recursive: true });
cpSync(resolve(root, "ui"), resolve(out, "ui"), { recursive: true });
cpSync(resolve(root, "README.md"), resolve(out, "README.md"));

// No dependencies to install, so the bundle needs nothing but a Node runtime.
writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify({ name: "localharness", private: true, type: "module", scripts: { start: "node dist/desktop.js" } }, null, 2) + "\n",
);

const mac = `#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "LocalHarness needs Node.js. Install it from https://nodejs.org and open this again."
  read -r _
  exit 1
fi
exec node dist/desktop.js
`;

const win = `@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo LocalHarness needs Node.js. Install it from https://nodejs.org and open this again.
  pause
  exit /b 1
)
node dist\\desktop.js
`;

writeFileSync(resolve(out, "LocalHarness.command"), mac);
writeFileSync(resolve(out, "LocalHarness.sh"), mac);
writeFileSync(resolve(out, "LocalHarness.bat"), win);
chmodSync(resolve(out, "LocalHarness.command"), 0o755);
chmodSync(resolve(out, "LocalHarness.sh"), 0o755);

process.stdout.write(
  `${out}\n\n` +
    `  macOS   double-click LocalHarness.command\n` +
    `  Linux   ./LocalHarness.sh\n` +
    `  Windows double-click LocalHarness.bat\n\n` +
    `  Still requires Node.js on the machine. A true no-runtime download\n` +
    `  needs Node SEA or Tauri — see Known limits in the README.\n`,
);
