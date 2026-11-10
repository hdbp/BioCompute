// Browser walkthrough of the milestone-1 flow against a running stack.
// usage: BASE_URL=http://127.0.0.1:5173 BC_PASSWORD=... node e2e/launch-flow.cjs <experiment-id>
// Requires the bundled "biocompute-fastq-qc" pipeline and an experiment with samples.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const fs = require('fs'); fs.mkdirSync('shots', { recursive: true });
(async () => {
  const eid = process.argv[2];
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror ' + e.message));
  await p.goto(BASE + '/');
  await p.fill('input[type=password]', process.env.BC_PASSWORD || 'biocompute-dev'); await p.click('button[type=submit]'); await p.waitForTimeout(1200);
  await p.goto(`${BASE}/experiments/${eid}`); await p.waitForTimeout(2000);
  await p.screenshot({ path: 'shots/e2e_1_experiment.png' });
  await p.goto(`${BASE}/jobs/new?pipeline=biocompute-fastq-qc&experiment=${eid}`); await p.waitForTimeout(2500);
  await p.screenshot({ path: 'shots/e2e_2_launch.png', fullPage: true });
  await p.getByRole('button', { name: 'Validate' }).click(); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'Launch' }).click();
  await p.waitForURL(/\/runs\//, { timeout: 15000 });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'shots/e2e_3_run_live.png' });
  for (let i = 0; i < 60; i++) { if (await p.getByText('Completed', { exact: true }).count()) break; await p.waitForTimeout(1000); }
  await p.waitForTimeout(1000);
  await p.screenshot({ path: 'shots/e2e_4_run_done.png' });
  const runUrl = p.url();
  await p.goto(runUrl.replace('/runs/', '/results/')); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /report/ }).first().click(); await p.waitForTimeout(800);
  await p.getByRole('button', { name: /qc_report.html/ }).click(); await p.waitForTimeout(2500);
  await p.screenshot({ path: 'shots/e2e_5_results.png', fullPage: true });
  console.log(runUrl, errors.join('\n') || 'no errors');
  await b.close();
})();
