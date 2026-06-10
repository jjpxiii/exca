import { useState, useEffect } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./index.css";

export default function App() {
  const [initialData, setInitialData] = useState<any>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetch("/api/canvas")
      .then(res => res.json())
      .then(data => {
        setInitialData(data);
      })
      .catch(err => {
        console.error("Erreur de chargement", err);
        setInitialData({ elements: [], appState: {} });
      });
  }, []);

  const handleSave = async () => {
    if (!excalidrawAPI) return;
    setIsSaving(true);
    const elements = excalidrawAPI.getSceneElements();
    try {
      await fetch("/api/canvas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elements })
      });
      alert("Canvas sauvegardé sur Cloudflare KV !");
    } catch (e) {
      console.error("Failed to save", e);
      alert("Erreur lors de la sauvegarde.");
    }
    setIsSaving(false);
  };

  if (!initialData) {
    return (
      <div className="loading-screen">
        <span className="loader"></span>
        <div style={{ color: "#4f46e5", fontWeight: 500, fontSize: "0.95rem" }}>Chargement de l'espace...</div>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <Excalidraw 
        excalidrawAPI={(api) => setExcalidrawAPI(api)} 
        initialData={initialData} 
        renderTopRightUI={() => (
          <button 
            className="btn-primary"
            onClick={handleSave} 
            disabled={isSaving}
          >
            {isSaving ? "Sauvegarde en cours..." : "💾 Sauvegarder (Cloud)"}
          </button>
        )}
      />
    </div>
  );
}
