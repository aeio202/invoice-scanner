const cron = require('node-cron');
const { runScanForAllUsers } = require('./scanAllUsers');

const SCAN_CRON_SCHEDULE = process.env.SCAN_CRON_SCHEDULE || '0 3 * * *'; // 03:00 daily

function startScheduledScans() {
  // Off by default: without this gate, every `node index.js` during normal
  // local dev would silently register a job firing real Gmail/Claude API
  // calls if the process happens to be left running past the schedule.
  if (process.env.ENABLE_SCAN_CRON !== 'true') {
    console.log('[scan-job] cron disabled (set ENABLE_SCAN_CRON=true to enable).');
    return;
  }

  let isRunning = false;
  cron.schedule(SCAN_CRON_SCHEDULE, async () => {
    if (isRunning) {
      console.warn('[scan-job] previous run still in progress, skipping this tick.');
      return;
    }
    isRunning = true;
    try {
      await runScanForAllUsers();
    } catch (err) {
      // Should be unreachable — runScanForAllUsers catches per-user errors
      // internally and its own top-level select failure is also caught
      // internally — but a guard here means a bug in the job runner itself
      // can never crash the whole backend process.
      console.error('[scan-job] unexpected top-level failure:', err);
    } finally {
      isRunning = false;
    }
  });
  console.log(`[scan-job] scheduled with cron expression "${SCAN_CRON_SCHEDULE}"`);
}

module.exports = { startScheduledScans };
