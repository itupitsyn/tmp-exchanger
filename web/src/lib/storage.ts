import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const STORAGE_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? path.join(process.cwd(), "storage"),
);
const FILES_DIR = path.join(STORAGE_DIR, "files");
const TMP_DIR = path.join(STORAGE_DIR, "tmp");

export type StoredFile = {
  path: string;
  name: string;
  size: number;
  mtime: string;
};

/**
 * Приводит пришедший путь к виду "src/foo/bar.ts".
 * Возвращает null, если путь пустой или пытается выйти за пределы хранилища.
 */
export function normalizeRelPath(input: string | null): string | null {
  if (!input) return null;
  const parts = input.replace(/\\/g, "/").split("/");
  const clean: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === ".." || part.includes(":") || part.includes("\0")) return null;
    clean.push(part);
  }
  return clean.length ? clean.join("/") : null;
}

function absPath(relPath: string) {
  const abs = path.join(FILES_DIR, ...relPath.split("/"));
  if (!abs.startsWith(FILES_DIR + path.sep)) throw new Error("bad path");
  return abs;
}

export async function listFiles(): Promise<StoredFile[]> {
  let entries;
  try {
    entries = await fs.readdir(FILES_DIR, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const files = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const abs = path.join(e.parentPath, e.name);
        const stat = await fs.stat(abs);
        const rel = path.relative(FILES_DIR, abs).split(path.sep).join("/");
        return { path: rel, name: e.name, size: stat.size, mtime: stat.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path));
}

export async function saveFile(relPath: string, body: ReadableStream<Uint8Array> | null) {
  const target = absPath(relPath);
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Пишем во временный файл и переименовываем, чтобы никто не скачал недописанное.
  const tmp = path.join(TMP_DIR, randomUUID());
  try {
    const source = body
      ? Readable.fromWeb(body as import("node:stream/web").ReadableStream)
      : Readable.from([]);
    await pipeline(source, createWriteStream(tmp));
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// Загрузка кусками: большие файлы через прокси одним запросом не пролезают (таймауты, лимиты).
// Куски дописываются в tmp/up-<id>, в конце файл переименовывается на своё место.

const UPLOAD_ID = /^[a-f0-9]{16,64}$/;
/** Брошенные недогрузки старше суток удаляем. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Кусок пришёл не с того места: клиент должен продолжить с size. */
export class OffsetMismatch extends Error {
  constructor(readonly size: number) {
    super(`offset mismatch, have ${size}`);
  }
}

function uploadTmp(id: string) {
  if (!UPLOAD_ID.test(id)) throw new Error("bad upload id");
  return path.join(TMP_DIR, `up-${id}`);
}

async function tmpSize(tmp: string) {
  return fs.stat(tmp).then(
    (s) => s.size,
    () => 0,
  );
}

async function pruneStaleUploads() {
  const names = await fs.readdir(TMP_DIR).catch(() => []);
  const now = Date.now();
  await Promise.all(
    names
      .filter((n) => n.startsWith("up-"))
      .map(async (n) => {
        const p = path.join(TMP_DIR, n);
        const stat = await fs.stat(p).catch(() => null);
        if (stat && now - stat.mtimeMs > STALE_UPLOAD_MS) await fs.rm(p, { force: true });
      }),
  );
}

/** Дописывает кусок с позиции offset. Возвращает, сколько байт уже принято. */
export async function appendChunk(id: string, offset: number, body: ReadableStream<Uint8Array> | null) {
  const tmp = uploadTmp(id);
  await fs.mkdir(TMP_DIR, { recursive: true });
  if (offset === 0) await pruneStaleUploads();
  const size = await tmpSize(tmp);
  if (offset > size) throw new OffsetMismatch(size);
  // Повтор куска после обрыва: отрезаем недописанный хвост.
  if (offset < size) await fs.truncate(tmp, offset);
  const source = body
    ? Readable.fromWeb(body as import("node:stream/web").ReadableStream)
    : Readable.from([]);
  await pipeline(source, createWriteStream(tmp, { flags: "a" }));
  return tmpSize(tmp);
}

/** Все куски на месте — кладём файл по его пути. */
export async function finishUpload(id: string, relPath: string, total: number) {
  const tmp = uploadTmp(id);
  const size = await tmpSize(tmp);
  if (size !== total) throw new OffsetMismatch(size);
  const target = absPath(relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(tmp, target);
}

export async function openFile(relPath: string) {
  const abs = absPath(relPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
  return { size: stat.size, stream: Readable.toWeb(createReadStream(abs)) as ReadableStream };
}

export async function deleteFile(relPath: string) {
  const abs = absPath(relPath);
  await fs.rm(abs, { force: true });
  await pruneEmptyDirs(path.dirname(abs));
}

export async function deleteAll() {
  await fs.rm(FILES_DIR, { recursive: true, force: true });
}

async function pruneEmptyDirs(dir: string) {
  while (dir.startsWith(FILES_DIR + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
