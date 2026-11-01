const state = {
  user: null,
  tasks: [],
  view: "all",
  filter: "all",
  category: null,
  query: "",
  editingTaskId: null,
};

const commonCategories = ["Trabajo", "Personal", "Estudio", "Salud", "Hogar"];
const categoryColors = [
  ["#f1e8d8", "#947548"],
  ["#f1e4df", "#a66b5b"],
  ["#e6e9f1", "#6b7595"],
  ["#e2ece2", "#668269"],
  ["#eee8f2", "#846d91"],
  ["#e9ece8", "#667a6d"],
];
let toastTimer;

const elements = {
  authScreen: document.querySelector("#auth-screen"),
  appShell: document.querySelector("#app-shell"),
  loginForm: document.querySelector("#login-form"),
  registerForm: document.querySelector("#register-form"),
  authSwitch: document.querySelector("#auth-switch"),
  authSwitchCopy: document.querySelector("#auth-switch-copy"),
  authTitle: document.querySelector("#auth-title"),
  authSubtitle: document.querySelector("#auth-subtitle"),
  authKicker: document.querySelector("#auth-kicker"),
  taskList: document.querySelector("#task-list"),
  emptyState: document.querySelector("#empty-state"),
  taskDialog: document.querySelector("#task-dialog"),
  taskForm: document.querySelector("#task-form"),
  taskSubmit: document.querySelector("#task-submit"),
  toast: document.querySelector("#toast"),
};

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  return new Date(`${value}T12:00:00`);
}

function formatDueDate(value) {
  const date = parseLocalDate(value);
  return new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(date).replace(".", "");
}

function categoryColor(category) {
  let hash = 0;
  for (const character of category) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return categoryColors[hash % categoryColors.length];
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("No pudimos leer la respuesta. Inténtalo otra vez.");
  }
  if (!response.ok) throw new Error(result.error || "Algo salió mal. Inténtalo otra vez.");
  return result;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

function setAuthenticated(user) {
  state.user = user;
  elements.authScreen.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
  const name = user.name.trim();
  document.querySelector("#user-name").textContent = name;
  document.querySelector("#user-avatar").textContent = [...name][0].toLocaleUpperCase("es");
  document.querySelector("#welcome-title").innerHTML = `Hola, <span>${escapeHtml(name.split(/\s+/)[0])}.</span>`;
  const now = new Date();
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" }).format(now);
  document.querySelector("#welcome-date").textContent = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(now).toUpperCase();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function setUnauthenticated() {
  state.user = null;
  state.tasks = [];
  elements.appShell.classList.add("hidden");
  elements.authScreen.classList.remove("hidden");
}

async function loadTasks() {
  const { tasks } = await request("/api/tasks");
  state.tasks = tasks.map((task) => ({ ...task, completed: Boolean(task.completed) }));
  render();
}

function setView(view) {
  state.view = view;
  state.filter = "all";
  state.category = null;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".filter-pill").forEach((item) => item.classList.toggle("selected", item.dataset.filter === "all"));
  const labels = { all: "Mis tareas", today: "Para hoy", completed: "Completadas" };
  document.querySelector("#breadcrumb-view").textContent = labels[view];
  document.querySelector("#task-section-title").firstChild.textContent = view === "today" ? "Para hoy " : view === "completed" ? "Pequeñas victorias " : "Todas tus tareas ";
  render();
}

function getVisibleTasks() {
  const today = localDateKey();
  const query = state.query.toLocaleLowerCase("es").trim();
  return state.tasks.filter((task) => {
    if (state.view === "today" && (task.completed || !task.dueDate || task.dueDate > today)) return false;
    if (state.view === "completed" && !task.completed) return false;
    if (state.category && task.category !== state.category) return false;
    if (state.filter === "active" && task.completed) return false;
    if (state.filter === "completed" && !task.completed) return false;
    if (state.filter === "overdue" && (task.completed || !task.dueDate || task.dueDate >= today)) return false;
    return !query || `${task.title} ${task.description} ${task.category}`.toLocaleLowerCase("es").includes(query);
  });
}

