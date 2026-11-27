import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ---------- Accounts: sign up / log in / guest ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("NOTE: SESSION_SECRET is not set. Logins will reset whenever the server restarts.");
const ALLOW_GUEST = (process.env.ALLOW_GUEST || "true").toLowerCase() !== "false";
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP || "true").toLowerCase() !== "false";
const GUEST_DAILY_LIMIT = Number(process.env.GUEST_DAILY_LIMIT || 10);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT || 100);
const SESSION_DAYS = 30;
const COOKIE = "dax_ai_session";

fs.mkdirSync(DATA_DIR, { recursive: true });
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = {}; }
function saveUsers() {
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(users));
  fs.renameSync(tmp, USERS_FILE);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
function makeToken(payload) {
  const body = b64({ ...payload, exp: Date.now() + SESSION_DAYS * 864e5 });
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(";").map(c => c.trim()).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
function setSession(req, res, payload) {
  res.cookie(COOKIE, makeToken(payload), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: "/" });
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function checkPassword(password, rec) {
  const a = Buffer.from(hashPassword(password, rec.salt).hash, "hex"), b = Buffer.from(rec.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, rec);
  return rec.length >= 10;
}
const noteAttempt = (ip) => attempts.get(ip)?.push(Date.now());

// Daily message limits (in memory; they reset when the server restarts).
const usage = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function usageKey(req) {
  const s = req.session;
  return s.t === "g" ? `ip:${req.ip}:${today()}` : `u:${s.id}:${today()}`;
}
const limitFor = (req) => (req.session.t === "g" ? GUEST_DAILY_LIMIT : USER_DAILY_LIMIT);
const remaining = (req) => Math.max(0, limitFor(req) - (usage.get(usageKey(req)) || 0));
setInterval(() => { for (const k of usage.keys()) if (!k.endsWith(today())) usage.delete(k); }, 36e5).unref();

app.get("/api/options", (_req, res) => res.json({ guest: ALLOW_GUEST, signup: ALLOW_SIGNUP, guestLimit: GUEST_DAILY_LIMIT }));

app.post("/api/signup", (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: "Sign-ups are turned off." });
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  noteAttempt(req.ip);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return res.status(400).json({ error: "Enter a valid email." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (users[email]) return res.status(409).json({ error: "That email already has an account. Log in instead." });
  users[email] = { ...hashPassword(password), created: new Date().toISOString() };
  saveUsers();
  setSession(req, res, { t: "u", id: email });
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const rec = users[email];
  if (!rec || !checkPassword(password, rec)) { noteAttempt(req.ip); return res.status(401).json({ error: "Wrong email or password." }); }
  setSession(req, res, { t: "u", id: email });
  res.json({ ok: true });
});

app.post("/api/guest", (req, res) => {
  if (!ALLOW_GUEST) return res.status(403).json({ error: "Guest mode is turned off." });
  setSession(req, res, { t: "g", id: crypto.randomBytes(8).toString("hex") });
  res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });

const PUBLIC_PATHS = new Set(["/login", "/login.html", "/manifest.webmanifest", "/sw.js", "/api/options"]);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith("/icons/")) return next();
  const session = readToken(readCookie(req, COOKIE));
  if (session && (session.t === "g" ? ALLOW_GUEST : users[session.id])) { req.session = session; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please log in." });
  res.redirect("/login");
});
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/api/me", (req, res) => res.json({ type: req.session.t === "g" ? "guest" : "user", email: req.session.t === "u" ? req.session.id : null, remaining: remaining(req) }));
app.use(express.static(path.join(__dirname, "public")));

const SYSTEM = `You are Dax AI, a friendly and capable assistant powered by Google Gemini.
Be clear, honest, and useful. Never claim certainty when you are unsure. For math, show steps and verify arithmetic.`;

class QuotaError extends Error {}
const QUOTA_MESSAGE = "The free AI quota is used up for the moment. Please try again in a few minutes.";

async function geminiAnswer(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Gemini API key is not configured.");
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + " When useful, use Google Search grounding to check current facts." }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  };
  if ((process.env.GEMINI_GROUNDING || "true").toLowerCase() === "true") {
    body.tools = [{ google_search: {} }];
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  const data = await r.json();
  if (r.status === 429) throw new QuotaError(QUOTA_MESSAGE);
  if (!r.ok) {
    const message = data.error?.message || `Gemini request failed (${r.status})`;
    throw new Error(message);
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || "").filter(Boolean).join("\n");
  if (!text) throw new Error("Gemini returned an empty answer.");
  return text;
}


