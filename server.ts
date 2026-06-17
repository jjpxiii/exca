import { serveDir } from "jsr:@std/http/file-server";
import { neon } from "npm:@neondatabase/serverless";

const dbUrl = Deno.env.get("DATABASE_URL");
const sql = dbUrl ? neon(dbUrl) : null;

if (sql) {
  try {
    await sql`CREATE TABLE IF NOT EXISTS canvases (id VARCHAR(50) PRIMARY KEY, data TEXT)`;
  } catch (e) {
    console.error("Erreur lors de la vérification de la table :", e);
  }
} else {
  console.warn("⚠️ DATABASE_URL non définie. Le mode persistance en base de données est désactivé.");
}

// In-memory state for fast syncing and presence
const localRooms = new Map<string, Set<WebSocket>>();
const channels = new Map<string, BroadcastChannel>();
const latestSnapshots = new Map<string, any>();
const presenceCount = new Map<string, number>();

function getChannel(roomId: string) {
  if (!channels.has(roomId)) {
    const channel = new BroadcastChannel(`room-${roomId}`);
    channel.onmessage = (e) => {
      // Received a message from another isolate
      const data = JSON.parse(e.data);
      
      if (data.type === "scene") {
        latestSnapshots.set(roomId, data.snapshot);
      } else if (data.type === "_presence_sync") {
        // Sync presence across isolates if needed
        return;
      }
      
      broadcastLocal(roomId, e.data);
    };
    channels.set(roomId, channel);
  }
  return channels.get(roomId)!;
}

function broadcastLocal(roomId: string, message: string, excludeSocket?: WebSocket) {
  const sockets = localRooms.get(roomId);
  if (sockets) {
    for (const socket of sockets) {
      if (socket !== excludeSocket && socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }
}

function broadcastAll(roomId: string, message: string, excludeSocket?: WebSocket) {
  broadcastLocal(roomId, message, excludeSocket);
  getChannel(roomId).postMessage(message);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  
  if (url.pathname === "/api/canvas") {
    const roomId = url.searchParams.get("room") || "main";
    
    if (req.method === "GET") {
      try {
        let data = latestSnapshots.get(roomId);
        if (!data && sql) {
          const rows = await sql`SELECT data FROM canvases WHERE id = ${roomId}`;
          data = rows.length > 0 ? JSON.parse(rows[0].data) : null;
          if (data) latestSnapshots.set(roomId, data);
        }
        return new Response(JSON.stringify(data || { elements: [], appState: {} }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("GET error:", err);
        return new Response(JSON.stringify({ elements: [], appState: {} }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    if (req.method === "POST") {
      try {
        const text = await req.text();
        latestSnapshots.set(roomId, JSON.parse(text)); // update local cache
        if (sql) {
          await sql`
            INSERT INTO canvases (id, data) 
            VALUES (${roomId}, ${text})
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
          `;
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("POST error:", err);
        return new Response(JSON.stringify({ error: "Failed to save" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  }

  const collabMatch = url.pathname.match(/^\/api\/collab\/([^/]+)$/);
  if (collabMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const roomId = collabMatch[1];
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    socket.onopen = async () => {
      if (!localRooms.has(roomId)) localRooms.set(roomId, new Set());
      localRooms.get(roomId)!.add(socket);
      
      const count = (presenceCount.get(roomId) || 0) + 1;
      presenceCount.set(roomId, count);

      let snapshot = latestSnapshots.get(roomId);
      if (!snapshot && sql) {
        try {
          const rows = await sql`SELECT data FROM canvases WHERE id = ${roomId}`;
          if (rows.length > 0) {
            snapshot = JSON.parse(rows[0].data);
            latestSnapshots.set(roomId, snapshot);
          }
        } catch (e) {
          console.error("DB fetch error on connect", e);
        }
      }

      // Send initial data to connected client
      socket.send(JSON.stringify({
        type: "init",
        snapshot: snapshot || { elements: [], appState: {}, files: {} },
        peers: count,
        revision: 1
      }));

      // Broadcast presence to everyone
      broadcastAll(roomId, JSON.stringify({ type: "presence", peers: count }), socket);
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "scene") {
          latestSnapshots.set(roomId, msg.snapshot);
          // Broadcast to everyone else
          broadcastAll(roomId, JSON.stringify({
            type: "scene",
            snapshot: msg.snapshot,
            revision: 1,
            clientId: msg.clientId
          }), socket);
        }
      } catch (err) {
        console.error("WS Message error", err);
      }
    };

    socket.onclose = () => {
      localRooms.get(roomId)?.delete(socket);
      const count = Math.max(0, (presenceCount.get(roomId) || 1) - 1);
      presenceCount.set(roomId, count);
      
      broadcastAll(roomId, JSON.stringify({ type: "presence", peers: count }));
    };

    return response;
  }

  // Fallback: servir l'application React
  return serveDir(req, {
    fsRoot: "dist",
    showIndex: true,
    quiet: true,
  });
});
