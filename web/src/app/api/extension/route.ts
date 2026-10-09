import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { connection, type NextRequest } from "next/server";

// Где искать собранное расширение: в Docker — /app/extension, локально — соседняя папка.
const EXTENSION_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.EXTENSION_DIR ??
    path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "vscode-extension"),
);

/** Самый свежий exchanger-<версия>.vsix. */
async function findVsix() {
  let names: string[];
  try {
    names = await fs.readdir(EXTENSION_DIR);
  } catch {
    return null;
  }
  const versions = names
    .map((name) => ({ name, m: /^exchanger-(\d+)\.(\d+)\.(\d+)\.vsix$/.exec(name) }))
    .filter((v): v is { name: string; m: RegExpExecArray } => v.m !== null)
    .map(({ name, m }) => ({ name, version: m.slice(1).join("."), key: m.slice(1).map(Number) }))
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
  return versions[0] ?? null;
}

/** GET /api/extension — скачать .vsix; GET /api/extension?info=1 — { version } или 404. */
export async function GET(request: NextRequest) {
  await connection();
  const vsix = await findVsix();
  if (!vsix) return Response.json({ error: "extension not built" }, { status: 404 });

  if (request.nextUrl.searchParams.has("info")) return Response.json({ version: vsix.version });

  const file = path.join(EXTENSION_DIR, vsix.name);
  const stat = await fs.stat(file);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${vsix.name}"`,
      "Cache-Control": "no-store",
    },
  });
}
