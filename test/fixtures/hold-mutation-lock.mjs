// Holds the mutation lease for a controlled window so tests can prove lock
// keying, waiting, and timeout behaviour against a real cross-process holder.
//
//   node hold-mutation-lock.mjs '<json>'
//   json: { root?, home?, global?, readyFile, releaseFile, timeoutMs? }
//
// The child acquires the lease, announces readiness by creating `readyFile`,
// heartbeats while it waits for `releaseFile`, then releases and exits.
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireMutationLock, controlPaths } from "../../src/mutation-lock.js";

// Executed directly by the suite runner with no arguments (everything under
// `test/` is treated as a test file), so a missing configuration is a no-op.
if (!process.argv[2]) process.exit(0);

const config = JSON.parse(process.argv[2]);
const paths = config.global
  ? controlPaths({ home: config.home, global: true })
  : controlPaths({ root: config.root });

const lease = await acquireMutationLock(paths, {
  timeoutMs: config.timeoutMs ?? 5000,
  heartbeatMs: 200,
});
await writeFile(config.readyFile, `${lease.token}\n`);

const deadline = Date.now() + (config.waitMs ?? 30000);
for (;;) {
  try {
    await access(config.releaseFile);
    break;
  } catch {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await lease.release();
