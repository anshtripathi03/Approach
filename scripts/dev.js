/**
 * dev.js — Starts `next dev` on the first available port starting from 3001.
 * If port 3001 is busy it tries 3002, 3003, … up to 3010.
 */

const net = require("net");
const { spawn } = require("child_process");

const START_PORT = 3001;
const MAX_PORT = 3010;

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findFreePort() {
  for (let port = START_PORT; port <= MAX_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

(async () => {
  const port = await findFreePort();

  if (!port) {
    console.error(
      `❌ No free port found between ${START_PORT} and ${MAX_PORT}. Free up a port and try again.`
    );
    process.exit(1);
  }

  console.log(`🚀 Starting Next.js dev server on port ${port}…`);

  const child = spawn("npx", ["next", "dev", "-p", String(port)], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });

  child.on("exit", (code) => process.exit(code ?? 0));
})();
