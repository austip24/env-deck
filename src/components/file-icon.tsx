import { Braces, FileCode, FileCog, FileKey, FileText, KeyRound, type LucideProps } from "lucide-react";
import type { FileKind } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const ICONS: Record<FileKind, React.ComponentType<LucideProps>> = {
  env: KeyRound,
  "env-template": FileKey,
  json: Braces,
  yaml: FileCode,
  toml: FileCog,
  ini: FileCog,
  text: FileText,
};

export const KIND_LABELS: Record<FileKind, string> = {
  env: "dotenv",
  "env-template": "template",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  ini: "INI",
  text: "text",
};

export function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = ICONS[kind];
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        kind === "env" ? "text-warning" : "text-muted-foreground",
        className,
      )}
    />
  );
}
