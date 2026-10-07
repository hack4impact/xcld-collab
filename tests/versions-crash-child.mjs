// D2 helper, run as a child process by tests/versions.test.mjs: submits one branch and kills
// itself (SIGKILL, no cleanup) when the commit reaches the given step.
//   node tests/versions-crash-child.mjs <boardsDir> <step> <board> <branch-json>
import { createVersionStore } from "../app/server/versions.mjs";

const [boardsDir, crashAt, board, branchJson] = process.argv.slice(2);
const store = createVersionStore({
  boardsDir,
  testHooks: {
    onStep: (step) => {
      if (step === crashAt) {
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
});
await store.submitBranch(board, JSON.parse(branchJson));
// Reaching here means the step never ran.
process.exit(3);
