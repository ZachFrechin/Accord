import React from "react";
import ReactDOM from "react-dom/client";

import { applyCustomize, useCustomizeStore } from "@accord/core/stores/useCustomizeStore";

import App from "./App";
import "./styles.css";

// Les réglages d'apparence sont posés sur :root AVANT le premier rendu, sinon
// l'écran s'affiche une fraction de seconde avec les valeurs par défaut.
applyCustomize(useCustomizeStore.getState());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
