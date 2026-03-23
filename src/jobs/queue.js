/**
 * Background job queue using pg-boss (Postgres-backed).
 * No additional infrastructure needed — uses the same Postgres DB.
 *
 * Jobs:
 *  - 'csv-import'      : Process large CSV imports async
 *  - 'bulk-email'      : Send bulk email notifications
 *  - 'report-generate' : Generate heavy reports
 *  - 'fee-reminders'   : Send monthly fee reminder emails
 */

const PgBoss = require('pg-boss');

let boss = null;
let isReady = false;

async function getQueue() {
  if (boss && isReady) return boss;

  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    ssl: (() => {
      const url = process.env.DATABASE_URL || '';
      return (url.includes('localhost') || url.includes('127.0.0.1'))
        ? false
        : { rejectUnauthorized: true };
    })(),
    retryLimit: 3,
    retryDelay: 30,           // seconds between retries
    expireInHours: 24,        // jobs expire after 24h if not started
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7, // keep 7 days
    deleteAfterDays: 30,
    monitorStateIntervalMinutes: 1,
  });

  boss.on('error', (err) => console.error('[queue] pg-boss error:', err.message));

  await boss.start();
  isReady = true;
  console.log('✅  pg-boss job queue started.');
  return boss;
}

/**
 * Send a job to the queue.
 * Returns jobId.
 */
async function enqueue(jobName, data, options = {}) {
  try {
    const q = await getQueue();
    const jobId = await q.send(jobName, data, {
      retryLimit: options.retryLimit ?? 3,
      retryDelay: options.retryDelay ?? 30,
      expireInHours: options.expireInHours ?? 24,
      ...options,
    });
    return jobId;
  } catch (err) {
    console.error(`[queue] Failed to enqueue ${jobName}:`, err.message);
    throw err;
  }
}

/**
 * Get job status by ID.
 * Returns an object with status, progress, result, and timestamps.
 */
async function getJobStatus(jobId) {
  try {
    const q = await getQueue();
    const job = await q.getJobById(jobId);
    if (!job) return { status: 'not_found', jobId };
    return {
      jobId: job.id,
      name: job.name,
      status: job.state,       // created, retry, active, completed, expired, cancelled, failed
      progress: job.output?.progress ?? null,
      result: job.output ?? null,
      createdAt: job.createdon,
      completedAt: job.completedon,
      startedAt: job.startedon,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * Register a worker for a job type.
 * handler: async (job) => result
 */
async function work(jobName, handler, options = {}) {
  const q = await getQueue();
  await q.work(jobName, { teamSize: options.teamSize ?? 2, teamConcurrency: options.teamConcurrency ?? 1 }, handler);
  console.log(`[queue] Worker registered for: ${jobName}`);
}

async function stop() {
  if (boss) await boss.stop();
}

module.exports = { getQueue, enqueue, getJobStatus, work, stop };
