const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  let file = req.url === "/" ? "/index.html" : req.url;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(__dirname, "public", file);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {"Content-Type": "text/plain"});
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };
    res.writeHead(200, {"Content-Type": types[ext] || "application/octet-stream"});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

const SIZE = 10;
const V_EDGES = SIZE + 1; // 11 vertical edge columns
const H_EDGES = SIZE + 1; // 11 horizontal edge rows

function newGame() {
  return {
    h: Array.from({length: H_EDGES}, () => Array(SIZE).fill(null)),
    v: Array.from({length: SIZE}, () => Array(V_EDGES).fill(null)),
    boxes: Array.from({length: SIZE}, () => Array(SIZE).fill(null)),
    turn: 0,
    scores: [0, 0],
    winner: null
  };
}

function validEdge(type, r, c) {
  if (type === "h") return r >= 0 && r <= SIZE && c >= 0 && c < SIZE;
  return r >= 0 && r < SIZE && c >= 0 && c <= SIZE;
}

function edgeTaken(game, type, r, c) {
  return type === "h" ? game.h[r][c] !== null : game.v[r][c] !== null;
}

function completedBoxes(game, type, r, c) {
  const out = [];
  if (type === "h") {
    if (r > 0 && game.h[r-1][c] !== null && game.v[r-1][c] !== null && game.v[r-1][c+1] !== null)
      out.push([r-1, c]);
    if (r < SIZE && game.h[r+1][c] !== null && game.v[r][c] !== null && game.v[r][c+1] !== null)
      out.push([r, c]);
  } else {
    if (c > 0 && game.v[r][c-1] !== null && game.h[r][c-1] !== null && game.h[r+1][c-1] !== null)
      out.push([r, c-1]);
    if (c < SIZE && game.v[r][c+1] !== null && game.h[r][c] !== null && game.h[r+1][c] !== null)
      out.push([r, c]);
  }
  return out.filter(([br, bc]) => game.boxes[br][bc] === null);
}

function publicState(room) {
  return {
    room: room.code,
    game: room.game,
    players: room.players.map(p => ({id: p.id, name: p.name, index: p.index})),
    connected: room.players.filter(p => p.ws && p.ws.readyState === WebSocket.OPEN).length
  };
}

function broadcast(room) {
  const payload = JSON.stringify({type: "state", ...publicState(room)});
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
  });
}

function getRoom(code) {
  return rooms.get(code.toUpperCase());
}

function makeCode() {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase();
  while (rooms.has(code));
  return code;
}

function cleanupRoom(room) {
  if (room.players.every(p => !p.ws || p.ws.readyState !== WebSocket.OPEN)) {
    rooms.delete(room.code);
  }
}

wss.on("connection", ws => {
  console.log('WebSocket connection established');
  let player = null;
  let room = null;

  ws.on("message", raw => {
    try { console.log('WS message:', raw.toString()); } catch (e) { console.log('WS message (unprintable)'); }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "create") {
      if (room) return;
      room = {code: makeCode(), game: newGame(), players: []};
      player = {id: crypto.randomUUID(), name: String(msg.name || "Player 1").slice(0,20), index: 0, ws};
      room.players.push(player);
      rooms.set(room.code, room);
      console.log(`Room created: ${room.code} (by ${player.name} / ${player.id})`);
      ws.send(JSON.stringify({type:"created", room: room.code, playerId: player.id, playerIndex: 0}));
      broadcast(room);
      return;
    }

    if (msg.type === "join") {
      if (room) return;
      const code = String(msg.room || "").trim().toUpperCase();
      console.log(`Join attempt for room: '${code}' (name=${String(msg.name||"")})`);
      room = getRoom(code);
      if (!room) {
        console.log(`Join failed: room not found: ${code}`);
        return ws.send(JSON.stringify({type:"error", message:"Room not found. Check the code."}));
      }
      if (room.players.length >= 2) return ws.send(JSON.stringify({type:"error", message:"This room is full."}));

      player = {id: crypto.randomUUID(), name: String(msg.name || "Player 2").slice(0,20), index: 1, ws};
      room.players.push(player);
      console.log(`Player joined room ${room.code}: ${player.name} (${player.id})`);
      ws.send(JSON.stringify({type:"joined", room: room.code, playerId: player.id, playerIndex: 1}));
      broadcast(room);
      return;
    }

    if (msg.type === "move") {
      if (!room || !player) return;
      if (room.players.length < 2) return ws.send(JSON.stringify({type:"error", message:"Waiting for the second player."}));
      const g = room.game;
      if (g.winner !== null) return;
      if (player.index !== g.turn) return ws.send(JSON.stringify({type:"error", message:"It is not your turn."}));

      const type = msg.edgeType === "v" ? "v" : "h";
      const r = Number(msg.r), c = Number(msg.c);
      if (!Number.isInteger(r) || !Number.isInteger(c) || !validEdge(type,r,c) || edgeTaken(g,type,r,c)) return;

      if (type === "h") g.h[r][c] = player.index;
      else g.v[r][c] = player.index;

      const boxes = completedBoxes(g, type, r, c);
      boxes.forEach(([br,bc]) => {
        g.boxes[br][bc] = player.index;
        g.scores[player.index]++;
      });

      if (g.scores[0] + g.scores[1] === SIZE * SIZE) {
        g.winner = g.scores[0] === g.scores[1] ? -1 : (g.scores[0] > g.scores[1] ? 0 : 1);
      } else if (boxes.length === 0) {
        g.turn = 1 - g.turn;
      }
      broadcast(room);
      return;
    }

    if (msg.type === "restart") {
      if (!room || !player || player.index !== 0) return;
      room.game = newGame();
      broadcast(room);
    }
  });

  ws.on("close", () => {
    if (player) player.ws = null;
    if (room) {
      broadcast(room);
      cleanupRoom(room);
    }
  });

  ws.on('error', err => console.error('WebSocket error:', err && err.stack ? err.stack : err));
});

server.listen(PORT, () => console.log(`Dots & Boxes running on port ${PORT}`));
