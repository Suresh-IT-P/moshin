// Launches a packaged MeetMinder build and checks the core flow on a real machine:
// the window opens, a customer can be added, and a short recording is saved as
// CustomerName_timestamp.webm with a readable length. Screenshots go to <output folder>.
//
// Usage: node scripts/smoke-test.js <path to the MeetMinder executable> [output folder]
// Needs Playwright: npm install --no-save playwright-core
const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [executablePath, outDir = 'smoke-test-output'] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!executablePath) throw new Error('Pass the path to the MeetMinder executable.');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = (win, name) => win.screenshot({ path: path.join(outDir, `${name}.png`) });
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'meetminder-smoke-'));

  const env = { ...process.env, MEETMINDER_HOME: library };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath,
    // A built-in test tone stands in for the microphone.
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env,
  });
  // Test machines have nobody to click "Allow" on the macOS microphone prompt.
  await app.evaluate(({ systemPreferences }) => {
    systemPreferences.getMediaAccessStatus = () => 'granted';
    systemPreferences.askForMediaAccess = async () => true;
  });

  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (err) => errors.push(err.message));
  await win.waitForSelector('body.is-ready', { timeout: 30000 });
  await sleep(600);
  await shot(win, '1-dashboard');

  // Add a customer.
  await win.click('#page-actions [data-action="add-customer"]');
  const modal = win.locator('#layer-root .layer.is-open').last();
  await modal.locator('#cf-name').fill('Priya Sharma');
  await modal.locator('#cf-company').fill('Acme Industries');
  await modal.locator('[data-save]').click();
  await sleep(600);

  // Record a short meeting with one key moment.
  await win.click('[data-nav="meetings"]');
  await win.click('#page-actions [data-action="record"]');
  await sleep(800);
  await win.locator('.combo-menu .combo-option', { hasText: 'Priya Sharma' }).click();
  await win.waitForSelector('[data-start]:not([disabled])', { timeout: 20000 });
  await sleep(800);
  await shot(win, '2-record-dialog');
  await win.locator('[data-start]').click();
  await win.waitForSelector('.recorder-layer.is-open', { timeout: 20000 });
  await sleep(1500);
  await win.click('.recorder [data-act="mark"]');
  await win.keyboard.type('Budget approved');
  await sleep(1500);
  await shot(win, '3-recording');
  await win.click('.recorder [data-act="stop"]');
  await win.waitForSelector('.layer-drawer.is-open', { timeout: 30000 });
  await sleep(1000);
  await shot(win, '4-meeting-details');

  const data = await win.evaluate(() => window.api.data.load());
  const meeting = data.meetings[0] || {};
  const duration = await win.evaluate(async (src) => {
    const audio = new Audio();
    audio.src = src;
    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = resolve;
      audio.onerror = () => reject(new Error('The recording could not be loaded.'));
    });
    return audio.duration;
  }, meeting.fileUrl);
  await app.close();

  const checks = [
    ['saved as CustomerName_timestamp.webm', /^Priya_Sharma_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.webm$/.test(meeting.fileName || '')],
    ['recording file is in the Recordings folder', fs.existsSync(path.join(library, 'Recordings', meeting.fileName || '-'))],
    ['recording has a readable length', Number.isFinite(duration) && duration > 1],
    ['key moment saved', (meeting.marks || []).length === 1],
    ['no errors in the app', errors.length === 0],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`file: ${meeting.fileName}  length: ${duration?.toFixed?.(1)}s  size: ${meeting.sizeBytes} bytes`);
  if (errors.length) console.log(errors.join('\n'));
  fs.rmSync(library, { recursive: true, force: true });
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
