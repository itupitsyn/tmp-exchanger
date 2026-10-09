import type { NextRequest } from "next/server";
import { getPair, setPair } from "@/lib/relay";

/** POST /api/relay/pair { pairId, client } — расширение сообщает свой id после vscode:// ссылки. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const { pairId, client } = body ?? {};
  if (typeof pairId !== "string" || !pairId || typeof client !== "string" || !client) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  setPair(pairId, client);
  return Response.json({ ok: true });
}

/** GET /api/relay/pair?pairId=X — страница узнаёт id расширения на своей машине. */
export async function GET(request: NextRequest) {
  const pairId = request.nextUrl.searchParams.get("pairId");
  if (!pairId) return Response.json({ error: "pairId required" }, { status: 400 });
  return Response.json({ client: getPair(pairId) });
}
