import type { NextRequest } from "next/server";
import { addResult, getResults } from "@/lib/relay";

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** POST /api/relay/result { id, sent, failed, skipped } — отчёт окна VS Code. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const ok = addResult(id, {
    sent: strings(body.sent),
    failed: strings(body.failed),
    skipped: strings(body.skipped),
    ...(body.ack === true && { ack: true }),
  });
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}

/** GET /api/relay/result?id=N — отчёты всех окон VS Code по запросу. */
export async function GET(request: NextRequest) {
  const id = Number(request.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id)) return Response.json({ error: "bad id" }, { status: 400 });
  return Response.json({ results: getResults(id) });
}
