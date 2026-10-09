"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyIcon, DownloadIcon, PuzzleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

type Shell = "powershell" | "bash";

function installCommand(shell: Shell, origin: string) {
  const url = `${origin}/api/extension`;
  if (shell === "powershell") {
    return `iwr ${url} -UseBasicParsing -OutFile "$env:TEMP\\exchanger.vsix"; code --install-extension "$env:TEMP\\exchanger.vsix" --force`;
  }
  return `curl -fsSL ${url} -o /tmp/exchanger.vsix && code --install-extension /tmp/exchanger.vsix --force`;
}

/** Блок установки расширения VS Code прямо с этого сервера. */
export function ExtensionInstall() {
  const [version, setVersion] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [shell, setShell] = useState<Shell>("powershell");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/extension?info=1", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (cancelled) return;
        setVersion(info?.version ?? null);
        setOrigin(location.origin);
        if (!/windows/i.test(navigator.userAgent)) setShell("bash");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;
  const command = installCommand(shell, origin);

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PuzzleIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Расширение VS Code</h2>
          <span className="text-xs text-muted-foreground">v{version}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href="/api/extension" download />}
        >
          <DownloadIcon /> Скачать .vsix
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Выполни в терминале — потом в VS Code: Developer: Reload Window. Адрес сервера расширение
        получит само при первом перетаскивании файла на эту страницу.
      </p>
      <div className="flex gap-1">
        {(["powershell", "bash"] as const).map((s) => (
          <Button
            key={s}
            variant={shell === s ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setShell(s)}
          >
            {s === "powershell" ? "PowerShell" : "bash / zsh"}
          </Button>
        ))}
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-muted p-2">
        <code className="flex-1 font-mono text-xs break-all">{command}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Копировать команду"
          onClick={() =>
            copyText(command).then(
              () => toast.success("Команда скопирована"),
              () => toast.error("Не удалось скопировать"),
            )
          }
        >
          <CopyIcon />
        </Button>
      </div>
    </section>
  );
}
