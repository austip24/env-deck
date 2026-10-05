// Every way of getting a config out of EnvDeck (ARCHITECTURE.md §3), with consistent toasts.
// Values copied here are unmasked on purpose: copying is an explicit action.

import { useMemo } from "react";
import { toast } from "sonner";
import { COPY_FORMATS, formatVars, type CopyFormat, type Var } from "@/lib/env";
import { errorText, ipc, type Editor } from "@/lib/ipc";
import { EDITOR_NAMES, editorUrl, revealLabel } from "@/lib/platform";

async function attempt(action: () => Promise<unknown>, success?: string, description?: string) {
  try {
    await action();
    if (success) toast.success(success, description ? { description } : undefined);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export interface CopyActions {
  copyText: (text: string, what: string) => Promise<void>;
  copyContents: (text: string, name: string) => Promise<void>;
  copyVarsAs: (vars: Var[], format: CopyFormat) => Promise<void>;
  copyPath: (path: string) => Promise<void>;
  copyFile: (path: string) => Promise<void>;
  openInEditor: (path: string, line?: number) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  startDrag: (path: string) => void;
  editorName: string;
  revealLabel: string;
}

export function useCopy(editor: Editor = "vscode"): CopyActions {
  return useMemo(
    () => ({
      editorName: EDITOR_NAMES[editor],
      revealLabel,

      copyText: (text, what) => attempt(() => ipc.writeClipboardText(text), `Copied ${what}`),

      copyContents: (text, name) => attempt(() => ipc.writeClipboardText(text), `Copied contents of ${name}`),

      copyVarsAs: async (vars, format) => {
        if (vars.length === 0) {
          toast.info("No variables to copy");
          return;
        }
        const { text, warnings } = formatVars(vars, format);
        const label = COPY_FORMATS.find((f) => f.id === format)?.label ?? format;
        const what = `${vars.length} ${vars.length === 1 ? "variable" : "variables"} as ${label}`;
        try {
          await ipc.writeClipboardText(text);
          if (warnings.length) toast.warning(`Copied ${what}`, { description: warnings.join("\n") });
          else toast.success(`Copied ${what}`);
        } catch (e) {
          toast.error(errorText(e));
        }
      },

      copyPath: (path) => attempt(() => ipc.writeClipboardText(path), "Copied path"),

      copyFile: (path) =>
        attempt(() => ipc.copyFilesToClipboard([path]), "Copied file", "Paste it into a folder or the VS Code explorer."),

      openInEditor: async (path, line) => {
        try {
          await ipc.openEditorUrl(editorUrl(editor, path, line));
        } catch (e) {
          toast.error(`Couldn't open ${EDITOR_NAMES[editor]}. Is it installed?`, { description: errorText(e) });
        }
      },

      reveal: (path) => attempt(() => ipc.reveal(path)),

      startDrag: (path) => {
        void ipc.startDrag(path).catch((e) => toast.error(errorText(e)));
      },
    }),
    [editor],
  );
}
