const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createApp } = require("../server");

let server;
let baseUrl;
let tempDir;
let dbPath;
let aliceCookie;

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function register(name, email, password) {
  const { response, data } = await api("/api/register", {
    method: "POST",
    body: { name, email, password },
  });
  return { response, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pulso-test-"));
  dbPath = join(tempDir, "test.db");
  server = createApp({ dbPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

test("registra cuentas con hash de contraseña y restringe las rutas privadas", async () => {
  const registration = await register("Ana Pérez", "ana@example.com", "clave-segura-123");
  assert.equal(registration.response.status, 201);
  assert.equal(registration.data.user.name, "Ana Pérez");
  assert.ok(registration.cookie);
  aliceCookie = registration.cookie;

  const db = new DatabaseSync(dbPath);
  const stored = db.prepare("SELECT password_hash, password_salt FROM users WHERE email = ?").get("ana@example.com");
  db.close();
  assert.notEqual(stored.password_hash, "clave-segura-123");
  assert.equal(stored.password_hash.length, 128);
  assert.equal(stored.password_salt.length, 32);

  const currentUser = await api("/api/me", { cookie: aliceCookie });
  assert.equal(currentUser.response.status, 200);
  assert.equal(currentUser.data.user.email, "ana@example.com");
  const unauthenticated = await api("/api/tasks");
  assert.equal(unauthenticated.response.status, 401);

  const login = await api("/api/login", {
    method: "POST",
    body: { email: "ANA@example.com", password: "clave-segura-123" },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.user.id, registration.data.user.id);
  const loginCookie = login.response.headers.get("set-cookie").split(";")[0];

  const incorrectPassword = await api("/api/login", {
    method: "POST",
    body: { email: "ana@example.com", password: "contraseña-incorrecta" },
  });
  assert.equal(incorrectPassword.response.status, 401);

  const logout = await api("/api/logout", { method: "POST", body: {}, cookie: loginCookie });
  assert.equal(logout.response.status, 200);
  const revokedSession = await api("/api/me", { cookie: loginCookie });
  assert.equal(revokedSession.response.status, 401);
});

test("valida registros y no permite duplicar un correo", async () => {
  const shortPassword = await register("Luis Pérez", "luis@example.com", "123");
  assert.equal(shortPassword.response.status, 400);

  const duplicate = await register("Otra Ana", "ANA@example.com", "clave-segura-123");
  assert.equal(duplicate.response.status, 409);
});

test("permite crear, editar, completar y eliminar solo las tareas propias", async () => {
  const created = await api("/api/tasks", {
    method: "POST",
    cookie: aliceCookie,
    body: { title: "Preparar entrega", description: "Revisar el proyecto", category: "Estudio", dueDate: "2027-01-15" },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.task.title, "Preparar entrega");
  assert.equal(created.data.task.completed, 0);
  const taskId = created.data.task.id;

  const invalidDate = await api("/api/tasks", {
    method: "POST",
    cookie: aliceCookie,
    body: { title: "Fecha inválida", category: "Estudio", dueDate: "2027-02-31" },
  });
  assert.equal(invalidDate.response.status, 400);

  const bob = await register("Luis Pérez", "luis@example.com", "clave-segura-123");
  const foreignTask = await api(`/api/tasks/${taskId}`, { method: "DELETE", cookie: bob.cookie });
  assert.equal(foreignTask.response.status, 404);

  const edited = await api(`/api/tasks/${taskId}`, {
    method: "PUT",
    cookie: aliceCookie,
    body: { title: "Entrega revisada", description: "", category: "Trabajo", dueDate: "" },
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.task.title, "Entrega revisada");
  assert.equal(edited.data.task.dueDate, null);

  const completed = await api(`/api/tasks/${taskId}`, {
    method: "PATCH",
    cookie: aliceCookie,
    body: { completed: true },
  });
  assert.equal(completed.response.status, 200);
  const listed = await api("/api/tasks", { cookie: aliceCookie });
  assert.equal(listed.data.tasks.length, 1);
  assert.equal(listed.data.tasks[0].completed, 1);

  const deleted = await api(`/api/tasks/${taskId}`, { method: "DELETE", cookie: aliceCookie });
  assert.equal(deleted.response.status, 200);
  const emptyList = await api("/api/tasks", { cookie: aliceCookie });
  assert.equal(emptyList.data.tasks.length, 0);
});

test("valida solicitudes entre sitios y sirve la interfaz", async () => {
  const crossSite = await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: { Origin: "https://sitio-ajeno.example", Host: new URL(baseUrl).host },
  });
  assert.equal(crossSite.status, 403);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Tu día/);
});
