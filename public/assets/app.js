const jobs = new Map();
let stats = { total: 0, queued: 0, processing: 0, completed: 0, failed: 0, concurrency: 0 };
let socket;
let pollingTimer;
let monitorAccessGranted = false;
const selectedJobIds = new Set();

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
  jobDialog: document.querySelector("#job-dialog"),
  jobDetails: document.querySelector("#job-details"),
  selectAll: document.querySelector("#select-all-jobs"),
  bulkMore: document.querySelector("#bulk-more-button"),
  bulkRetry: document.querySelector("#bulk-retry-button"),
  bulkDelete: document.querySelector("#bulk-delete-button"),
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
      <td class="px-5 py-4"><input type="checkbox" data-job-select data-job-id="${escapeHtml(job.id)}" class="h-4 w-4 rounded border-white/20 bg-slate-950" ${selectedJobIds.has(job.id) ? "checked" : ""}></td>
      <td class="px-5 py-4">
        <div class="font-mono text-xs text-slate-300">${escapeHtml(job.id.slice(0, 8))}</div>
        <div class="mt-1 text-xs capitalize text-slate-500">${escapeHtml(job.type)}</div>
      </td>
      <td class="px-5 py-4">
        <div class="font-medium text-slate-200">${escapeHtml(job.metadata?.username || job.owner)}</div>
        ${job.metadata?.username ? `<div class="mt-1 text-xs text-cyan-400/70">Spring uploader</div>` : ""}
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
      <td class="whitespace-nowrap px-5 py-4">
        <div class="flex gap-2">
          <button type="button" data-job-action="more" data-job-id="${escapeHtml(job.id)}" class="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10">More</button>
          <button type="button" data-job-action="retry" data-job-id="${escapeHtml(job.id)}" class="rounded-lg border border-cyan-400/20 px-2.5 py-1.5 text-xs text-cyan-300 hover:bg-cyan-400/10" ${job.metadata?.scanIds?.length && ["completed", "failed"].includes(job.status) ? "" : "disabled"}>Retry</button>
          <button type="button" data-job-action="delete" data-job-id="${escapeHtml(job.id)}" class="rounded-lg border border-rose-400/20 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-400/10" ${["completed", "failed"].includes(job.status) ? "" : "disabled"}>Delete</button>
        </div>
        ${job.actionStatus ? `<div class="mt-2 max-w-64 text-xs text-slate-500">${escapeHtml(job.actionStatus)}</div>` : ""}
      </td>
    </tr>
  `).join("");

  for (const key of ["total", "queued", "processing", "completed", "failed"]) {
    document.querySelector(`#stat-${key}`).textContent = stats[key] ?? 0;
  }
  elements.meta.textContent = `${stats.processing || 0} active of ${stats.concurrency || 0} worker slots`;
  updateSelectionControls(visible);
}

function updateSelectionControls(visibleJobs = [...jobs.values()]) {
  const selected = [...selectedJobIds].map((id) => jobs.get(id)).filter(Boolean);
  const visibleIds = visibleJobs.map((job) => job.id);
  elements.selectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedJobIds.has(id));
  elements.selectAll.indeterminate = visibleIds.some((id) => selectedJobIds.has(id)) && !elements.selectAll.checked;
  elements.bulkMore.disabled = selected.length !== 1;
  elements.bulkRetry.disabled = !selected.some((job) => job.metadata?.scanIds?.length && ["completed", "failed"].includes(job.status));
  elements.bulkDelete.disabled = !selected.some((job) => ["completed", "failed"].includes(job.status));
}

