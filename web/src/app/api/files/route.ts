import { connection, type NextRequest } from "next/server";
import { deleteAll, deleteFile, listFiles, normalizeRelPath, saveFile } from "@/lib/storage";
import { deny } from "@/lib/auth";

function badPath() {
  return Response.json({ error: "invalid path" }, { status: 400 });
}

export async function GET(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  await connection();
  return Response.json({ files: await listFiles() });
}

/** PUT /api/files?path=src/foo.ts — тело запроса = содержимое файла. */
export async function PUT(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  const relPath = normalizeRelPath(request.nextUrl.searchParams.get("path"));
  if (!relPath) return badPath();
  try {
    await saveFile(relPath, request.body);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 409 });
  }
  return Response.json({ path: relPath });
}

/** DELETE /api/files?path=src/foo.ts или DELETE /api/files?all=1 */
export async function DELETE(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  if (params.get("all") === "1") {
    await deleteAll();
    return Response.json({ ok: true });
  }
  const relPath = normalizeRelPath(params.get("path"));
  if (!relPath) return badPath();
  await deleteFile(relPath);
  return Response.json({ ok: true });
}
