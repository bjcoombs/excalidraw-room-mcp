import { App } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import { RoomView } from "./app.js";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

const app = new App({ name: "excalidraw-room-view", version: "0.2.0" });
const container = document.getElementById("root");
if (container) createRoot(container).render(<RoomView app={app} />);
