import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { resolve, dirname } from "path";
import { existsSync } from "fs";

// --- Application Menu (enables Cmd+C/V/X, Undo, etc.) ---
ApplicationMenu.setApplicationMenu([
  {
    label: "ForgeCouncil",
    submenu: [
      { role: "about" },
      { type: "divider" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "showAll" },
      { type: "divider" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "divider" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { type: "divider" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "divider" },
      { role: "close" },
    ],
  },
]);

// --- Find project root (walk up from the app bundle to find .forgecouncil/) ---
function findProjectRoot(): string | null {
  // In dev mode, the app binary is at:
  //   <project>/build/dev-macos-arm64/ForgeCouncil-dev.app/Contents/MacOS/bun
  // Walk up from the MacOS directory to find a directory containing .forgecouncil/ or package.json
  let dir = resolve(import.meta.dir);
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(resolve(dir, ".forgecouncil")) ||
      existsSync(resolve(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// --- Read session port from project's session files ---
async function getSessionPort(): Promise<number | null> {
  const root = findProjectRoot();
  if (!root) return null;

  try {
    const currentPath = resolve(root, ".forgecouncil/sessions/current.json");
    const file = Bun.file(currentPath);
    if (!(await file.exists())) return null;
    const session = await file.json();
    if (session.status !== "running") return null;

    // Verify the session is actually alive
    try {
      const res = await fetch(`http://localhost:${session.port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return session.port;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// --- Main ---
async function main() {
  const port = await getSessionPort();

  const win = new BrowserWindow({
    title: "ForgeCouncil",
    url: "views://main-ui/index.html",
    frame: { width: 1100, height: 750, x: 150, y: 100 },
  });

  if (port) {
    console.log(`[desktop] Found running session on port ${port}`);
    // Inject the port into the webview after DOM is ready
    win.webview.on("dom-ready", () => {
      win.webview.executeJavascript(
        `window.__forgecouncilPort = ${port}; window.dispatchEvent(new CustomEvent('forge-port', { detail: ${port} }));`
      );
    });
  }
}

main().catch(console.error);
