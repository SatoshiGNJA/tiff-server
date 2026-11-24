// Tiff's Facility multiplayer relay.
// Players connect over WebSocket. One player creates a room and gets a code (e.g. TIFF-4821);
// friends join with that code. The server just passes messages between players in the same room.
//   client -> server: {"t":"create"} | {"t":"join","code":"TIFF-4821"} | {"t":"msg","to":<id or omitted for everyone>, ...anything}
//   server -> client: {"t":"created","code","id"} | {"t":"joined","code","id","host","peers":[ids]}
//                     {"t":"peer_join","id"} | {"t":"peer_leave","id"} | {"t":"host_left"} | {"t":"error","why"}
//                     {"t":"msg","from":<id>, ...anything}
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8130;
const MAX_PLAYERS = 4;
const rooms = new Map(); // code -> {host: id, players: Map(id -> ws)}
let nextId = 1;

const server = http.createServer((req, res) => {
  // Render pings this to check the server is alive
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end("Tiff's Facility server is running. Rooms open: " + rooms.size + "\n");
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function newCode() {
  let code;
  do {
    code = "TIFF-" + String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  room.players.delete(ws.id);
  if (room.host === ws.id) {
    // the host runs the monsters; without them the game can't go on
    for (const p of room.players.values()) {
      send(p, { t: "host_left" });
      p.room = null;
    }
    rooms.delete(ws.room);
  } else {
    for (const p of room.players.values()) send(p, { t: "peer_leave", id: ws.id });
  }
  ws.room = null;
}

wss.on("connection", (ws) => {
  ws.id = nextId++;
  ws.room = null;
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (data) => {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === "create") {
      leave(ws);
      const code = newCode();
      rooms.set(code, { host: ws.id, players: new Map([[ws.id, ws]]) });
      ws.room = code;
      send(ws, { t: "created", code, id: ws.id });
    } else if (m.t === "join") {
      const code = String(m.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", why: "No room with that code." });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: "error", why: "That room is full." });
      leave(ws);
      for (const p of room.players.values()) send(p, { t: "peer_join", id: ws.id });
      send(ws, { t: "joined", code, id: ws.id, host: room.host, peers: [...room.players.keys()] });
      room.players.set(ws.id, ws);
      ws.room = code;
    } else if (m.t === "msg") {
      const room = rooms.get(ws.room);
      if (!room) return;
      const to = m.to;
      m.from = ws.id;
      delete m.to;
      const out = JSON.stringify(m);
      if (to !== undefined) {
        const p = room.players.get(to);
        if (p && p.readyState === 1) p.send(out);
      } else {
        for (const [id, p] of room.players) if (id !== ws.id && p.readyState === 1) p.send(out);
      }
    }
  });

  ws.on("close", () => leave(ws));
});

// drop dead connections (phones that lost signal) every 20 s
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log("Tiff's Facility server on port " + PORT));
