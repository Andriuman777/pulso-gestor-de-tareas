const { createServer: createHttpServer } = require("node:http");
const { createReadStream, existsSync, mkdirSync, statSync } = require("node:fs");
const { resolve, dirname, extname, sep } = require("node:path");
const { randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scryptAsync = promisify(scrypt);
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 32 * 1024;
const PUBLIC_DIR = resolve(__dirname, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function createDatabase(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Personal',
      due_date TEXT,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);
  return db;
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("La solicitud es demasiado grande."), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          settled = true;
          reject(Object.assign(new Error("El formato de la solicitud no es válido."), { status: 400 }));
          return;
        }
        settled = true;
        resolveBody(parsed);
      } catch {
        settled = true;
        reject(Object.assign(new Error("El formato de la solicitud no es válido."), { status: 400 }));
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateTask(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const dueDate = body.dueDate === "" || body.dueDate == null ? null : body.dueDate;

  if (!title || title.length > 120) {
    return { error: "El título es obligatorio y debe tener como máximo 120 caracteres." };
  }
  if (description.length > 1000) {
    return { error: "La descripción debe tener como máximo 1000 caracteres." };
  }
  if (!category || category.length > 30) {
    return { error: "La categoría es obligatoria y debe tener como máximo 30 caracteres." };
  }
  if (dueDate !== null && (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) {
    return { error: "La fecha de vencimiento no es válida." };
  }
  return { title, description, category, dueDate };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? ["", ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
}

function createApp({ dbPath = process.env.PULSO_DB_PATH || resolve(__dirname, "data", "pulso.db"), secureCookies = process.env.NODE_ENV === "production" } = {}) {
  const db = createDatabase(dbPath);
  const attempts = new Map();
  const statements = {
    userByEmail: db.prepare("SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?"),
    userById: db.prepare("SELECT id, name, email FROM users WHERE id = ?"),
    addUser: db.prepare("INSERT INTO users (name, email, password_hash, password_salt) VALUES (?, ?, ?, ?)"),
    addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    sessionUser: db.prepare("SELECT users.id, users.name, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    tasks: db.prepare("SELECT id, title, description, category, due_date AS dueDate, completed, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE user_id = ? ORDER BY completed ASC, due_date IS NULL ASC, due_date ASC, created_at DESC"),
    taskById: db.prepare("SELECT id FROM tasks WHERE id = ? AND user_id = ?"),
    addTask: db.prepare("INSERT INTO tasks (user_id, title, description, category, due_date) VALUES (?, ?, ?, ?, ?)"),
    updateTask: db.prepare("UPDATE tasks SET title = ?, description = ?, category = ?, due_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?"),
    completeTask: db.prepare("UPDATE tasks SET completed = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND user_id = ?"),
    deleteTask: db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?"),
  };

  function getCurrentUser(req) {
    const token = parseCookies(req.headers.cookie).pulso_session;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return statements.sessionUser.get(tokenHash, Math.floor(Date.now() / 1000)) || null;
  }

  function issueSession(userId) {
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    statements.addSession.run(tokenHash, userId, expiresAt);
    const secure = secureCookies ? "; Secure" : "";
    return `pulso_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
  }

  function rateLimit(req) {
    const now = Date.now();
    const ip = req.socket.remoteAddress || "unknown";
    const current = attempts.get(ip);
    if (!current || current.resetAt < now) {
      attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return false;
    }
    current.count += 1;
    return current.count > 30;
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (isMutation && req.headers.origin) {
      let originHost;
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {
        return sendJson(res, 403, { error: "Origen de solicitud no permitido." });
      }
      if (originHost !== req.headers.host) {
        return sendJson(res, 403, { error: "Origen de solicitud no permitido." });
      }
    }

    if (pathname === "/api/register" && method === "POST") {
      if (rateLimit(req)) return sendJson(res, 429, { error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." });
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const email = normalizeEmail(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      if (name.length < 2 || name.length > 60) return sendJson(res, 400, { error: "El nombre debe tener entre 2 y 60 caracteres." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendJson(res, 400, { error: "Escribe un correo electrónico válido." });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: "La contraseña debe tener entre 8 y 128 caracteres." });
      const salt = randomBytes(16);
      const hash = await scryptAsync(password, salt, 64);
      try {
        const result = statements.addUser.run(name, email, hash.toString("hex"), salt.toString("hex"));
        db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Math.floor(Date.now() / 1000));
        const user = statements.userById.get(Number(result.lastInsertRowid));
        return sendJson(res, 201, { user }, { "Set-Cookie": issueSession(user.id) });
      } catch (error) {
        if (error.errcode === 2067) return sendJson(res, 409, { error: "Ya existe una cuenta con ese correo." });
        throw error;
      }
    }

    if (pathname === "/api/login" && method === "POST") {
      if (rateLimit(req)) return sendJson(res, 429, { error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." });
      const body = await readBody(req);
      const user = statements.userByEmail.get(normalizeEmail(body.email));
      const password = typeof body.password === "string" ? body.password : "";
      const salt = user ? Buffer.from(user.password_salt, "hex") : Buffer.alloc(16);
      const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
      const actual = await scryptAsync(password, salt, 64);
      if (!user || !timingSafeEqual(expected, actual)) return sendJson(res, 401, { error: "Correo o contraseña incorrectos." });
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Math.floor(Date.now() / 1000));
      const publicUser = { id: user.id, name: user.name, email: user.email };
      return sendJson(res, 200, { user: publicUser }, { "Set-Cookie": issueSession(user.id) });
    }

    if (pathname === "/api/logout" && method === "POST") {
      const token = parseCookies(req.headers.cookie).pulso_session;
      if (token && /^[a-f0-9]{64}$/.test(token)) {
        statements.deleteSession.run(createHash("sha256").update(token).digest("hex"));
      }
      const secure = secureCookies ? "; Secure" : "";
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": `pulso_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
    }

    if (pathname === "/api/me" && method === "GET") {
      const user = getCurrentUser(req);
      return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: "Inicia sesión para continuar." });
    }

    const user = getCurrentUser(req);
    if (!user) return sendJson(res, 401, { error: "Inicia sesión para continuar." });

    if (pathname === "/api/tasks" && method === "GET") {
      return sendJson(res, 200, { tasks: statements.tasks.all(user.id) });
    }

    if (pathname === "/api/tasks" && method === "POST") {
      const body = await readBody(req);
      const task = validateTask(body);
      if (task.error) return sendJson(res, 400, { error: task.error });
      const result = statements.addTask.run(user.id, task.title, task.description, task.category, task.dueDate);
      const created = db.prepare("SELECT id, title, description, category, due_date AS dueDate, completed, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?").get(Number(result.lastInsertRowid));
      return sendJson(res, 201, { task: created });
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch) {
      const id = Number(taskMatch[1]);
      if (!Number.isSafeInteger(id) || !statements.taskById.get(id, user.id)) return sendJson(res, 404, { error: "No encontramos esa tarea." });
      if (method === "PUT") {
        const body = await readBody(req);
        const task = validateTask(body);
        if (task.error) return sendJson(res, 400, { error: task.error });
        statements.updateTask.run(task.title, task.description, task.category, task.dueDate, id, user.id);
        const updated = db.prepare("SELECT id, title, description, category, due_date AS dueDate, completed, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?").get(id);
        return sendJson(res, 200, { task: updated });
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (typeof body.completed !== "boolean") return sendJson(res, 400, { error: "El estado de la tarea no es válido." });
        statements.completeTask.run(Number(body.completed), id, user.id);
        return sendJson(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        statements.deleteTask.run(id, user.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: "No encontramos esa ruta." });
  }

  const server = createHttpServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Método no permitido." });
        return;
      }
      const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = resolve(PUBLIC_DIR, requestedPath);
      if (!filePath.startsWith(`${PUBLIC_DIR}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("No encontrado");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(filePath).pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status === 500) console.error("Error en la solicitud:", error);
        sendJson(res, status, { error: status === 500 ? "Ocurrió un error inesperado. Inténtalo de nuevo." : error.message });
      } else {
        res.destroy(error);
      }
    }
  });

  server.on("close", () => db.close());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, () => {
    console.log(`Pulso está listo en http://localhost:${port}`);
  });
}

module.exports = { createApp };
