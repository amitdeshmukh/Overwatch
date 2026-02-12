import { createServer } from "node:http";
import { getDb, closeDb } from "../db/index.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { getDashboardState } from "./api.js";
import { getPageHtml } from "./page.js";

const log = createLogger("web");

// Initialize DB (read-only access, WAL handles concurrent reads)
getDb();

const html = getPageHtml();

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && req.url === "/api/state") {
    try {
      const state = getDashboardState();
      const json = JSON.stringify(state);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(json);
    } catch (err) {
      log.error("Failed to get dashboard state", { error: String(err) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const port = config.webPort;

server.listen(port, () => {
  log.info(`Web dashboard running at http://localhost:${port}`);
});

// Graceful shutdown
function shutdown() {
  log.info("Shutting down web server...");
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  // Force exit after 3s
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
