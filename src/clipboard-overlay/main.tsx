import React from "react";
import ReactDOM from "react-dom/client";
import ClipboardOverlay from "./ClipboardOverlay";
import "./ClipboardOverlay.css";
import "@/i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ClipboardOverlay />
  </React.StrictMode>,
);
