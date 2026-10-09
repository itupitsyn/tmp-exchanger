"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyIcon, DownloadIcon, PlugIcon, PlugZapIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExtensionInstall } from "@/components/extension-install";
import { copyText } from "@/lib/clipboard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type StoredFile = { path: string; name: string; size: number; mtime: string };
type Upload = { path: string; file: File };

const POLL_MS = 3000;
/** Тип данных при перетаскивании строки в VS Code (см. vscode-extension/drop-in.js). */
const EXCHANGER_MIME = "application/vnd.exchanger.file+json";
/** id расширения VS Code на этой машине, полученный при знакомстве (см. vscode-extension/relay.js). */
const CLIENT_KEY = "exchanger.vscodeClient";
/** Сколько ждать, пока окна VS Code подтвердят получение запроса. */
const ACK_WAIT_MS = 4000;
/** Сколько ждать окончания загрузки после подтверждения. */
const DONE_WAIT_MS = 5 * 60_000;
const PAIR_WAIT_MS = 60_000;

type RelayResult = { sent: string[]; failed: string[]; skipped: string[]; ack?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** crypto.randomUUID есть только в secure context, а страницу открывают и по http://192.168.x.x. */
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadClient() {
  try {
    return localStorage.getItem(CLIENT_KEY);
  } catch {
    return null;
  }
}

function saveClient(client: string | null) {
  try {
    if (client) localStorage.setItem(CLIENT_KEY, client);
    else localStorage.removeItem(CLIENT_KEY);
  } catch {
    // без localStorage просто придётся знакомиться заново
  }
}

function rawUrl(path: string) {
  return `/api/files/raw?path=${encodeURIComponent(path)}`;
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatAgo(iso: string) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec} с назад`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин назад`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч назад`;
  return new Date(iso).toLocaleString();
}

function joinPath(prefix: string, path: string) {
  const p = prefix.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return p ? `${p}/${path}` : path;
}

/** Обходит перетащенные файлы и папки, сохраняя пути внутри папок. */
async function collectDropped(dt: DataTransfer): Promise<Upload[]> {
  const entries = [...dt.items]
    .filter((it) => it.kind === "file")
    .map((it) => it.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);

  if (!entries.length) return [...dt.files].map((file) => ({ path: file.name, file }));

  const result: Upload[] = [];
  async function walk(entry: FileSystemEntry) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      result.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries отдаёт содержимое порциями, читаем до пустого ответа.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  }
  for (const entry of entries) await walk(entry);
  return result;
}

/** Абсолютные пути файлов, перетащенных из VS Code (содержимого браузер не получает). */
function vsCodePaths(dt: DataTransfer): string[] {
  try {
    const codefiles = dt.getData("codefiles");
    if (codefiles) return JSON.parse(codefiles);
  } catch {
    // формат поменялся — пробуем запасной
  }
  return dt
    .getData("application/vnd.code.uri-list")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("file:"));
}

/**
 * Передаёт пути расширению через сервер. Запрос получают все окна VS Code на машине,
 * каждое берёт только файлы из своего workspace. null — ни одно окно не ответило.
 */
async function sendViaRelay(client: string, paths: string[]) {
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client, paths }),
  });
  if (!res.ok) throw new Error(`relay: ${res.status}`);
  const { id } = await res.json();

  const poll = async (): Promise<RelayResult[]> =>
    (await (await fetch(`/api/relay/result?id=${id}`, { cache: "no-store" })).json()).results;

  // Сначала ждём подтверждений, потом — финальных отчётов от каждого подтвердившего окна.
  let results: RelayResult[] = [];
  const ackDeadline = Date.now() + ACK_WAIT_MS;
  while (Date.now() < ackDeadline && !results.some((r) => r.ack)) {
    await sleep(300);
    results = await poll();
  }
  if (!results.some((r) => r.ack)) return null;

  await sleep(500); // даём ответить остальным окнам
  const doneDeadline = Date.now() + DONE_WAIT_MS;
  for (;;) {
    results = await poll();
    const acks = results.filter((r) => r.ack).length;
    if (results.length - acks >= acks || Date.now() > doneDeadline) break;
    await sleep(500);
  }

  const done = results.filter((r) => !r.ack);
  return {
    sent: done.flatMap((r) => r.sent),
    failed: done.flatMap((r) => r.failed),
    // Не взяло ни одно окно — значит файл вне всех открытых workspace.
    skipped: paths.filter((p) => done.every((r) => r.skipped.includes(p))),
  };
}

/** Ждёт, пока расширение, открытое по ссылке vscode://, сообщит свой id. */
async function waitPair(pairId: string) {
  const deadline = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    const res = await fetch(`/api/relay/pair?pairId=${encodeURIComponent(pairId)}`, {
      cache: "no-store",
    }).catch(() => null);
    const client = res?.ok ? (await res.json()).client : null;
    if (client) return client as string;
  }
  return null;
}

export function FileExchanger() {
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [prefix, setPrefix] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  // Знакома ли страница с VS Code на этой машине; localStorage читаем только на клиенте.
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPaired(Boolean(loadClient())), 0);
    return () => clearTimeout(t);
  }, []);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (res.ok) setFiles((await res.json()).files);
    } catch {
      // сервер недоступен — попробуем на следующем тике
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh]);

  const upload = useCallback(
    async (uploads: Upload[]) => {
      if (!uploads.length) return;
      setBusy(true);
      let failed = 0;
      for (const { path, file } of uploads) {
        const target = joinPath(prefix, path);
        const res = await fetch(`/api/files?path=${encodeURIComponent(target)}`, {
          method: "PUT",
          body: file,
        }).catch(() => null);
        if (!res?.ok) failed++;
      }
      setBusy(false);
      await refresh();
      if (failed) toast.error(`Не загрузилось: ${failed} из ${uploads.length}`);
      else toast.success(`Загружено: ${uploads.length}`);
    },
    [prefix, refresh],
  );

  /**
   * Знакомство с расширением через vscode://. Вызывать только из обработчика клика:
   * без жеста пользователя Chrome ссылку не откроет.
   */
  const connect = useCallback(async () => {
    const pairId = randomId();
    // Синхронно, до любых await — иначе жест «протухнет».
    // server — чтобы свежеустановленное расширение само узнало адрес сервера.
    window.location.href = `vscode://local.exchanger/pair?id=${pairId}&server=${encodeURIComponent(
      location.origin,
    )}`;
    const id = toast.loading("Подключаю VS Code…", {
      description: "Разреши браузеру открыть VS Code и подтверди подключение в VS Code.",
    });
    const client = await waitPair(pairId);
    if (!client) {
      toast.error("VS Code не ответил", {
        id,
        description: "Проверь, что стоит расширение Exchanger 0.5.0 (блок внизу страницы).",
      });
      return false;
    }
    saveClient(client);
    setPaired(true);
    toast.success("VS Code подключён", { id });
    return true;
  }, []);

  const sendFromVsCode = useCallback(
    async function send(paths: string[], justPaired = false) {
      const id = toast.loading("Передаю в VS Code…");
      const client = loadClient();
      let result;
      try {
        result = client ? await sendViaRelay(client, paths) : null;
      } catch (e) {
        toast.error("Не удалось передать в VS Code", { id, description: String(e) });
        return;
      }

      if (!result) {
        saveClient(null);
        setPaired(false);
        if (justPaired) {
          toast.error("VS Code подключился, но не ответил на запрос", { id });
          return;
        }
        // Расширение на этой машине ещё не знакомо странице (или не запущено).
        // Ссылку vscode:// Chrome открывает только по клику, а drop кликом не считается.
        toast.info("Подключи VS Code", {
          id,
          duration: Infinity,
          description: client
            ? "VS Code не ответил — подключи заново."
            : "Один раз для этого браузера: Chrome спросит, можно ли открыть VS Code.",
          action: {
            label: "Подключить",
            onClick: () => {
              connect().then((ok) => {
                if (ok) send(paths, true);
              });
            },
          },
        });
        return;
      }
      await refresh();
      if (result.skipped.length) {
        toast.error(`Не в открытом проекте VS Code: ${result.skipped.length}`, {
          id,
          description: result.skipped.slice(0, 3).join("\n"),
        });
      } else if (result.failed.length) {
        toast.error(`Ошибки: ${result.failed.length}`, {
          id,
          description: result.failed.slice(0, 3).join("\n"),
        });
      } else {
        toast.success(`Загружено: ${result.sent.length}`, { id });
      }
    },
    [refresh, connect],
  );

  useEffect(() => {
    const isExternal = (e: DragEvent) => {
      const types = e.dataTransfer?.types ?? [];
      return types.includes("Files") || types.includes("codefiles");
    };
    const onEnter = (e: DragEvent) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!isExternal(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const dt = e.dataTransfer!;
      if (dt.types.includes("Files")) {
        upload(await collectDropped(dt));
        return;
      }
      const paths = vsCodePaths(dt);
      if (paths.length) sendFromVsCode(paths);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [upload, sendFromVsCode]);

  async function remove(path: string) {
    await fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    refresh();
  }

  async function removeAll() {
    if (!confirm("Удалить все файлы?")) return;
    await fetch("/api/files?all=1", { method: "DELETE" });
    refresh();
  }

  async function copyPath(path: string) {
    try {
      await copyText(path);
      toast.success("Путь скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Exchanger</h1>
          <p className="text-sm text-muted-foreground">
            Положил — забрал. Из VS Code перетаскивай прямо сюда или ПКМ → «Exchanger: Send»,
            обратно — команда «Exchanger: Pull».
          </p>
        </div>
        <div className="flex items-center gap-2">
          {paired ? (
            <Button variant="ghost" title="Подключить заново" onClick={() => connect()}>
              <PlugZapIcon className="text-green-600 dark:text-green-500" /> VS Code подключён
            </Button>
          ) : (
            <Button variant="outline" onClick={() => connect()}>
              <PlugIcon /> Подключить VS Code
            </Button>
          )}
          <Button variant="destructive" onClick={removeAll} disabled={!files?.length}>
            <Trash2Icon /> Очистить всё
          </Button>
        </div>
      </header>

      <div
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-muted" : "border-border"
        }`}
      >
        <UploadIcon className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Перетащи файлы или папки из VS Code или проводника в любое место страницы
        </p>
        <div className="flex w-full max-w-md flex-wrap items-center justify-center gap-2">
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="Папка назначения, например src/utils (необязательно)"
            className="flex-1 font-mono text-xs"
          />
          <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? "Загрузка…" : "Выбрать файлы"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              upload(picked.map((file) => ({ path: file.name, file })));
            }}
          />
        </div>
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Файл</TableHead>
              <TableHead>Путь</TableHead>
              <TableHead className="text-right">Размер</TableHead>
              <TableHead className="text-right">Когда</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {files === null ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  Загрузка…
                </TableCell>
              </TableRow>
            ) : files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  Пусто
                </TableCell>
              </TableRow>
            ) : (
              files.map((f) => (
                <TableRow
                  key={f.path}
                  draggable
                  onDragStart={(e) => {
                    // Chrome: можно вытащить файл прямо в проводник Windows.
                    const url = new URL(rawUrl(f.path), location.origin).toString();
                    e.dataTransfer.setData("DownloadURL", `application/octet-stream:${f.name}:${url}`);
                    // Для расширения VS Code (vscode-extension/drop-in.js). Без text/plain —
                    // иначе встроенная вставка текста в редакторе перебьёт наш обработчик.
                    e.dataTransfer.setData(
                      EXCHANGER_MIME,
                      JSON.stringify({ server: location.origin, files: [{ path: f.path }] }),
                    );
                  }}
                >
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {dirOf(f.path) || "/"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatSize(f.size)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatAgo(f.mtime)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Копировать путь"
                        onClick={() => copyPath(f.path)}
                      >
                        <CopyIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Скачать"
                        nativeButton={false}
                        render={<a href={rawUrl(f.path)} download={f.name} />}
                      >
                        <DownloadIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Удалить"
                        onClick={() => remove(f.path)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ExtensionInstall />
    </div>
  );
}
