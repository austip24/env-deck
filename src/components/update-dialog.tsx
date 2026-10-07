import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type { Updates } from "@/hooks/use-update";
import { progressLabel, progressPercent, releaseDate } from "@/lib/update";

export function UpdateDialog({ updates }: { updates: Updates }) {
  const { update, dialogOpen, setDialogOpen, installing, progress } = updates;
  if (!update) return null;
  const percent = progressPercent(progress);
  const date = releaseDate(update.date);

  return (
    <Dialog open={dialogOpen} onOpenChange={(o) => !installing && setDialogOpen(o)}>
      <DialogContent className="sm:max-w-md" showCloseButton={!installing}>
        <DialogHeader>
          <DialogTitle>Update to EnvDeck {update.version}</DialogTitle>
          <DialogDescription>
            You have {update.currentVersion}.{date && ` Released ${date}.`} EnvDeck restarts to finish the update.
          </DialogDescription>
        </DialogHeader>

        {update.notes && (
          <div className="selectable max-h-60 overflow-auto rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
            {update.notes}
          </div>
        )}

        {installing && (
          <div className="grid gap-1.5">
            <Progress value={percent ?? 0} aria-label="Download progress" />
            <p className="text-xs text-muted-foreground">
              {percent === 100 ? "Installing…" : progressLabel(progress)}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={installing} onClick={() => setDialogOpen(false)}>
            Later
          </Button>
          <Button disabled={installing} onClick={() => void updates.install()}>
            {installing ? "Updating…" : "Install and restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
