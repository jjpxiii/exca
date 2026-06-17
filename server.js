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

app.use(cors());

// We need raw text for canvas data to preserve exact JSON formatting,
// but we need standard json parsing for API routes like /lock
app.use(express.text({ type: 'text/plain' }));
app.use(express.json({ limit: '50mb' })); 

const dbUrl = process.env.DATABASE_URL;
const sql = dbUrl ? neon(dbUrl) : null;

if (sql) {
  try {
    await sql`CREATE TABLE IF NOT EXISTS canvases (id VARCHAR(50) PRIMARY KEY, data TEXT)`;
    await sql`ALTER TABLE canvases ADD COLUMN IF NOT EXISTS password VARCHAR(255), ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`;
    console.log("Base de données connectée et vérifiée.");
  } catch (e) {
    console.error("Erreur lors de la vérification de la table :", e);
  }
} else {
  console.warn("⚠️ DATABASE_URL non définie. Le mode persistance en base de données est désactivé.");
}

const localRooms = new Map();
const latestSnapshots = new Map();
const presenceCount = new Map();

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

// 1. Get most recently updated room
app.get('/api/recent-room', async (req, res) => {
  if (!sql) return res.json({ id: 'main' });
  try {
    const rows = await sql`SELECT id FROM canvases ORDER BY updated_at DESC NULLS LAST LIMIT 1`;
    if (rows.length > 0) return res.json({ id: rows[0].id });
    res.json({ id: 'main' });
  } catch (e) {
    res.json({ id: 'main' });
  }
});

// 2. Get list of all rooms for the dashboard
app.get('/api/rooms', async (req, res) => {
  if (!sql) {
    const rooms = Array.from(latestSnapshots.keys()).map(id => {
      const data = latestSnapshots.get(id);
      return {
        id,
        name: data?.appState?.name || "Untitled Board",
        updated_at: new Date().toISOString(),
        locked: false
      };
    });
    return res.json(rooms);
  }
  try {
    const rows = await sql`
      SELECT 
        id, 
        data, 
        updated_at, 
        (password IS NOT NULL AND password != '') as locked 
      FROM canvases 
      ORDER BY updated_at DESC NULLS LAST 
      LIMIT 50
    `;
    
    const safeRows = rows.map(r => {
      let name = "Untitled Board";
      try {
        const parsed = JSON.parse(r.data);
        if (parsed?.appState?.name) name = parsed.appState.name;
      } catch(e) {}
      
      return {
        id: r.id,
        name: name,
        updated_at: r.updated_at,
        locked: r.locked
      };
    });
    
    res.json(safeRows);
  } catch (e) {
    console.error("GET /api/rooms error:", e);
    res.status(500).json([]);
  }
});

// 3. Lock a room
app.post('/api/room/lock', async (req, res) => {
  const { roomId, password } = req.body;
  if (!sql) return res.status(500).json({ error: "DB not configured" });
  try {
    await sql`UPDATE canvases SET password = ${password || null} WHERE id = ${roomId}`;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to lock" });
  }
});

app.get('/api/canvas', async (req, res) => {
  const roomId = req.query.room || 'main';
  const pwd = req.query.pwd || '';
  
  try {
    if (sql) {
      const rows = await sql`SELECT data, password FROM canvases WHERE id = ${roomId}`;
      if (rows.length > 0) {
        const dbPwd = rows[0].password;
        if (dbPwd && dbPwd !== pwd) {
          return res.status(401).json({ error: "locked" });
        }
        const parsed = JSON.parse(rows[0].data);
        latestSnapshots.set(roomId, parsed);
        return res.json(parsed);
      }
    }
    
    let data = latestSnapshots.get(roomId);
    res.json(data || { elements: [], appState: {} });
  } catch (err) {
    console.error("GET error:", err);
    res.status(500).json({ elements: [], appState: {} });
  }
});

// We accept raw text or json objects on POST
app.post('/api/canvas', async (req, res) => {
  const roomId = req.query.room || 'main';
  try {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    latestSnapshots.set(roomId, JSON.parse(text));
    
    if (sql) {
      await sql`
        INSERT INTO canvases (id, data, updated_at) 
        VALUES (${roomId}, ${text}, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
      `;
    }
    res.json({ success: true });
  } catch (err) {
    console.error("POST error:", err);
    res.status(500).json({ error: "Failed to save" });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const collabMatch = url.pathname.match(/^\/api\/collab\/([^/]+)$/);
  
  if (!collabMatch) {
    socket.close(1008, "Invalid URL");
    return;
  }
  
  const roomId = collabMatch[1];
  const pwd = url.searchParams.get("pwd") || '';
  
  let snapshot = latestSnapshots.get(roomId);

  if (sql) {
    try {
      const rows = await sql`SELECT data, password FROM canvases WHERE id = ${roomId}`;
      if (rows.length > 0) {
        const dbPwd = rows[0].password;
        if (dbPwd && dbPwd !== pwd) {
          socket.close(4001, "locked");
          return;
        }
        snapshot = JSON.parse(rows[0].data);
        latestSnapshots.set(roomId, snapshot);
      }
    } catch (e) {
      console.error("DB fetch error on WS connect", e);
    }
  }

  if (!localRooms.has(roomId)) localRooms.set(roomId, new Set());
  localRooms.get(roomId).add(socket);
  
  const count = (presenceCount.get(roomId) || 0) + 1;
  presenceCount.set(roomId, count);

  socket.send(JSON.stringify({
    type: "init",
    snapshot: snapshot || { elements: [], appState: {}, files: {} },
    peers: count,
    revision: 1
  }));

  broadcastLocal(roomId, JSON.stringify({ type: "presence", peers: count }), socket);

  socket.on('message', (data) => {
    try {
      const msgText = data.toString('utf-8');
      const msg = JSON.parse(msgText);
      
      if (msg.type === "scene") {
        latestSnapshots.set(roomId, msg.snapshot);
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
