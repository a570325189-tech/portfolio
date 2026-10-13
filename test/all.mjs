import { spawnSync } from 'node:child_process';
import path from 'node:path';

const suites = ['run-tests.mjs', 'check-frontend.mjs', 'dom-test.mjs', 'visibility-test.mjs', 'migrate-test.mjs'];
let failed = 0;
for (const suite of suites) {
  console.log('=== ' + suite + ' ===');
  const res = spawnSync(process.execPath, [path.join('test', suite)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}
console.log('');
console.log(failed === 0 ? 'ALL SUITES PASSED' : (failed + ' suite(s) failed'));
process.exit(failed === 0 ? 0 : 1);
