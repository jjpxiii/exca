import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
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
  | {
      type: "init";
      snapshot: BoardSnapshot;
      peers: number;
      revision: number;
    }
  | {
      type: "scene";
      snapshot: BoardSnapshot;
      revision: number;
      clientId: string;
    }
  | {
      type: "presence";
      peers: number;
    };

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

  return room && ROOM_ID_PATTERN.test(room) ? room : "main";
}

function getClientId() {
  const storageKey = "whiteboard-client-id";
  const existing = window.localStorage.getItem(storageKey);

  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  window.localStorage.setItem(storageKey, id);
  return id;
}

function createRoomId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 18);
}

function pickSharedAppState(
  appState: AppState,
): ExcalidrawInitialDataState["appState"] {
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    name: appState.name,
  };
}

function getWebSocketUrl(roomId: string, clientId: string) {
  const url = new URL(`/api/collab/${encodeURIComponent(roomId)}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);

  return url.toString();
}

export default function App() {
  const [roomId] = useState(getRoomId);
  const [clientId] = useState(getClientId);
  const [initialData, setInitialData] = useState<BoardSnapshot | null>(null);
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [peerCount, setPeerCount] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Save");
  const socketRef = useRef<WebSocket | null>(null);
  const latestSnapshotRef = useRef<BoardSnapshot>(EMPTY_BOARD);
  const sendTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const applyingRemoteSceneRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    fetch(`/api/canvas?room=${encodeURIComponent(roomId)}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Canvas load failed: ${res.status}`);
        }

        return res.json() as Promise<BoardSnapshot>;
      })
      .then((data) => {
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
        console.error("Canvas load failed", err);
        latestSnapshotRef.current = EMPTY_BOARD;
        setInitialData(EMPTY_BOARD);
      });
  }, [roomId]);

  useEffect(() => {
    if (!initialData || !excalidrawAPI) {
      return;
    }

    let closedByEffect = false;

    const connect = () => {
      if (!mountedRef.current || closedByEffect) {
        return;
      }

      setConnectionState("connecting");
      const socket = new WebSocket(getWebSocketUrl(roomId, clientId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (socketRef.current === socket) {
          setConnectionState("connected");
        }
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

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (!closedByEffect && mountedRef.current) {
          setConnectionState("offline");
          reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_MS);
        }
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    const applyRemoteSnapshot = (snapshot: BoardSnapshot) => {
      latestSnapshotRef.current = snapshot;
      applyingRemoteSceneRef.current = true;
      excalidrawAPI.updateScene({
        elements: snapshot.elements,
      });

      if (snapshot.files) {
        excalidrawAPI.addFiles(Object.values(snapshot.files));
      }

      window.setTimeout(() => {
        applyingRemoteSceneRef.current = false;
      }, 0);
    };

    connect();

    return () => {
      closedByEffect = true;

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      socketRef.current?.close();
    };
  }, [clientId, excalidrawAPI, initialData, roomId]);

  const sendSnapshot = useCallback((snapshot: BoardSnapshot) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "scene",
        clientId,
        snapshot,
      }),
    );
  }, [clientId]);

  const handleChange = useCallback(
    (
      elements: BoardSnapshot["elements"],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (applyingRemoteSceneRef.current) {
        return;
      }

      const snapshot: BoardSnapshot = {
        elements,
        appState: pickSharedAppState(appState),
        files,
        updatedAt: Date.now(),
      };

      latestSnapshotRef.current = snapshot;

      if (sendTimerRef.current) {
        window.clearTimeout(sendTimerRef.current);
      }

      sendTimerRef.current = window.setTimeout(() => {
        sendSnapshot(snapshot);
      }, SEND_DEBOUNCE_MS);
    },
    [sendSnapshot],
  );

  const handleSave = async () => {
    if (!excalidrawAPI) {
      return;
    }

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
      await fetch(`/api/canvas?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
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
    const url = new URL(window.location.href);
    url.searchParams.set("room", createRoomId());
    window.location.href = url.toString();
  };

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
              {connectionState === "connected"
                ? `${peerCount} online`
                : connectionState}
            </span>
            <span className="room-pill">{roomId}</span>
            <button className="btn-secondary" type="button" onClick={handleShare}>
              Share
            </button>
            <button className="btn-secondary" type="button" onClick={handleNewBoard}>
              New
            </button>
            <button
              className="btn-primary"
              type="button"
              onClick={handleSave}
              disabled={isSaving}
            >
              {saveLabel}
            </button>
          </div>
        )}
      />
    </div>
  );
}
