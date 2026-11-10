// `npm run test:security-real` — the REQUIRED real-policy proof (reviewer 36d9 #3).
// Runs test/device-access-real.test.mjs against an installed DSH and FAILS (exit 1)
// when DSH_INSTALL_ROOT is not set, instead of the explicit-skip exit 0 that the
// default `npm test` keeps. Cross-platform: no shell env syntax involved.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.DSH_INSTALL_ROOT) {
  console.error('test:security-real FAILED: DSH_INSTALL_ROOT is not set; the real-policy proof requires an installed DSH 0.2.2-rc.1')
  process.exit(1)
}
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./device-access-real.test.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, DSH_REAL_REQUIRED: '1' },
})
process.exit(result.status ?? 1)
