#!/usr/bin/env node
"use strict";
// Tetris Arena multiplayer relay. Core modules only for the relay itself;
// the optional score DB uses local SQLite by default, or Postgres when a
// DATABASE_URL env var is set (e.g. a free Neon database on Render, so
// records survive redeploys instead of living on the ephemeral disk).
// Run: node server.js   (optional: PORT=9000 node server.js)
// Then open tetris-arena.html and enter this PC's address (e.g. http://192.168.0.5:8787)
// as the "local server" address. Devices on the same Wi-Fi/LAN can join too.

const http = require("http");
const os = require("os");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const STALE_MS = 25000;
const MAX_EVENTS = 500;
const DATABASE_URL = process.env.DATABASE_URL || "";

let db = null;   // node:sqlite mode (local, ephemeral on most cloud hosts)
let pg = null;   // { pool } postgres mode (persistent, e.g. Neon)

async function initScoreStore() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      const useSSL = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
      const pool = new Pool({ connectionString: DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false });
      await pool.query(`CREATE TABLE IF NOT EXISTS single_scores (
        id SERIAL PRIMARY KEY,
        nickname TEXT NOT NULL,
        character TEXT,
        difficulty TEXT,
        score INTEGER NOT NULL,
        level INTEGER,
        lines INTEGER,
        played_at TEXT NOT NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS multi_results (
        id SERIAL PRIMARY KEY,
        nickname TEXT NOT NULL,
        character TEXT,
        mode TEXT,
        team_mode BOOLEAN,
        rounds INTEGER,
        players INTEGER,
        wins INTEGER,
        total_score INTEGER,
        placement INTEGER,
        result TEXT,
        played_at TEXT NOT NULL
      )`);
      pg = { pool };
      console.log("Score DB: connected to Postgres (DATABASE_URL) — records persist across redeploys.");
      return;
    } catch (e) {
      console.log("Warning: DATABASE_URL is set but Postgres init failed (" + e.message + "). Falling back to local SQLite.");
      pg = null;
    }
  }
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
    db.exec(`CREATE TABLE IF NOT EXISTS multi_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      character TEXT,
      mode TEXT,
      team_mode INTEGER,
      rounds INTEGER,
      players INTEGER,
      wins INTEGER,
      total_score INTEGER,
      placement INTEGER,
      result TEXT,
      played_at TEXT NOT NULL
    )`);
    console.log("Score DB: local SQLite (tetris.db) — set DATABASE_URL for a persistent DB on cloud hosts.");
  } catch (e) {
    console.log("Warning: node:sqlite unavailable (" + e.message + "). Score history disabled; needs Node 22.5+.");
  }
}

async function saveSingleScoreRow(data) {
  const nickname = String(data.nickname).slice(0, 20);
  const character = String(data.character || "cat").slice(0, 20);
  const difficulty = String(data.difficulty || "normal").slice(0, 10);
  const score = Math.max(0, Math.floor(data.score) || 0);
  const level = Math.max(1, Math.floor(data.level) || 1);
  const lines = Math.max(0, Math.floor(data.lines) || 0);
  const playedAt = new Date().toISOString();
  if (pg) {
    const r = await pg.pool.query(
      "INSERT INTO single_scores (nickname, character, difficulty, score, level, lines, played_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [nickname, character, difficulty, score, level, lines, playedAt]
    );
    return r.rows[0].id;
  }
  const info = db.prepare(
    "INSERT INTO single_scores (nickname, character, difficulty, score, level, lines, played_at) VALUES (?,?,?,?,?,?,?)"
  ).run(nickname, character, difficulty, score, level, lines, playedAt);
  return info.lastInsertRowid;
}

async function getSingleScoreRows({ nickname, difficulty, sort, limit }) {
  const orderCol = sort === "recent" ? "played_at" : "score";
  const conds = [];
  if (nickname) conds.push(["nickname", nickname]);
  if (difficulty) conds.push(["difficulty", difficulty]);
  const params = conds.map((c) => c[1]);
  if (pg) {
    const whereSql = conds.length ? "WHERE " + conds.map((c, i) => `${c[0]} = $${i + 1}`).join(" AND ") : "";
    const text = `SELECT * FROM single_scores ${whereSql} ORDER BY ${orderCol} DESC LIMIT $${conds.length + 1}`;
    const r = await pg.pool.query({ text, values: [...params, limit] });
    return r.rows;
  }
  const whereSql = conds.length ? "WHERE " + conds.map((c) => `${c[0]} = ?`).join(" AND ") : "";
  return db.prepare(`SELECT * FROM single_scores ${whereSql} ORDER BY ${orderCol} DESC LIMIT ?`).all(...params, limit);
}

