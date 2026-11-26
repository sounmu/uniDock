import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { announcePanel } from "../../src/panel-presence";
import "./style.css";
// While this page is open, its window shows work here instead of in the LMS pill.
if (__UNIDOCK_AI_CAPTIONS__ || __UNIDOCK_PLAYBACK__) announcePanel();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