async function monitorAction(jobId, action) {
  const response = await fetch(`/api/v1/monitor/jobs/${encodeURIComponent(jobId)}${action === "retry" ? "/retry" : ""}`, {
    method: action === "delete" ? "DELETE" : "POST",
    headers: {
      Accept: "application/json",
      "X-Monitor-Key": localStorage.getItem("ocrMonitorKey") || "",
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Monitor action failed (${response.status}).`);
  }
  return result;
}

function monitorHeaders() {
  return {
    Accept: "application/json",
    "X-Monitor-Key": localStorage.getItem("ocrMonitorKey") || "",
  };
}

async function openJobDetails(job) {
  elements.jobDialog.showModal();
  elements.jobDetails.innerHTML = `
    <section class="rounded-xl bg-slate-950 p-4">
      <div class="grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
        <div><span class="text-slate-500">Job</span><div class="mt-1 font-mono">${escapeHtml(job.id)}</div></div>
        <div><span class="text-slate-500">Uploader</span><div class="mt-1">${escapeHtml(job.metadata?.username || job.owner)}</div></div>
        <div><span class="text-slate-500">Action</span><div class="mt-1 font-mono">${escapeHtml(job.metadata?.action || "—")}</div></div>
        <div><span class="text-slate-500">Redis queue</span><div class="mt-1 font-mono">${escapeHtml(job.metadata?.queueName || "—")}</div></div>
        <div><span class="text-slate-500">Provider ID</span><div class="mt-1">${escapeHtml(job.metadata?.providerId ?? "Loop providers")}</div></div>
        <div><span class="text-slate-500">Status</span><div class="mt-1">${escapeHtml(job.status)}</div></div>
        <div><span class="text-slate-500">Duration</span><div class="mt-1">${escapeHtml(formatDuration(job.durationMs))}</div></div>
      </div>
      ${job.error ? `<div class="mt-4 rounded-lg bg-rose-400/10 p-3 text-xs text-rose-300">${escapeHtml(job.error)}</div>` : ""}
    </section>
    <section id="spring-scan-details" class="grid gap-4 sm:grid-cols-2">
      <div class="col-span-2 rounded-xl bg-slate-950 p-4 text-sm text-slate-400">Loading Spring scan images…</div>
    </section>
    <pre class="overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-300">${escapeHtml(JSON.stringify(job, null, 2))}</pre>`;

  const scanDetails = document.querySelector("#spring-scan-details");
  if (!job.metadata?.scanIds?.length) {
    scanDetails.innerHTML = `<div class="col-span-2 rounded-xl bg-slate-950 p-4 text-sm text-slate-500">No Spring scans are linked to this job.</div>`;
    return;
  }

  try {
    const response = await fetch(`/api/v1/monitor/jobs/${encodeURIComponent(job.id)}/scans`, {
      cache: "no-store",
      headers: monitorHeaders(),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not load Spring scans (${response.status}).`);

    const cards = await Promise.all((result.scans || []).map(async (scan) => {
      const imageResponse = await fetch(
        `/api/v1/monitor/jobs/${encodeURIComponent(job.id)}/scans/${encodeURIComponent(scan.id)}/image`,
        { cache: "no-store", headers: monitorHeaders() },
      );
      if (!imageResponse.ok) throw new Error(`Could not load image for scan ${scan.id}.`);
      const imageUrl = URL.createObjectURL(await imageResponse.blob());
      return `
        <article class="overflow-hidden rounded-xl bg-slate-950">
          <img src="${imageUrl}" alt="${escapeHtml(scan.originalFilename || `Scan ${scan.id}`)}"
               class="h-96 w-full bg-black object-contain">
          <div class="space-y-1 p-4 text-xs text-slate-400">
            <div class="font-medium text-slate-200">${escapeHtml(scan.originalFilename || `Scan ${scan.id}`)}</div>
            <div>Scan #${escapeHtml(scan.id)} · ${escapeHtml(scan.status)}</div>
            <div>Invoice: ${escapeHtml(scan.invoiceNo || "—")}</div>
          </div>
        </article>`;
    }));
    scanDetails.innerHTML = cards.join("");
  } catch (error) {
    scanDetails.innerHTML = `<div class="col-span-2 rounded-xl bg-rose-400/10 p-4 text-sm text-rose-300">${escapeHtml(error.message)}</div>`;
  }
}

elements.body.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-job-action]");
  if (!button) {
    const checkbox = event.target.closest("[data-job-select]");
    if (checkbox) {
      checkbox.checked ? selectedJobIds.add(checkbox.dataset.jobId) : selectedJobIds.delete(checkbox.dataset.jobId);
      updateSelectionControls();
    }
    return;
  }
  const job = jobs.get(button.dataset.jobId);
  if (!job) return;
  const action = button.dataset.jobAction;
  if (action === "more") {
    await openJobDetails(job);
    return;
  }
  if (action === "delete" && !window.confirm("Delete this OCR monitor record? Spring scans and Redis jobs will not be deleted.")) return;
  if (action === "retry" && !window.confirm(`Requeue ${job.metadata?.scanIds?.length || 0} scan(s) in Spring Redis?`)) return;
  button.disabled = true;
  try {
    await monitorAction(job.id, action);
  } catch (error) {
    window.alert(error.message);
  } finally {
    button.disabled = false;
  }
});

