import { DurableObject } from "cloudflare:workers";

const DEFAULT_ROOM = "main";
const LEGACY_KEY = "canvas_data";
const STORAGE_KEY = "snapshot";
const EMPTY_SNAPSHOT = {
  elements: [],
  appState: {},
  files: {},
};
const EMPTY_CANVAS = JSON.stringify(EMPTY_SNAPSHOT);
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function getRoomNameFromSearch(request) {
  const url = new URL(request.url);
  const room = url.searchParams.get("room")?.trim();

  return room && ROOM_ID_PATTERN.test(room) ? room : DEFAULT_ROOM;
}

function getRoomNameFromPath(request) {
  const url = new URL(request.url);
  const room = url.pathname.split("/").pop()?.trim();

  return room && ROOM_ID_PATTERN.test(room) ? room : DEFAULT_ROOM;
}

function getCanvasKey(room) {
  return `canvas:${room}`;
}

function getClientId(request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId")?.trim();

  return clientId && ROOM_ID_PATTERN.test(clientId)
    ? clientId
    : crypto.randomUUID();
}

async function handleCanvasRequest(request, env) {
  const room = getRoomNameFromSearch(request);

  if (request.method === "GET") {
    try {
      const data =
        (await env.CANVAS_STORE.get(getCanvasKey(room))) ??
        (room === DEFAULT_ROOM ? await env.CANVAS_STORE.get(LEGACY_KEY) : null);

      return new Response(data || EMPTY_CANVAS, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Canvas load failed", error);

      return new Response(EMPTY_CANVAS, {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (request.method === "POST") {
    try {
      const data = await request.text();
      await env.CANVAS_STORE.put(getCanvasKey(room), data);

      if (room === DEFAULT_ROOM) {
        await env.CANVAS_STORE.put(LEGACY_KEY, data);
      }

      return Response.json({ success: true, room });
    } catch (error) {
      console.error("Canvas save failed", error);

      return Response.json({ error: "Failed to save" }, { status: 500 });
    }
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "GET, POST" },
  });
}

export class BoardRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.revision = 0;
    this.snapshot = EMPTY_SNAPSHOT;
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get(STORAGE_KEY);

      if (stored) {
        this.revision = stored.revision;
        this.snapshot = stored.snapshot;
      }
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [getClientId(request)]);
    server.send(
      JSON.stringify({
        type: "init",
        snapshot: this.snapshot,
        revision: this.revision,
        peers: this.peerCount,
      }),
    );
    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string") {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    if (payload.type !== "scene" || !Array.isArray(payload.snapshot?.elements)) {
      return;
    }

    this.revision += 1;
    this.snapshot = {
      ...payload.snapshot,
      updatedAt: payload.snapshot.updatedAt ?? Date.now(),
    };

    await this.ctx.storage.put(STORAGE_KEY, {
      revision: this.revision,
      snapshot: this.snapshot,
    });

    this.broadcast(
      {
        type: "scene",
        clientId: payload.clientId,
        snapshot: this.snapshot,
        revision: this.revision,
      },
      socket,
    );
  }

  webSocketClose(socket, code, reason) {
    socket.close(code, reason);
    this.broadcastPresence();
  }

  webSocketError(socket) {
    socket.close(1011, "WebSocket error");
    this.broadcastPresence();
  }

  get peerCount() {
    return this.ctx.getWebSockets().length;
  }

  broadcast(payload, except) {
    const message = JSON.stringify(payload);

    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) {
        socket.send(message);
      }
    }
  }

  broadcastPresence() {
    this.broadcast({
      type: "presence",
      peers: this.peerCount,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/canvas") {
      return handleCanvasRequest(request, env);
    }

    if (url.pathname.startsWith("/api/collab/")) {
      const room = getRoomNameFromPath(request);
      const durableObject = env.BOARD_ROOM.getByName(room);

      return durableObject.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
