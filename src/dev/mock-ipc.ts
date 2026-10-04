// Mock IPC for `npm run dev:mock`. Never imported by the app bundle (see main.tsx).
import { mockIPC } from "@tauri-apps/api/mocks";

// Sentinel checked by scripts/check-bundle.mjs; do not remove.
export const MOCK_SENTINEL = "__ENVDECK_MOCK_IPC__";

mockIPC(
  (cmd) => {
    // Command handlers arrive in M4.
    throw new Error(`mock-ipc: no handler for "${cmd}"`);
  },
  { shouldMockEvents: true },
);

console.info(`[${MOCK_SENTINEL}] mock IPC active`);
