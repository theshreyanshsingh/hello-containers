const http = require("http");
const WebSocket = require("ws");
const pty = require("node-pty");
const { v4: uuidv4 } = require("uuid");

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        activeTerminals: terminals.size,
      })
    );
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Terminal Server Ready\nWebSocket endpoint: /ws\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocket.Server({
  server,
  path: "/ws",
  perMessageDeflate: true, // Enable compression
});

// Store active terminals
const terminals = new Map();

// Cleanup function for terminals
function cleanupTerminal(terminalId) {
  const terminal = terminals.get(terminalId);
  if (terminal) {
    console.log(`Cleaning up terminal: ${terminalId}`);
    terminal.ws = null;
    if (terminal.shell && !terminal.shell.killed) {
      terminal.shell.kill();
    }
    terminals.delete(terminalId);
  }
}

wss.on("connection", (ws, req) => {
  const terminalId = uuidv4();
  console.log(
    `New terminal connection: ${terminalId} from ${
      req.headers["x-forwarded-for"] || req.connection.remoteAddress
    }`
  );

  // Determine shell based on environment
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? [] : ["--login"];

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.env.USERPROFILE || "/home/nodejs",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        TERMINAL_ID: terminalId,
        COLORTERM: "truecolor",
      },
    });
  } catch (error) {
    console.error("Failed to spawn shell:", error);
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Failed to create terminal session",
      })
    );
    ws.close();
    return;
  }

  // Store terminal reference
  terminals.set(terminalId, { shell: ptyProcess, ws });

  // Send initial connection info
  ws.send(
    JSON.stringify({
      type: "connected",
      terminalId: terminalId,
      message: `Connected to terminal ${terminalId}`,
      shell: shell,
      platform: process.platform,
    })
  );

  // Send welcome message
  ptyProcess.write(`echo "Welcome to terminal ${terminalId}"\n`);
  ptyProcess.write(`echo "Shell: ${shell} on ${process.platform}"\n`);
  ptyProcess.write(`echo "Type 'exit' to close the terminal"\n`);

  // Handle data from shell
  ptyProcess.on("data", (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            type: "data",
            terminalId: terminalId,
            data: data,
          })
        );
      } catch (error) {
        console.error("Error sending data to client:", error);
      }
    }
  });

  // Handle shell exit
  ptyProcess.on("exit", (code, signal) => {
    console.log(
      `Shell exited for terminal: ${terminalId}, code: ${code}, signal: ${signal}`
    );

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "exit",
          terminalId: terminalId,
          code: code,
          signal: signal,
          message: `Terminal session ended (exit code: ${code})`,
        })
      );
      ws.close();
    }
    cleanupTerminal(terminalId);
  });

  // Handle incoming WebSocket messages
  ws.on("message", (msg) => {
    try {
      let message;

      // Handle both JSON and plain text messages
      if (typeof msg === "string") {
        try {
          message = JSON.parse(msg);
        } catch {
          // If it's not JSON, treat as plain text input
          if (ptyProcess && !ptyProcess.killed) {
            ptyProcess.write(msg);
          }
          return;
        }
      } else {
        // Handle Buffer messages
        try {
          message = JSON.parse(msg.toString());
        } catch {
          // If it's not JSON, treat as plain text input
          if (ptyProcess && !ptyProcess.killed) {
            ptyProcess.write(msg.toString());
          }
          return;
        }
      }

      // Handle structured messages
      switch (message.type) {
        case "input":
          if (ptyProcess && !ptyProcess.killed) {
            ptyProcess.write(message.data);
          }
          break;

        case "resize":
          if (
            ptyProcess &&
            !ptyProcess.killed &&
            message.cols &&
            message.rows
          ) {
            try {
              ptyProcess.resize(message.cols, message.rows);
            } catch (error) {
              console.error("Error resizing terminal:", error);
            }
          }
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          break;

        default:
          console.log("Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  // Handle WebSocket close
  ws.on("close", (code, reason) => {
    console.log(
      `WebSocket closed for terminal: ${terminalId}, code: ${code}, reason: ${reason}`
    );
    cleanupTerminal(terminalId);
  });

  // Handle WebSocket errors
  ws.on("error", (error) => {
    console.error(`WebSocket error for terminal: ${terminalId}`, error);
    cleanupTerminal(terminalId);
  });

  // Send periodic keep-alive pings
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(keepAlive);
    }
  }, 30000);

  // Clean up interval on close
  ws.on("close", () => clearInterval(keepAlive));
});

// Handle server errors
server.on("error", (error) => {
  console.error("Server error:", error);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully");

  // Close all active terminals
  terminals.forEach((terminal, terminalId) => {
    cleanupTerminal(terminalId);
  });

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully");

  // Close all active terminals
  terminals.forEach((terminal, terminalId) => {
    cleanupTerminal(terminalId);
  });

  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

server.listen(8080, () => {
  console.log("Terminal server ready on port 8080");
  console.log("WebSocket endpoint: ws://localhost:8080/ws");
  console.log(`Platform: ${process.platform}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});
