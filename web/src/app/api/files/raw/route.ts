import type { NextRequest } from "next/server";
import { normalizeRelPath, openFile } from "@/lib/storage";

/** GET /api/files/raw?path=src/foo.ts — скачать файл. */
export async function GET(request: NextRequest) {
  const relPath = normalizeRelPath(request.nextUrl.searchParams.get("path"));
  if (!relPath) return Response.json({ error: "invalid path" }, { status: 400 });

  let file;
  try {
    file = await openFile(relPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    throw e;
  }

  const name = relPath.split("/").pop()!;
  return new Response(file.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
