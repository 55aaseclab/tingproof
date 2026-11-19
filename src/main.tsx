import { language, msg, setLanguage } from "./i18n.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error(msg("Missing #root element", "缺少 #root 挂载点"));

setLanguage(language());
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