async function saveMultiResultRow(data) {
  const nickname = String(data.nickname).slice(0, 20);
  const character = String(data.character || "cat").slice(0, 20);
  const mode = String(data.mode || "normal").slice(0, 10);
  const rounds = Math.max(1, Math.floor(data.rounds) || 1);
  const players = Math.max(1, Math.floor(data.players) || 1);
  const wins = Math.max(0, Math.floor(data.wins) || 0);
  const totalScore = Math.max(0, Math.floor(data.totalScore) || 0);
  const placement = Math.max(1, Math.floor(data.placement) || 1);
  const result = data.result === "win" ? "win" : "lose";
  const playedAt = new Date().toISOString();
  if (pg) {
    const r = await pg.pool.query(
      "INSERT INTO multi_results (nickname, character, mode, team_mode, rounds, players, wins, total_score, placement, result, played_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
      [nickname, character, mode, !!data.teamMode, rounds, players, wins, totalScore, placement, result, playedAt]
    );
    return r.rows[0].id;
  }
  const info = db.prepare(
    "INSERT INTO multi_results (nickname, character, mode, team_mode, rounds, players, wins, total_score, placement, result, played_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run(nickname, character, mode, data.teamMode ? 1 : 0, rounds, players, wins, totalScore, placement, result, playedAt);
  return info.lastInsertRowid;
}

async function getMultiResultRows({ nickname, mode, limit }) {
  const conds = [];
  if (nickname) conds.push(["nickname", nickname]);
  if (mode) conds.push(["mode", mode]);
  const params = conds.map((c) => c[1]);
  if (pg) {
    const whereSql = conds.length ? "WHERE " + conds.map((c, i) => `${c[0]} = $${i + 1}`).join(" AND ") : "";
    const text = `SELECT * FROM multi_results ${whereSql} ORDER BY played_at DESC LIMIT $${conds.length + 1}`;
    const r = await pg.pool.query({ text, values: [...params, limit] });
    return r.rows;
  }
  const whereSql = conds.length ? "WHERE " + conds.map((c) => `${c[0]} = ?`).join(" AND ") : "";
  return db.prepare(`SELECT * FROM multi_results ${whereSql} ORDER BY played_at DESC LIMIT ?`).all(...params, limit);
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
    if (!pg && !db) { send(res, 501, { error: "score db unavailable" }); return; }
    readJsonBody(req, async (err, data) => {
      if (err) { send(res, 400, { error: "bad json" }); return; }
      if (!data.nickname || typeof data.score !== "number") { send(res, 400, { error: "nickname and score required" }); return; }
      try {
        const id = await saveSingleScoreRow(data);
        send(res, 200, { ok: true, id });
      } catch (e) { send(res, 500, { error: "db error" }); }
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/single-scores") {
    if (!pg && !db) { send(res, 501, { error: "score db unavailable" }); return; }
    const nickname = u.searchParams.get("nickname");
    const difficulty = u.searchParams.get("difficulty");
    const sort = u.searchParams.get("sort");
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 50));
    getSingleScoreRows({ nickname, difficulty, sort, limit })
      .then((rows) => send(res, 200, { scores: rows }))
      .catch(() => send(res, 500, { error: "db error" }));
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/multi-result") {
    if (!pg && !db) { send(res, 501, { error: "score db unavailable" }); return; }
    readJsonBody(req, async (err, data) => {
      if (err) { send(res, 400, { error: "bad json" }); return; }
      if (!data.nickname) { send(res, 400, { error: "nickname required" }); return; }
      try {
        const id = await saveMultiResultRow(data);
        send(res, 200, { ok: true, id });
      } catch (e) { send(res, 500, { error: "db error" }); }
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/multi-results") {
    if (!pg && !db) { send(res, 501, { error: "score db unavailable" }); return; }
    const nickname = u.searchParams.get("nickname");
    const mode = u.searchParams.get("mode");
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit")) || 20));
    getMultiResultRows({ nickname, mode, limit })
      .then((rows) => send(res, 200, { results: rows }))
      .catch(() => send(res, 500, { error: "db error" }));
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

initScoreStore().then(() => {
  server.listen(PORT, () => {
    console.log("Tetris Arena server running.");
    console.log("  - This PC:      http://localhost:" + PORT);
    for (const ip of lanAddresses()) {
      console.log("  - Same Wi-Fi:   http://" + ip + ":" + PORT);
    }
    console.log("Enter one of the addresses above as the \"local server\" address in tetris-arena.html.");
    console.log("Press Ctrl+C to stop.");
  });
});
