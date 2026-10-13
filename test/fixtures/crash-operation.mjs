// Runs a public operation and dies abruptly (SIGKILL) at a chosen durable
// step through the shared fault seam, leaving the journal exactly as a killed
// process would.
//
//   node crash-operation.mjs '<json>'
//   json: { operation: 'init' | 'uninstall', root, targetStep, reachedFile, completedFile }
import { writeFile } from "node:fs/promises";
import { initOperation, uninstallOperation } from "../../src/operations.js";
import { journaledTransactionInternals } from "../../src/recovery.js";

// Executed directly by the suite runner with no arguments (everything under
// `test/` is treated as a test file), so a missing configuration is a no-op.
if (!process.argv[2]) process.exit(0);

const config = JSON.parse(process.argv[2]);

journaledTransactionInternals.onStep = async (step) => {
  if (step === config.targetStep) {
    await writeFile(config.reachedFile, step, "utf8");
    process.kill(process.pid, "SIGKILL");
  }
};

const operation = config.operation === "uninstall" ? uninstallOperation : initOperation;
await operation({ root: config.root });
await writeFile(config.completedFile, "done", "utf8");
