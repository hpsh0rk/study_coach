import "@fontsource/arimo/400.css";
import "@fontsource/arimo/700.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/700.css";
import "katex/dist/katex.min.css";
import "@kj/renderer/renderer.css";
import "@kj/player/player.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
