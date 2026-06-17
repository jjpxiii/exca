import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, getSceneVersion } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import "./index.css";

type ConnectionState = "connecting" | "connected" | "offline";

type BoardSnapshot = {
  elements: NonNullable<ExcalidrawInitialDataState["elements"]>;
  appState?: ExcalidrawInitialDataState["appState"];
  files?: BinaryFiles;
  updatedAt?: number;
};

type ServerMessage =
  | { type: "init"; snapshot: BoardSnapshot; peers: number; revision: number }
  | { type: "scene"; snapshot: BoardSnapshot; revision: number; clientId: string }
  | { type: "presence"; peers: number };

const EMPTY_BOARD: BoardSnapshot = {
  elements: [],
  appState: {},
  files: {},
};

const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const SEND_DEBOUNCE_MS = 180;
const RECONNECT_MS = 1200;

function getRoomId() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room")?.trim();
  return room && ROOM_ID_PATTERN.test(room) ? room : null;
}

function setRoomIdInUrl(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", id);
  window.location.href = url.toString();
}

function getClientId() {
  const storageKey = "whiteboard-client-id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem(storageKey, id);
  return id;
}

function createRoomId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 18);
}

function pickSharedAppState(appState: AppState): ExcalidrawInitialDataState["appState"] {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    name: appState.name,
  };
}

