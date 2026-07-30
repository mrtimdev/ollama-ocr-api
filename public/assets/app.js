const jobs = new Map();
let stats = { total: 0, queued: 0, processing: 0, completed: 0, failed: 0, concurrency: 0 };
let socket;

const elements = {
  body: document.querySelector("#jobs-body"),
  empty: document.querySelector("#empty-state"),
  filter: document.querySelector("#status-filter"),
  meta: document.querySelector("#queue-meta"),
  dot: document.querySelector("#connection-dot"),
  label: document.querySelector("#connection-label"),
  dialog: document.querySelector("#access-dialog"),
  form: document.querySelector("#access-form"),
  key: document.querySelector("#monitor-key"),
  error: document.querySelector("#access-error"),
};

const statusStyles = {
  queued: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
  processing: "bg-cyan-400/10 text-cyan-300 ring-cyan-400/20",
  completed: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
  failed: "bg-rose-400/10 text-rose-300 ring-rose-400/20",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function render() {
  const selected = elements.filter.value;
  const visible = [...jobs.values()]
    .filter((job) => selected === "all" || job.status === selected)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  elements.empty.classList.toggle("hidden", visible.length > 0);
  elements.body.innerHTML = visible.map((job) => `
    <tr class="transition hover:bg-white/[0.025]">
      <td class="px-5 py-4">
        <div class="font-mono text-xs text-slate-300">${escapeHtml(job.id.slice(0, 8))}</div>
        <div class="mt-1 text-xs capitalize text-slate-500">${escapeHtml(job.type)}</div>
      </td>
      <td class="px-5 py-4">
        <div class="font-medium text-slate-200">${escapeHtml(job.owner)}</div>
        <div class="mt-1 font-mono text-[11px] text-slate-600">${escapeHtml(job.ownerId)}</div>
      </td>
      <td class="max-w-52 px-5 py-4">
        <div class="truncate text-slate-300" title="${escapeHtml(job.filenames.join(", "))}">${escapeHtml(job.filenames.join(", "))}</div>
        <div class="mt-1 text-xs text-slate-500">${job.fileCount} ${job.fileCount === 1 ? "file" : "files"}</div>
      </td>
      <td class="px-5 py-4">
        <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ring-1 ring-inset ${statusStyles[job.status] || ""}">${escapeHtml(job.status)}</span>
        ${job.error ? `<div class="mt-2 max-w-48 truncate text-xs text-rose-300" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</div>` : ""}
      </td>
      <td class="w-40 px-5 py-4">
        <div class="mb-1.5 flex justify-between text-xs text-slate-500"><span>${job.progress}%</span></div>
        <div class="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div class="h-full rounded-full bg-cyan-400 transition-all duration-500" style="width:${job.progress}%"></div>
        </div>
      </td>
      <td class="whitespace-nowrap px-5 py-4 text-xs text-slate-400">${formatTime(job.createdAt)}</td>
      <td class="whitespace-nowrap px-5 py-4 text-xs text-slate-400">${formatDuration(job.durationMs)}</td>
    </tr>
  `).join("");

  for (const key of ["total", "queued", "processing", "completed", "failed"]) {
    document.querySelector(`#stat-${key}`).textContent = stats[key] ?? 0;
  }
  elements.meta.textContent = `${stats.processing || 0} active of ${stats.concurrency || 0} worker slots`;
}

function setConnection(state) {
  const connected = state === "connected";
  elements.dot.className = `h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.8)]" : state === "error" ? "bg-rose-400" : "bg-amber-400"}`;
  elements.label.textContent = connected ? "Live" : state === "error" ? "Access required" : "Connecting";
}

function connect() {
  socket?.disconnect();
  setConnection("connecting");
  elements.error.classList.add("hidden");
  socket = window.io({ auth: { monitorKey: localStorage.getItem("ocrMonitorKey") || "" } });
  socket.on("connect", () => {
    setConnection("connected");
    elements.dialog.close();
  });
  socket.on("connect_error", () => {
    setConnection("error");
    elements.error.classList.remove("hidden");
    if (!elements.dialog.open) elements.dialog.showModal();
  });
  socket.on("monitor:snapshot", (snapshot) => {
    jobs.clear();
    snapshot.jobs.forEach((job) => jobs.set(job.id, job));
    stats = snapshot.stats;
    render();
  });
  socket.on("job:updated", (job) => {
    jobs.set(job.id, job);
    render();
  });
  socket.on("job:removed", (id) => {
    jobs.delete(id);
    render();
  });
  socket.on("queue:stats", (value) => {
    stats = value;
    render();
  });
}

document.querySelector("#access-button").addEventListener("click", () => {
  elements.key.value = localStorage.getItem("ocrMonitorKey") || "";
  elements.dialog.showModal();
});
document.querySelector("#cancel-access").addEventListener("click", () => elements.dialog.close());
document.querySelector("#refresh-button").addEventListener("click", connect);
elements.filter.addEventListener("change", render);
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem("ocrMonitorKey", elements.key.value);
  connect();
});

connect();
