import type { NextRequest } from "next/server";
import { appendChunk, finishUpload, normalizeRelPath, OffsetMismatch } from "@/lib/storage";
import { deny } from "@/lib/auth";

function failed(e: unknown) {
  if (e instanceof OffsetMismatch) {
    return Response.json({ error: "offset mismatch", size: e.size }, { status: 409 });
  }
  return Response.json({ error: String(e) }, { status: 400 });
}

/** PUT /api/files/chunk?upload=<id>&offset=N — тело = очередной кусок. Ответ { size } — сколько принято. */
export async function PUT(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const offset = Number(params.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "bad offset" }, { status: 400 });
  }
  try {
    return Response.json({ size: await appendChunk(params.get("upload") ?? "", offset, request.body) });
  } catch (e) {
    return failed(e);
  }
}

/** POST /api/files/chunk?upload=<id>&path=src/a.bin&total=N — все куски отправлены, кладём файл. */
export async function POST(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const relPath = normalizeRelPath(params.get("path"));
  const total = Number(params.get("total"));
  if (!relPath) return Response.json({ error: "invalid path" }, { status: 400 });
  if (!Number.isSafeInteger(total) || total < 0) {
    return Response.json({ error: "bad total" }, { status: 400 });
  }
  try {
    await finishUpload(params.get("upload") ?? "", relPath, total);
  } catch (e) {
    return failed(e);
  }
  return Response.json({ path: relPath });
}