function getWebSocketUrl(roomId: string, clientId: string, pwd?: string) {
  const url = new URL(`/api/collab/${encodeURIComponent(roomId)}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  if (pwd) url.searchParams.set("pwd", pwd);
  return url.toString();
}

export default function App() {
  const [roomId] = useState(getRoomId);
  const [clientId] = useState(getClientId);
  
  // Auth states
  const [password, setPassword] = useState("");
  const [isLocked, setIsLocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  
  // Modals
  const [showBoardsModal, setShowBoardsModal] = useState(false);
  const [boards, setBoards] = useState<any[]>([]);
  const [showLockModal, setShowLockModal] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const [initialData, setInitialData] = useState<BoardSnapshot | null>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [peerCount, setPeerCount] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Save");

  const socketRef = useRef<WebSocket | null>(null);
  const latestSnapshotRef = useRef<BoardSnapshot>(EMPTY_BOARD);
  const sendTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const applyingRemoteSceneRef = useRef(false);
  const lastSceneVersionRef = useRef<number>(-1);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 1. Resolve room ID
  useEffect(() => {
    if (!roomId) {
      fetch("/api/recent-room")
        .then(r => r.json())
        .then(d => setRoomIdInUrl(d.id || "main"))
        .catch(() => setRoomIdInUrl("main"));
    }
  }, [roomId]);

  // 2. Fetch Initial Data
  useEffect(() => {
    if (!roomId) return;
    if (isLocked && !password) return;

    fetch(`/api/canvas?room=${encodeURIComponent(roomId)}&pwd=${encodeURIComponent(password)}`)
      .then(async (res) => {
        if (res.status === 401) {
          setIsLocked(true);
          throw new Error("LOCKED");
        }
        if (!res.ok) throw new Error(`Canvas load failed: ${res.status}`);
        return res.json() as Promise<BoardSnapshot>;
      })
      .then((data) => {
        setIsLocked(false);
        const snapshot = {
          ...EMPTY_BOARD,
          ...data,
          elements: data.elements ?? [],
          files: data.files ?? {},
        };
        latestSnapshotRef.current = snapshot;
        setInitialData(snapshot);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "LOCKED") return;
        console.error("Canvas load failed", err);
        latestSnapshotRef.current = EMPTY_BOARD;
        setInitialData(EMPTY_BOARD);
      });
  }, [roomId, password, isLocked]);

  // 3. Connect WebSocket
  useEffect(() => {
    if (!initialData || !excalidrawAPI || !roomId || isLocked) return;

    let closedByEffect = false;

    const connect = () => {
      if (!mountedRef.current || closedByEffect) return;

      setConnectionState("connecting");
      const socket = new WebSocket(getWebSocketUrl(roomId, clientId, password));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (socketRef.current === socket) setConnectionState("connected");
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "presence") {
          setPeerCount(Math.max(1, message.peers));
          return;
        }
        if (message.type === "init") {
          setPeerCount(Math.max(1, message.peers));
          if (message.snapshot.updatedAt && message.snapshot.updatedAt > (latestSnapshotRef.current.updatedAt ?? 0)) {
            applyRemoteSnapshot(message.snapshot);
          }
          return;
        }
        if (message.clientId !== clientId) {
          applyRemoteSnapshot(message.snapshot);
        }
      });

      socket.addEventListener("close", (e) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (e.code === 4001) {
          // Locked mid-session
          setIsLocked(true);
          return;
        }
        if (!closedByEffect && mountedRef.current) {
          setConnectionState("offline");
          reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_MS);
        }
      });

      socket.addEventListener("error", () => socket.close());
    };

    const applyRemoteSnapshot = (snapshot: BoardSnapshot) => {
      latestSnapshotRef.current = snapshot;
      lastSceneVersionRef.current = getSceneVersion(snapshot.elements);
      applyingRemoteSceneRef.current = true;
      excalidrawAPI.updateScene({ elements: snapshot.elements });
      if (snapshot.files) excalidrawAPI.addFiles(Object.values(snapshot.files));
      window.setTimeout(() => { applyingRemoteSceneRef.current = false; }, 0);
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [clientId, excalidrawAPI, initialData, roomId, isLocked, password]);

  const sendSnapshot = useCallback((snapshot: BoardSnapshot) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "scene", clientId, snapshot }));
  }, [clientId]);

  const handleChange = useCallback((elements: BoardSnapshot["elements"], appState: AppState, files: BinaryFiles) => {
    if (applyingRemoteSceneRef.current) return;
    const currentVersion = getSceneVersion(elements);
    if (currentVersion === lastSceneVersionRef.current) return;
    lastSceneVersionRef.current = currentVersion;

    const snapshot: BoardSnapshot = {
      elements,
      appState: pickSharedAppState(appState),
      files,
      updatedAt: Date.now(),
    };
    latestSnapshotRef.current = snapshot;

    if (sendTimerRef.current) window.clearTimeout(sendTimerRef.current);
    sendTimerRef.current = window.setTimeout(() => sendSnapshot(snapshot), SEND_DEBOUNCE_MS);
  }, [sendSnapshot]);

  const handleSave = async () => {
    if (!excalidrawAPI || !roomId) return;
    setIsSaving(true);
    setSaveLabel("Saving");

    const snapshot: BoardSnapshot = {
      elements: excalidrawAPI.getSceneElements(),
      appState: pickSharedAppState(excalidrawAPI.getAppState()),
      files: excalidrawAPI.getFiles(),
      updatedAt: Date.now(),
    };
    latestSnapshotRef.current = snapshot;

    try {
      const res = await fetch(`/api/canvas?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) throw new Error("Server error " + res.status);
      setSaveLabel("Saved");
    } catch (err: unknown) {
      console.error("Canvas save failed", err);
      setSaveLabel("Save failed");
    } finally {
      window.setTimeout(() => setSaveLabel("Save"), 1600);
      setIsSaving(false);
    }
  };

  const handleShare = async () => {
    await navigator.clipboard.writeText(window.location.href);
  };

  const handleNewBoard = () => {
    setRoomIdInUrl(createRoomId());
  };

  const openBoards = async () => {
    setShowBoardsModal(true);
    try {
      const res = await fetch("/api/rooms");
      const data = await res.json();
      setBoards(data);
    } catch (e) {}
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPassword(passwordInput);
    setIsLocked(false);
    setInitialData(null); // Force reload
  };

  const handleLockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/room/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, password: newPassword })
      });
      if (res.ok) {
        setShowLockModal(false);
        setPassword(newPassword);
      }
    } catch (err) {}
  };

  if (!roomId) {
    return <div className="loading-screen"><span className="loader"></span></div>;
  }

  if (isLocked) {
    return (
      <div className="modal-overlay">
        <form className="modal" onSubmit={handlePasswordSubmit}>
          <h2>🔒 Board Locked</h2>
          <p>Please enter the password to access this board.</p>
          <input
            type="password"
            autoFocus
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="Password..."
            className="input-field"
          />
          <div className="modal-actions">
            <button type="submit" className="btn-primary">Unlock</button>
            <button type="button" className="btn-secondary" onClick={() => setRoomIdInUrl("main")}>Go back</button>
          </div>
        </form>
      </div>
    );
  }

  if (!initialData) {
    return (
      <div className="loading-screen">
        <span className="loader"></span>
        <div className="loading-copy">Loading board...</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Excalidraw
        excalidrawAPI={(api) => setExcalidrawAPI(api)}
        initialData={initialData}
        isCollaborating={connectionState === "connected"}
        onChange={handleChange}
        renderTopRightUI={() => (
          <div className="collab-toolbar" aria-label="Collaboration controls">
            <span className={`connection-pill ${connectionState}`}>
              {connectionState === "connected" ? `${peerCount} online` : connectionState}
            </span>
            <span className="room-pill">{roomId}</span>
            <button className="btn-secondary" type="button" onClick={openBoards}>📁 My Boards</button>
            <button className="btn-secondary" type="button" onClick={() => setShowLockModal(true)}>🔒 Lock</button>
            <button className="btn-secondary" type="button" onClick={handleShare}>Share</button>
            <button className="btn-secondary" type="button" onClick={handleNewBoard}>New</button>
            <button className="btn-primary" type="button" onClick={handleSave} disabled={isSaving}>
              {saveLabel}
            </button>
          </div>
        )}
      />

      {showBoardsModal && (
        <div className="modal-overlay" onClick={() => setShowBoardsModal(false)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📁 My Boards</h2>
              <button className="close-btn" onClick={() => setShowBoardsModal(false)}>×</button>
            </div>
            <div className="boards-list">
              {boards.length === 0 ? <p>No boards found.</p> : boards.map(b => (
                <button key={b.id} className="board-card" onClick={() => setRoomIdInUrl(b.id)}>
                  <h3>{b.name || "Untitled Board"} {b.locked && "🔒"}</h3>
                  <small>ID: {b.id}</small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showLockModal && (
        <div className="modal-overlay" onClick={() => setShowLockModal(false)}>
          <form className="modal" onSubmit={handleLockSubmit} onClick={(e) => e.stopPropagation()}>
            <h2>🔒 Lock Board</h2>
            <p>Set a password to protect this board. Leave empty to unlock.</p>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password..."
              className="input-field"
            />
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowLockModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary">Save Password</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
