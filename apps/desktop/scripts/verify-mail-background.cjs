// Run with: node scripts/verify-mail-background.cjs
const NodeAssert = require("node:assert/strict");
const NodeChildProcess = require("node:child_process");
const NodeEvents = require("node:events");
const NodeFS = require("node:fs");
const NodeOS = require("node:os");
const NodePath = require("node:path");
async function verifyInElectron() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");
  const minimized = NodeEvents.once(window, "minimize");
  window.showInactive();
  window.minimize();
  await minimized;

  // The desktop host runs its backend in a separate Electron-as-Node process.
  const backend = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/mail-test-server.ts", "verify"],
    {
      cwd: NodePath.join(__dirname, "../../server"),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "inherit",
    },
  );
  const [code] = await NodeEvents.once(backend, "close");
  NodeAssert.equal(code, 0);
  NodeAssert.ok(window.isMinimized());
  console.log("Mail sync completed with the Electron window minimized.");
}

if (process.type === "browser") {
  const { app } = require("electron");
  verifyInElectron().then(
    () => app.quit(),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
} else {
  const userData = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mail-electron-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    NodeChildProcess.execFileSync(
      require("electron"),
      [`--user-data-dir=${userData}`, __filename],
      {
        stdio: "inherit",
        env,
      },
    );
  } finally {
    NodeFS.rmSync(userData, { recursive: true, force: true });
  }
}
