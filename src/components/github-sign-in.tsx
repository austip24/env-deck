import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, Loader2, LogIn, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorCode, errorText, ipc, type GithubAccount, type GithubDeviceLogin } from "@/lib/ipc";

/**
 * "Sign in with GitHub" to the EnvDeck GitHub App via the Device Flow: shows the one-time code,
 * opens github.com/login/device (from Rust) and waits for approval. The token stays in Rust
 * memory for this session only, and only reaches repositories where the app is installed.
 */
export function GithubSignIn({
  account,
  reason,
  onSignedIn,
}: {
  account: GithubAccount;
  /** Why sign-in is needed again (e.g. GitHub rejected the token). */
  reason?: string | null;
  onSignedIn: (account: GithubAccount) => void;
}) {
  const [device, setDevice] = useState<GithubDeviceLogin | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef(false);

  // Cancel a pending sign-in if the dialog closes mid-way.
  useEffect(
    () => () => {
      if (waiting.current) void ipc.githubSignOut().catch(() => {});
    },
    [],
  );

  if (!account.configured) {
    return (
      <Alert>
        <TriangleAlert />
        <AlertTitle>GitHub sign-in isn't set up in this build</AlertTitle>
        <AlertDescription className="selectable">
          <p>
            Fill in <code>ENVDECK_GITHUB_CLIENT_ID</code> and <code>ENVDECK_GITHUB_APP_SLUG</code> in{" "}
            <code>src-tauri/.cargo/config.toml</code> with the client ID and slug of the EnvDeck GitHub App (with Device
            Flow enabled), then rebuild.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const d = await ipc.githubSignInStart();
      setDevice(d);
      waiting.current = true;
      try {
        const signedIn = await ipc.githubSignInWait();
        waiting.current = false;
        toast.success(`Signed in to GitHub as ${signedIn.login}`);
        onSignedIn(signedIn);
      } catch (e) {
        waiting.current = false;
        setDevice(null);
        if (!errorText(e).includes("cancelled")) setError(errorText(e));
      }
    } catch (e) {
      setError(errorCode(e) === "GH_NO_CLIENT" ? errorText(e) : `Couldn't start sign-in: ${errorText(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => void ipc.githubSignOut().catch(() => {});

  const copyCode = (code: string) =>
    void ipc
      .writeClipboardText(code)
      .then(() => toast.success("Copied code"))
      .catch((e) => toast.error(errorText(e)));

  return (
    <div className="flex flex-col items-center gap-3 rounded-md border px-6 py-6 text-center">
      {device ? (
        <>
          <p className="text-sm">
            Enter this code on GitHub to sign in to the EnvDeck GitHub App:
          </p>
          <div className="flex items-center gap-1">
            <code className="selectable rounded-md bg-muted px-3 py-1.5 font-mono text-2xl font-semibold tracking-widest">
              {device.userCode}
            </code>
            <Button variant="ghost" size="icon-sm" aria-label="Copy code" onClick={() => copyCode(device.userCode)}>
              <Copy />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void ipc.githubOpenVerification().catch(() => {})}>
              <ExternalLink /> Open github.com/login/device
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Waiting for you to approve on GitHub…
          </p>
        </>
      ) : (
        <>
          <p className="max-w-md text-sm text-muted-foreground">
            {reason ??
              "Sign in to the EnvDeck GitHub App to push keys from this file to Actions secrets and variables. It can only reach repositories where you've installed it. You stay signed in until you quit EnvDeck; nothing is saved."}
          </p>
          <Button onClick={() => void start()} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" /> : <LogIn />} Sign in with GitHub
          </Button>
        </>
      )}
      {error && <p className="selectable text-xs break-words text-destructive">{error}</p>}
    </div>
  );
}
