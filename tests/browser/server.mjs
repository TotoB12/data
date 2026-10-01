import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { WebSocketServer } from "ws";

const root = resolve(".output/public");
const states = new Map();
const headers = Object.fromEntries((await readFile("_headers", "utf8")).split("\n").slice(1).filter(x => x.trim()).map(line => {
  const colon = line.indexOf(":"); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}));
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8787");
  if (url.pathname === "/__test/state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(states.get(url.searchParams.get("key")) || {})); return; }
  const path = resolve(root, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
  if (!path.startsWith(root + "/") && !path.startsWith(root + "\\")) { response.writeHead(403); response.end(); return; }
  try {
    const data = await readFile(path);
    response.writeHead(200, { ...headers, "Content-Type": ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".ttf": "font/ttf", ".png": "image/png" })[extname(path)] || "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
const sockets = new WebSocketServer({ server, path: "/api/control", perMessageDeflate: false });
sockets.on("connection", (socket, request) => {
  const key = request.headers.cookie?.match(/data-test=([^;]+)/)?.[1] || "default";
  const state = states.get(key) || { sockets: 0, checkpoints: 0 };
  states.set(key, state); state.sockets++;
  socket.send(JSON.stringify({ type: "ready", userId: "alice", rankedEnabled: true, profile: { alias: "Flood-Alice", totalBytes: 0 } }));
  socket.on("message", raw => {
    const m = JSON.parse(raw.toString());
    if (m.type === "start") socket.send(JSON.stringify({ type: "grant", token: "bounded-test-grant", deadline: Date.now() + 60000, maxBytes: 16384 }));
    if (m.type === "checkpoint") {
      state.checkpoints++;
      const proof = JSON.parse(Buffer.from(m.receipts[0].split(".")[0], "base64url").toString());
      socket.send(JSON.stringify({ type: "accepted", acknowledgements: [{ run: proof.run, day: proof.day, bytes: proof.bytes }], profile: { alias: "Flood-Alice", totalBytes: proof.bytes } }));
    }
  });
});
server.listen(8787, "127.0.0.1");