function renderTask(task) {
  const row = document.createElement("article");
  row.className = `task-row${task.completed ? " is-complete" : ""}`;

  const checkbox = document.createElement("button");
  checkbox.type = "button";
  checkbox.className = "task-check";
  checkbox.textContent = "✓";
  checkbox.setAttribute("role", "checkbox");
  checkbox.setAttribute("aria-checked", String(task.completed));
  checkbox.setAttribute("aria-label", task.completed ? `Marcar ${task.title} como pendiente` : `Marcar ${task.title} como completada`);
  checkbox.addEventListener("click", () => toggleTask(task));

  const info = document.createElement("div");
  info.className = "task-info";
  const title = document.createElement("p");
  title.className = "task-title";
  title.textContent = task.title;
  info.append(title);
  if (task.description) {
    const description = document.createElement("p");
    description.className = "task-description";
    description.textContent = task.description;
    info.append(description);
  }

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const category = document.createElement("span");
  category.className = "task-category";
  category.textContent = task.category;
  const [background, foreground] = categoryColor(task.category);
  category.style.setProperty("--tag-bg", background);
  category.style.setProperty("--tag-ink", foreground);
  meta.append(category);
  if (task.dueDate) {
    const due = document.createElement("span");
    due.className = "task-due";
    due.textContent = formatDueDate(task.dueDate);
    if (!task.completed && task.dueDate < localDateKey()) {
      due.classList.add("is-overdue");
      due.textContent = `Venció ${due.textContent}`;
    }
    meta.append(due);
  }

  const tools = document.createElement("div");
  tools.className = "task-tools";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-button";
  edit.textContent = "↗";
  edit.setAttribute("aria-label", `Editar ${task.title}`);
  edit.title = "Editar";
  edit.addEventListener("click", () => openTaskDialog(task));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Eliminar ${task.title}`);
  remove.title = "Eliminar";
  remove.addEventListener("click", () => deleteTask(task));
  tools.append(edit, remove);
  row.append(checkbox, info, meta, tools);
  return row;
}

function renderCategories() {
  const counts = new Map();
  for (const task of state.tasks) counts.set(task.category, (counts.get(task.category) || 0) + 1);
  const categories = [...new Set([...commonCategories, ...counts.keys()])];
  const nav = document.querySelector("#category-list");
  nav.replaceChildren();
  for (const name of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `category-item${state.category === name ? " active" : ""}`;
    button.setAttribute("aria-pressed", String(state.category === name));
    const swatch = document.createElement("span");
    swatch.className = "category-swatch";
    const [background] = categoryColor(name);
    swatch.style.setProperty("--swatch", background);
    const label = document.createElement("span");
    label.textContent = name;
    const count = document.createElement("span");
    count.className = "category-count";
    count.textContent = String(counts.get(name) || 0);
    button.append(swatch, label, count);
    button.addEventListener("click", () => {
      state.category = state.category === name ? null : name;
      state.view = "all";
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "all"));
      document.querySelector("#breadcrumb-view").textContent = state.category || "Mis tareas";
      document.querySelector("#task-section-title").firstChild.textContent = state.category ? `Categoría: ${state.category} ` : "Todas tus tareas ";
      render();
    });
    nav.append(button);
  }

  const datalist = document.querySelector("#category-options");
  datalist.replaceChildren();
  for (const name of categories) {
    const option = document.createElement("option");
    option.value = name;
    datalist.append(option);
  }
}

function renderUpcoming() {
  const upcoming = state.tasks
    .filter((task) => !task.completed && task.dueDate && task.dueDate >= localDateKey())
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  const list = document.querySelector("#upcoming-list");
  const empty = document.querySelector("#upcoming-empty");
  list.replaceChildren();
  empty.classList.toggle("hidden", upcoming.length > 0);
  for (const task of upcoming) {
    const date = parseLocalDate(task.dueDate);
    const item = document.createElement("div");
    item.className = "upcoming-item";
    const block = document.createElement("div");
    block.className = "date-block";
    const day = document.createElement("strong");
    day.textContent = new Intl.DateTimeFormat("es", { day: "numeric" }).format(date);
    const month = document.createElement("span");
    month.textContent = new Intl.DateTimeFormat("es", { month: "short" }).format(date).replace(".", "");
    block.append(day, month);
    const copy = document.createElement("div");
    copy.className = "upcoming-copy";
    const title = document.createElement("strong");
    title.textContent = task.title;
    const category = document.createElement("span");
    category.textContent = task.category;
    copy.append(title, category);
    item.append(block, copy);
    list.append(item);
  }
}

function render() {
  const today = localDateKey();
  const active = state.tasks.filter((task) => !task.completed);
  const dueToday = active.filter((task) => task.dueDate === today).length;
  const overdue = active.filter((task) => task.dueDate && task.dueDate < today).length;
  const completed = state.tasks.length - active.length;
  document.querySelector("#stat-active").textContent = String(active.length);
  document.querySelector("#stat-today").textContent = String(dueToday);
  document.querySelector("#stat-completed").textContent = String(completed);
  document.querySelector("#nav-all-count").textContent = String(active.length);
  document.querySelector("#nav-today-count").textContent = String(dueToday + overdue);
  document.querySelector("#overdue-count").textContent = String(overdue);
  const percent = state.tasks.length ? Math.round((completed / state.tasks.length) * 100) : 0;
  document.querySelector("#progress-value").textContent = `${percent}%`;
  document.querySelector("#progress-fill").style.width = `${percent}%`;
  document.querySelector("#progress-caption").textContent = state.tasks.length
    ? `${completed} de ${state.tasks.length} pasos completados.`
    : "Todo empieza con un paso.";
  document.querySelector("#footer-progress").textContent = state.tasks.length
    ? `${percent}% de tus pasos ya están hechos.`
    : "El progreso se ve bien en ti.";

  renderCategories();
  renderUpcoming();
  const visible = getVisibleTasks();
  elements.taskList.replaceChildren(...visible.map(renderTask));
  document.querySelector("#visible-count").textContent = String(visible.length);
  elements.emptyState.classList.toggle("hidden", visible.length > 0);
  elements.taskList.classList.toggle("hidden", visible.length === 0);
  if (state.tasks.length === 0) {
    document.querySelector("#empty-title").textContent = "Un espacio en blanco.";
    document.querySelector("#empty-copy").textContent = "Añade una tarea y convierte una idea en tu próximo paso.";
    document.querySelector("#empty-add").classList.remove("hidden");
  } else {
    document.querySelector("#empty-title").textContent = state.query ? "No encontramos coincidencias." : "Por aquí no hay nada.";
    document.querySelector("#empty-copy").textContent = state.query
      ? "Prueba con otras palabras o cambia el filtro."
      : "Prueba con otro filtro o elige una categoría distinta.";
    document.querySelector("#empty-add").classList.toggle("hidden", Boolean(state.query));
  }
}

function openTaskDialog(task = null) {
  state.editingTaskId = task ? task.id : null;
  elements.taskForm.reset();
  document.querySelector("#task-category").value = task?.category || "Personal";
  document.querySelector("#task-title").value = task?.title || "";
  document.querySelector("#task-description").value = task?.description || "";
  document.querySelector("#task-due-date").value = task?.dueDate || "";
  document.querySelector("#dialog-title").innerHTML = task ? "Dale otra<br>forma." : "Hazle sitio<br>a una idea.";
  document.querySelector("#dialog-kicker").textContent = task ? "UN CAMBIO A LA VEZ" : "UN NUEVO COMIENZO";
  elements.taskSubmit.innerHTML = task ? "Guardar cambios <span aria-hidden=\"true\">↗</span>" : "Guardar tarea <span aria-hidden=\"true\">↗</span>";
  elements.taskDialog.showModal();
  document.querySelector("#task-title").focus();
}

async function toggleTask(task) {
  try {
    await request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ completed: !task.completed }),
    });
    await loadTasks();
    showToast(task.completed ? "La tarea volvió a tu lista." : "Un paso más. ¡Bien hecho!");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteTask(task) {
  if (!window.confirm(`¿Eliminar «${task.title}»? Esta acción no se puede deshacer.`)) return;
  try {
    await request(`/api/tasks/${task.id}`, { method: "DELETE" });
    await loadTasks();
    showToast("La tarea se eliminó de tu lista.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function handleAuthSubmit(event, action) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(form));
    const { user } = await request(`/api/${action}`, { method: "POST", body: JSON.stringify(payload) });
    setAuthenticated(user);
    await loadTasks();
    showToast(action === "register" ? "Tu espacio está listo. ¡Empezamos!" : "Qué bueno tenerte de vuelta.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
}

elements.loginForm.addEventListener("submit", (event) => handleAuthSubmit(event, "login"));
elements.registerForm.addEventListener("submit", (event) => handleAuthSubmit(event, "register"));
elements.authSwitch.addEventListener("click", () => {
  const registering = elements.loginForm.classList.toggle("hidden");
  elements.registerForm.classList.toggle("hidden", !registering);
  elements.authKicker.textContent = registering ? "EMPIEZA A TU MANERA" : "QUÉ BUENO TENERTE AQUÍ";
  elements.authTitle.innerHTML = registering ? "Un espacio<br>solo tuyo." : "Volvamos al<br>presente.";
  elements.authSubtitle.textContent = registering
    ? "Crea tu cuenta y dale un poco más de aire a tus días."
    : "Entra y encuentra tu día un poco más ligero.";
  elements.authSwitchCopy.textContent = registering ? "¿Ya tienes una cuenta?" : "¿Primera vez por aquí?";
  elements.authSwitch.textContent = registering ? "Inicia sesión" : "Crea tu cuenta";
});

document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
document.querySelectorAll(".filter-pill").forEach((item) => item.addEventListener("click", () => {
  state.filter = item.dataset.filter;
  document.querySelectorAll(".filter-pill").forEach((pill) => pill.classList.toggle("selected", pill === item));
  render();
}));
document.querySelector("#task-search").addEventListener("input", (event) => {
  state.query = event.currentTarget.value;
  render();
});
document.querySelector("#top-new-task").addEventListener("click", () => openTaskDialog());
document.querySelector("#mobile-new-task").addEventListener("click", () => openTaskDialog());
document.querySelector("#empty-add").addEventListener("click", () => openTaskDialog());
document.querySelector("#dialog-close").addEventListener("click", () => elements.taskDialog.close());
document.querySelector("#dialog-cancel").addEventListener("click", () => elements.taskDialog.close());
elements.taskDialog.addEventListener("click", (event) => {
  if (event.target === elements.taskDialog) elements.taskDialog.close();
});
elements.taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = elements.taskSubmit;
  submit.disabled = true;
  const body = {
    title: document.querySelector("#task-title").value,
    description: document.querySelector("#task-description").value,
    category: document.querySelector("#task-category").value,
    dueDate: document.querySelector("#task-due-date").value,
  };
  const editingId = state.editingTaskId;
  try {
    await request(editingId ? `/api/tasks/${editingId}` : "/api/tasks", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    elements.taskDialog.close();
    await loadTasks();
    showToast(editingId ? "Tus cambios quedaron guardados." : "Tarea añadida. Ya tienes por dónde empezar.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST", body: "{}" });
    setUnauthenticated();
    showToast("Tu espacio queda listo para cuando vuelvas.");
  } catch (error) {
    showToast(error.message, true);
  }
});

async function initialize() {
  try {
    const { user } = await request("/api/me");
    setAuthenticated(user);
    await loadTasks();
  } catch (error) {
    setUnauthenticated();
    if (error.message !== "Inicia sesión para continuar.") showToast(error.message, true);
  }
}

initialize();
