const cron = require('node-cron');
const { runScanForAllUsers } = require('./scanAllUsers');
const { runForwardForAllUsers } = require('./forwardInvoices');

const SCAN_CRON_SCHEDULE = process.env.SCAN_CRON_SCHEDULE || '0 3 * * *'; // 03:00 daily
const FORWARD_CRON_SCHEDULE = process.env.FORWARD_CRON_SCHEDULE || '0 4 1 * *'; // 04:00 on the 1st

// Shared registration logic (env-gated, re-entrancy-guarded). Off by
// default: without the gate, every `node index.js` during normal local dev
// would silently register a job firing real API calls if the process
// happens to be left running past the schedule.
function registerJob(label, enableEnvVar, schedule, runFn) {
  if (process.env[enableEnvVar] !== 'true') {
    console.log(`[${label}] cron disabled (set ${enableEnvVar}=true to enable).`);
    return;
  }

  let isRunning = false;
  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.warn(`[${label}] previous run still in progress, skipping this tick.`);
      return;
    }
    isRunning = true;
    try {
      await runFn();
    } catch (err) {
      // Should be unreachable — runFn catches its own per-user/top-level
      // errors internally — but a guard here means a bug in the job runner
      // itself can never crash the whole backend process.
      console.error(`[${label}] unexpected top-level failure:`, err);
    } finally {
      isRunning = false;
    }
  });
  console.log(`[${label}] scheduled with cron expression "${schedule}"`);
}

function startScheduledJobs() {
  registerJob('scan-job', 'ENABLE_SCAN_CRON', SCAN_CRON_SCHEDULE, runScanForAllUsers);
  registerJob('forward-job', 'ENABLE_FORWARD_CRON', FORWARD_CRON_SCHEDULE, runForwardForAllUsers);
}

module.exports = { startScheduledJobs };