elements.selectAll.addEventListener("change", () => {
  const selectedStatus = elements.filter.value;
  [...jobs.values()]
    .filter((job) => selectedStatus === "all" || job.status === selectedStatus)
    .forEach((job) => elements.selectAll.checked ? selectedJobIds.add(job.id) : selectedJobIds.delete(job.id));
  render();
});

async function runBulkAction(action) {
  const selected = [...selectedJobIds].map((id) => jobs.get(id)).filter(Boolean);
  const eligible = action === "retry"
    ? selected.filter((job) => job.metadata?.scanIds?.length && ["completed", "failed"].includes(job.status))
    : selected.filter((job) => ["completed", "failed"].includes(job.status));
  if (!eligible.length) return;
  if (!window.confirm(`${action === "retry" ? "Retry" : "Delete"} ${eligible.length} selected OCR request(s)?`)) return;
  await Promise.allSettled(eligible.map((job) => monitorAction(job.id, action)));
  if (action === "delete") eligible.forEach((job) => selectedJobIds.delete(job.id));
  render();
}

elements.bulkRetry.addEventListener("click", () => runBulkAction("retry"));
elements.bulkDelete.addEventListener("click", () => runBulkAction("delete"));
elements.bulkMore.addEventListener("click", () => {
  const job = jobs.get([...selectedJobIds][0]);
  if (job) openJobDetails(job);
});
document.querySelector("#close-job-dialog").addEventListener("click", () => {
  elements.jobDialog.close();
});

function setConnection(state) {
  const connected = state === "connected";
  elements.dot.className = `h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.8)]" : state === "error" ? "bg-rose-400" : "bg-amber-400"}`;
  elements.label.textContent = connected
    ? "Live"
    : state === "polling"
      ? "Live (polling)"
      : state === "error"
        ? "Access required"
        : "Connecting";
}

function applySnapshot(snapshot) {
  jobs.clear();
  (snapshot.jobs || []).forEach((job) => jobs.set(job.id, job));
  stats = snapshot.stats || stats;
  render();
}

async function loadMonitorSnapshot() {
  const response = await fetch("/api/v1/monitor/jobs", {
    credentials: "same-origin",
    cache: "no-store",
    headers: monitorHeaders(),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Monitor access failed (${response.status}).`);
  }
  applySnapshot(result);
}

function startMonitorPolling() {
  window.clearInterval(pollingTimer);
  setConnection("polling");
  pollingTimer = window.setInterval(async () => {
    try {
      await loadMonitorSnapshot();
    } catch {
      window.clearInterval(pollingTimer);
      monitorAccessGranted = false;
      setConnection("error");
      if (!elements.dialog.open) elements.dialog.showModal();
    }
  }, 5000);
}

async function connect() {
  socket?.disconnect();
  window.clearInterval(pollingTimer);
  monitorAccessGranted = false;
  setConnection("connecting");
  elements.error.classList.add("hidden");
  try {
    await loadMonitorSnapshot();
    monitorAccessGranted = true;
    elements.dialog.close();
  } catch (error) {
    setConnection("error");
    elements.error.textContent = error.message;
    elements.error.classList.remove("hidden");
    if (!elements.dialog.open) elements.dialog.showModal();
    return;
  }

  socket = window.io({ auth: { monitorKey: localStorage.getItem("ocrMonitorKey") || "" } });
  socket.on("connect", () => {
    window.clearInterval(pollingTimer);
    setConnection("connected");
    elements.dialog.close();
  });
  socket.on("connect_error", () => {
    if (monitorAccessGranted) {
      startMonitorPolling();
      return;
    }
    setConnection("error");
    if (!elements.dialog.open) elements.dialog.showModal();
  });
  socket.on("monitor:snapshot", (snapshot) => {
    applySnapshot(snapshot);
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