// ---------- Saved chats (accounts) ----------
const CHATS_DIR = path.join(DATA_DIR, "chats");
fs.mkdirSync(CHATS_DIR, { recursive: true });
const sha24 = (v) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 24);
const ownerOf = (req) => sha24((req.session.t === "u" ? "u:" : "g:") + req.session.id);
const chatFile = (req) => path.join(CHATS_DIR, ownerOf(req) + ".json");
const CHAT_ID = /^[a-f0-9]{18}$/;
function readStore(req) { try { return JSON.parse(fs.readFileSync(chatFile(req), "utf8")); } catch { return { chats: {} }; } }
function writeStore(req, store) {
  const f = chatFile(req), tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, f);
}
function cleanMessages(req, msgs) {
  const owner = ownerOf(req);
  return (Array.isArray(msgs) ? msgs : []).slice(-300).map(m => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const out = { role: m.role, content: m.content.slice(0, 20000) };
    return out;
  }).filter(Boolean);
}
function needAccount(req, res) {
  if (req.session.t === "g") { res.status(403).json({ error: "Log in to save chats on the server." }); return true; }
  return false;
}
app.get("/api/chats", (req, res) => {
  if (needAccount(req, res)) return;
  const list = Object.values(readStore(req).chats).map(({ id, title, updated }) => ({ id, title, updated }));
  list.sort((a, b) => b.updated - a.updated);
  res.json({ chats: list });
});
app.get("/api/chats/:id", (req, res) => {
  if (needAccount(req, res)) return;
  const chat = readStore(req).chats[req.params.id];
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  res.json({ chat });
});
app.put("/api/chats/:id", (req, res) => {
  if (needAccount(req, res)) return;
  if (!CHAT_ID.test(req.params.id)) return res.status(400).json({ error: "Bad chat id." });
  const store = readStore(req);
  if (!store.chats[req.params.id] && Object.keys(store.chats).length >= 100) return res.status(400).json({ error: "You have 100 saved chats. Delete some first." });
  store.chats[req.params.id] = {
    id: req.params.id,
    title: String(req.body?.title || "New chat").slice(0, 80),
    updated: Date.now(),
    messages: cleanMessages(req, req.body?.messages)
  };
  writeStore(req, store);
  res.json({ ok: true });
});
app.delete("/api/chats/:id", (req, res) => {
  if (needAccount(req, res)) return;
  const store = readStore(req), chat = store.chats[req.params.id];
  if (chat) { delete store.chats[req.params.id]; writeStore(req, store); }
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
    }
  });
});

app.post("/api/chat", async (req, res) => {
  const { message, style = "balanced", history = [] } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Type a message first." });
  }
  if (message.length > 12000) return res.status(400).json({ error: "Message is too long (12,000 character limit)." });
  if (remaining(req) <= 0) {
    return res.status(429).json({ error: req.session.t === "g" ? "You’ve used your free guest messages for today. Sign up or log in for more." : "Daily message limit reached. Try again tomorrow." });
  }
  usage.set(usageKey(req), (usage.get(usageKey(req)) || 0) + 1);

  const styleInstruction = {
    balanced: "Use a clear, friendly, balanced tone.",
    casual: "Use a relaxed, casual tone, but stay accurate.",
    detailed: "Give a detailed, structured explanation with useful examples.",
    concise: "Be concise and get straight to the point."
  }[style] || "Use a clear, friendly, balanced tone.";
  const recent = (Array.isArray(history) ? history : []).slice(-10)
    .filter(m => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map(m => `${m.role === "user" ? "User" : "Dax AI"}: ${m.content.slice(0, 3000)}`).join("\n\n");
  const context = recent ? `Conversation so far:\n${recent}\n\n` : "";
  const prompt = `${styleInstruction}\n\n${context}User question:\n${message.trim()}`;

  try {
    const combined = await geminiAnswer(prompt);
    res.json({ combined, remaining: remaining(req) });
  } catch (error) {
    usage.set(usageKey(req), Math.max(0, (usage.get(usageKey(req)) || 1) - 1));
    const quota = error instanceof QuotaError;
    res.status(quota ? 429 : 502).json({
      error: quota ? QUOTA_MESSAGE : `The AI didn’t answer. Check your Gemini API key and model name. (${error.message})`
    });
  }
});

app.listen(port, () => {
  console.log(`Dax AI v1 is running at http://localhost:${port}`);
});