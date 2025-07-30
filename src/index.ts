import { Container, getContainer, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";

export class MyContainer extends Container<Env> {
  // Port the container listens on (default: 8080)
  defaultPort = 8080;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "5m";
  // Environment variables passed to the container
  envVars = {
    TERM: "xterm-256color",
    SHELL: "/bin/bash",
  };

  // Optional lifecycle hooks
  onStart() {
    console.log("Terminal container successfully started");
  }

  onStop() {
    console.log("Terminal container successfully shut down");
  }

  onError(error: unknown) {
    console.log("Terminal container error:", error);
  }
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: Env;
}>();

// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "Terminal-as-a-Service via Cloudflare Containers\n\n" +
      "Available endpoints:\n" +
      "GET /terminal/<SESSION_ID> - Create/connect to a terminal session\n" +
      "GET /ws - WebSocket endpoint for terminal communication\n" +
      "GET /health - Health check endpoint\n"
  );
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// WebSocket endpoint for terminal communication
app.get("/ws", async (c) => {
  const upgradeHeader = c.req.header("upgrade");
  if (upgradeHeader !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  // Create WebSocket pair
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  // Accept the WebSocket connection
  server.accept();

  // Get or create a container for this connection
  const sessionId = c.req.query("session") || "default";
  const containerId = c.env.MY_CONTAINER.idFromName(`terminal-${sessionId}`);
  const container = c.env.MY_CONTAINER.get(containerId);

  // Forward WebSocket messages to the container
  server.addEventListener("message", async (event) => {
    try {
      // Forward the message to the container's WebSocket endpoint
      await container.fetch("http://container/ws", {
        headers: {
          Upgrade: "websocket",
          Connection: "upgrade",
        },
        // Pass the WebSocket message data
        body: event.data,
      });
    } catch (error) {
      console.error("Error forwarding to container:", error);
      server.send(
        JSON.stringify({
          type: "error",
          message: "Failed to connect to terminal container",
        })
      );
    }
  });

  server.addEventListener("close", () => {
    console.log(`WebSocket connection closed for session: ${sessionId}`);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
});

// Route to create/connect to terminal sessions
app.get("/terminal/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  // Get container instance for this session
  const containerId = c.env.MY_CONTAINER.idFromName(`terminal-${sessionId}`);
  const container = c.env.MY_CONTAINER.get(containerId);

  try {
    // Forward the request to the container
    const response = await container.fetch(c.req.raw);
    return response;
  } catch (error) {
    console.error("Error connecting to terminal container:", error);
    return c.json(
      {
        error: "Failed to connect to terminal container",
        sessionId: sessionId,
      },
      500
    );
  }
});

// Route for HTTP requests to containers (for testing/health checks)
app.get("/container/:id", async (c) => {
  const id = c.req.param("id");
  const containerId = c.env.MY_CONTAINER.idFromName(`terminal-${id}`);
  const container = c.env.MY_CONTAINER.get(containerId);
  return await container.fetch(c.req.raw);
});

// Load balance requests across multiple containers
app.get("/lb", async (c) => {
  const container = await getRandom(c.env.MY_CONTAINER, 3);
  return await container.fetch(c.req.raw);
});

// Get a single container instance (singleton pattern)
app.get("/singleton", async (c) => {
  const container = getContainer(c.env.MY_CONTAINER);
  return await container.fetch(c.req.raw);
});

export default app;
