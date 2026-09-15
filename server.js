#!/usr/bin/env node
"use strict";
// Tetris Arena local multiplayer relay. No dependencies (Node core only).
// Run: node tetris-server.js   (optional: PORT=9000 node tetris-server.js)
// Then open tetris.html and enter this PC's address (e.g. http://192.168.0.5:8787)
// as the "local server" address. Devices on the same Wi-Fi/LAN can join too.

const http = require("http");
const os = require("os");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const STALE_MS = 25000;
const MAX_EVENTS = 500;

let db = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(__dirname, "tetris.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS single_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    character TEXT,
    difficulty TEXT,
    score INTEGER NOT NULL,
    level INTEGER,
    lines INTEGER,
    played_at TEXT NOT NULL
  )`);
} catch (e) {
  console.log("Warning: node:sqlite unavailable (" + e.message + "). Score history disabled; needs Node 22.5+.");
}

/** roomId -> { players: Map(id -> presenceObject), events: [{seq,topic,data,ts}], seq } */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { players: new Map(), events: [], seq: 0 });
  return rooms.get(id);
}
function cleanRoom(room) {
  const now = Date.now();
  for (const [id, p] of room.players) {
    if (now - p.ts > STALE_MS) room.players.delete(id);
  }
  if (room.events.length > MAX_EVENTS) room.events = room.events.slice(-MAX_EVENTS);
}
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
    "Cache-Control": "no-store"
  });
  res.end(data);
}
function readJsonBody(req, cb) {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e6) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) return cb(new Error("payload too large"));
    try { cb(null, JSON.parse(body || "{}")); }
    catch (e) { cb(e); }
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") { send(res, 204, {}); return; }

  if (req.method === "GET" && u.pathname === "/") {
    send(res, 200, { ok: true, name: "tetris-arena-relay", rooms: rooms.size });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/room") {
    const roomId = u.searchParams.get("roomId") || "";
    const room = getRoom(roomId);
    cleanRoom(room);
    send(res, 200, { players: Array.from(room.players.values()) });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/events") {
    const roomId = u.searchParams.get("roomId") || "";
    const since = Number(u.searchParams.get("since") || 0);
    const room = getRoom(roomId);
    send(res, 200, { events: room.events.filter((e) => e.seq > since) });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/presence") {
    readJsonBody(req, (err, data) => {
      if (err) { send(res, 400, { error: "bad json" }); return; }
      if (!data.roomId || !data.id) { send(res, 400, { error: "roomId and id required" }); return; }
      const room = getRoom(data.roomId);
      data.ts = Date.now();
      room.players.set(data.id, data);
      cleanRoom(room);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/event") {
    readJsonBody(req, (err, data) => {
      if (err) { send(res, 400, { error: "bad json" }); return; }
      if (!data.roomId || !data.topic) { send(res, 400, { error: "roomId and topic required" }); return; }
      const room = getRoom(data.roomId);
      room.seq += 1;
      room.events.push({ seq: room.seq, topic: data.topic, data: data.data, ts: Date.now() });
      cleanRoom(room);
      send(res, 200, { ok: true, seq: room.seq });
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/single-score") {
    if (!db) { send(res, 501, { error: "sqlite unavailable" }); return; }
    readJsonBody(req, (err, data) => {
      if (err) { send(res, 400, { error: "bad json" }); return; }
      if (!data.nickname || typeof data.score !== "number") { send(res, 400, { error: "nickname and score required" }); return; }
      const info = db.prepare(
        "INSERT INTO single_scores (nickname, character, difficulty, score, level, lines, played_at) VALUES (?,?,?,?,?,?,?)"
      ).run(
        String(data.nickname).slice(0, 20),
        String(data.character || "cat").slice(0, 20),
        String(data.difficulty || "normal").slice(0, 10),
        Math.max(0, Math.floor(data.score) || 0),
        Math.max(1, Math.floor(data.level) || 1),
        Math.max(0, Math.floor(data.lines) || 0),
        new Date().toISOString()
      );
      send(res, 200, { ok: true, id: info.lastInsertRowid });
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/single-scores") {
    if (!db) { send(res, 501, { error: "sqlite unavailable" }); return; }
    const nickname = u.searchParams.get("nickname");
    const sort = u.searchParams.get("sort") === "recent" ? "played_at DESC" : "score DESC";
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 50));
    const rows = nickname
      ? db.prepare(`SELECT * FROM single_scores WHERE nickname = ? ORDER BY ${sort} LIMIT ?`).all(nickname, limit)
      : db.prepare(`SELECT * FROM single_scores ORDER BY ${sort} LIMIT ?`).all(limit);
    send(res, 200, { scores: rows });
    return;
  }

  send(res, 404, { error: "not found" });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log("Tetris Arena local server running.");
  console.log("  - This PC:      http://localhost:" + PORT);
  for (const ip of lanAddresses()) {
    console.log("  - Same Wi-Fi:   http://" + ip + ":" + PORT);
  }
  console.log("Enter one of the addresses above as the \"local server\" address in tetris.html.");
  console.log("Press Ctrl+C to stop.");
});
