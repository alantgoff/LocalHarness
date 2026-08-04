import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { platform } from "node:os";
import { startServer } from "./server.js";

/**
 * What happens when someone double-clicks the app.
 *
 * No terminal, no port to remember, no README step. Pick a port that's free,
 * start the local server, open the browser at it, and print something a person
 * would understand if they ever did see it.
 *
 * This deliberately opens the system browser instead of shipping a bundled
 * one. A browser engine is a ~150 MB download that buys a window frame, and
 * the honest packaging problem for this product is the model runtime, not the
 * chrome around the UI.
 */

const PREFERRED_PORTS = [4173, 4174, 4175, 4180, 4190];

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  for (const p of PREFERRED_PORTS) {
    if (await isFree(p)) return p;
  }
  // Let the OS choose rather than failing in front of someone who cannot act
  // on "port in use".
  return 0;
}

function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === "darwin" ? ["open", [url]]
    : os === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];

  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => noteManualOpen(url));
    child.unref();
  } catch {
    noteManualOpen(url);
  }
}

function noteManualOpen(url: string): void {
  process.stdout.write(`\n  Couldn't open your browser automatically.\n  Go to ${url}\n\n`);
}

export async function launch(): Promise<void> {
  const port = await pickPort();
  const actual = await startServer(port);
  const url = `http://localhost:${actual}`;

  process.stdout.write(
    `\n  LocalHarness is running.\n` +
      `  ${url}\n\n` +
      `  Everything stays on this computer. Close this window to stop.\n\n`,
  );

  if (!process.env.LOCALHARNESS_NO_BROWSER) openBrowser(url);
}

const invokedDirectly = process.argv[1]?.endsWith("desktop.js");
if (invokedDirectly) {
  launch().catch((e: Error) => {
    process.stderr.write(`\n  LocalHarness couldn't start: ${e.message}\n\n`);
    process.exitCode = 1;
  });
}
