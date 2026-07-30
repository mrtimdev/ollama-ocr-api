import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

class JobQueue extends EventEmitter {
  constructor({ concurrency = 1, retentionMs = 60 * 60 * 1000 } = {}) {
    super();
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.retentionMs = Math.max(60_000, Number(retentionMs) || 60 * 60 * 1000);
    this.jobs = new Map();
    this.pending = [];
    this.active = 0;
  }

  add({ type, owner, filenames, fileCount, run }) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      type,
      owner,
      filenames,
      fileCount,
      status: "queued",
      progress: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      result: null,
      error: null,
      run,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.emitState(job);
    queueMicrotask(() => this.drain());
    return this.publicJob(job);
  }

  async drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift();
      const job = this.jobs.get(id);
      if (!job) continue;
      this.active += 1;
      void this.execute(job);
    }
  }

  async execute(job) {
    job.status = "processing";
    job.progress = 10;
    job.startedAt = new Date().toISOString();
    this.emitState(job);

    try {
      job.result = await job.run((progress) => {
        job.progress = Math.max(job.progress, Math.min(99, Number(progress) || 0));
        this.emitState(job);
      });
      job.status = "completed";
      job.progress = 100;
    } catch (error) {
      job.status = "failed";
      job.progress = 100;
      job.error = error?.message || "Unexpected job error.";
    } finally {
      job.completedAt = new Date().toISOString();
      job.durationMs = Date.parse(job.completedAt) - Date.parse(job.startedAt);
      job.run = null;
      this.active -= 1;
      this.emitState(job);
      setTimeout(() => {
        this.jobs.delete(job.id);
        this.emit("removed", job.id);
      }, this.retentionMs).unref();
      void this.drain();
    }
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job, true) : null;
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.publicJob(job));
  }

  stats() {
    const jobs = [...this.jobs.values()];
    return {
      queued: jobs.filter((job) => job.status === "queued").length,
      processing: jobs.filter((job) => job.status === "processing").length,
      completed: jobs.filter((job) => job.status === "completed").length,
      failed: jobs.filter((job) => job.status === "failed").length,
      total: jobs.length,
      concurrency: this.concurrency,
    };
  }

  waitFor(id) {
    const current = this.jobs.get(id);
    if (!current) return Promise.reject(new Error("Job not found."));
    if (["completed", "failed"].includes(current.status)) return Promise.resolve(this.get(id));
    return new Promise((resolve) => {
      const listener = (job) => {
        if (job.id === id && ["completed", "failed"].includes(job.status)) {
          this.off("updated", listener);
          resolve(this.get(id));
        }
      };
      this.on("updated", listener);
    });
  }

  emitState(job) {
    this.emit("updated", this.publicJob(job));
    this.emit("stats", this.stats());
  }

  publicJob(job, includeResult = false) {
    const output = {
      id: job.id,
      type: job.type,
      owner: job.owner.name,
      ownerId: job.owner.keyId,
      filenames: job.filenames,
      fileCount: job.fileCount,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
      error: job.error,
    };
    if (includeResult) output.result = job.result;
    return output;
  }
}

export { JobQueue };
