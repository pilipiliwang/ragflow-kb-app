export class JobRunner {
  constructor(db, handlers = {}) {
    this.db = db;
    this.handlers = handlers;
    this.running = false;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.db.requeueInterruptedJobs();
    await this.db.save();
    this.schedule();
  }

  async enqueue(type, payload = {}) {
    if (!this.handlers[type]) throw new Error(`Unsupported job type: ${type}`);
    const job = this.db.createJob(type, payload);
    await this.db.save();
    this.schedule();
    return job;
  }

  schedule() {
    setTimeout(() => {
      this.drain().catch((error) => {
        console.error("Job runner failed:", error);
      });
    }, 0);
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      let job = this.db.getNextQueuedJob();
      while (job) {
        await this.run(job);
        job = this.db.getNextQueuedJob();
      }
    } finally {
      this.running = false;
    }
  }

  async run(job) {
    const startedAt = new Date().toISOString();
    this.db.updateJob(job.id, {
      status: "running",
      progress: 5,
      startedAt
    });
    await this.db.save();

    try {
      const result = await this.handlers[job.type](job.payload, {
        updateProgress: async (progress, result = undefined) => {
          this.db.updateJob(job.id, {
            status: "running",
            progress,
            ...(result === undefined ? {} : { result })
          });
          await this.db.save();
        }
      });
      this.db.updateJob(job.id, {
        status: "completed",
        progress: 100,
        result,
        error: "",
        finishedAt: new Date().toISOString()
      });
      await this.db.save();
    } catch (error) {
      this.db.updateJob(job.id, {
        status: "failed",
        progress: 100,
        error: error.message || "Job failed.",
        finishedAt: new Date().toISOString()
      });
      await this.db.save();
    }
  }
}
