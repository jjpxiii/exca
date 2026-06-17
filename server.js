import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { neon } from '@neondatabase/serverless';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Use Express to handle JSON and CORS
app.use(cors());
// We handle text manually to parse JSON directly from text like Deno did, 
// or we can use express.text() since the client sends raw text.
app.use(express.text({ type: '*/*' })); 

const dbUrl = process.env.DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

if (sql) {
  try {
    // Top-level await is supported in ES modules
    await sql`CREATE TABLE IF NOT EXISTS canvases (id VARCHAR(50) PRIMARY KEY, data TEXT)`;
    console.log("Base de données connectée.");
  } catch (e) {
    console.error("Erreur lors de la vérification de la table :", e);
  }
} else {
  console.warn("⚠️ DATABASE_URL non définie. Le mode persistance en base de données est désactivé.");
}

// In-memory state for fast syncing and presence
const localRooms = new Map(); // roomId -> Set<WebSocket>
const latestSnapshots = new Map(); // roomId -> snapshot object
const presenceCount = new Map(); // roomId -> number

function broadcastLocal(roomId, message, excludeSocket) {
  const sockets = localRooms.get(roomId);
  if (sockets) {
    for (const socket of sockets) {
      if (socket !== excludeSocket && socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }
}

// REST endpoints for Excalidraw Canvas
app.get('/api/canvas', async (req, res) => {
  const roomId = req.query.room || 'main';
  try {
    let data = latestSnapshots.get(roomId);
    if (!data && sql) {
      const rows = await sql`SELECT data FROM canvases WHERE id = ${roomId}`;
      data = rows.length > 0 ? JSON.parse(rows[0].data) : null;
      if (data) latestSnapshots.set(roomId, data);
    }
    res.json(data || { elements: [], appState: {} });
  } catch (err) {
    console.error("GET error:", err);
    res.status(500).json({ elements: [], appState: {} });
  }
});

app.post('/api/canvas', async (req, res) => {
  const roomId = req.query.room || 'main';
  try {
    const text = req.body;
    latestSnapshots.set(roomId, JSON.parse(text)); // update local cache
    
    if (sql) {
      await sql`
        INSERT INTO canvases (id, data) 
        VALUES (${roomId}, ${text})
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
      `;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST error:", err);
    res.status(500).json({ error: "Failed to save" });
  }
});

// Serve static files from 'dist' directory
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback to index.html for React Router
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', async (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const collabMatch = url.pathname.match(/^\/api\/collab\/([^/]+)$/);
  
  if (!collabMatch) {
    socket.close(1008, "Invalid URL");
    return;
  }
  
  const roomId = collabMatch[1];
  
  if (!localRooms.has(roomId)) localRooms.set(roomId, new Set());
  localRooms.get(roomId).add(socket);
  
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
  broadcastLocal(roomId, JSON.stringify({ type: "presence", peers: count }), socket);

  socket.on('message', (data) => {
    try {
      const msgText = data.toString('utf-8');
      const msg = JSON.parse(msgText);
      
      if (msg.type === "scene") {
        latestSnapshots.set(roomId, msg.snapshot);
        // Broadcast to everyone else
        broadcastLocal(roomId, JSON.stringify({
          type: "scene",
          snapshot: msg.snapshot,
          revision: 1,
          clientId: msg.clientId
        }), socket);
      }
    } catch (err) {
      console.error("WS Message error", err);
    }
  });

  socket.on('close', () => {
    localRooms.get(roomId)?.delete(socket);
    const newCount = Math.max(0, (presenceCount.get(roomId) || 1) - 1);
    presenceCount.set(roomId, newCount);
    
    broadcastLocal(roomId, JSON.stringify({ type: "presence", peers: newCount }));
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Serveur Node.js démarré sur http://localhost:${PORT}`);
});
