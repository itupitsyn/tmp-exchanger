import type { NextRequest } from "next/server";
import { currentSeq, pushRequest, recentRequests, waitRequests } from "@/lib/relay";

const LONG_POLL_MS = 25_000;
/** Страница ждёт подтверждения 4 с — всё, что моложе, ещё имеет смысл доставить. */
const RECONNECT_GRACE_MS = 10_000;
const MAX_PATHS = 1000;

/** POST /api/relay { client, paths } — страница просит расширение отправить файлы. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const client = body?.client;
  const paths = body?.paths;
  if (
    typeof client !== "string" ||
    !client ||
    client.length > 100 ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > MAX_PATHS ||
    !paths.every((p) => typeof p === "string")
  ) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  return Response.json({ id: pushRequest(client, paths) });
}

/**
 * GET /api/relay?client=X&after=N — long-poll для расширения.
 * Без after (подключение/переподключение) сразу возвращает текущий номер и свежие запросы
 * за последние секунды — те, что страница успела отправить, пока расширение было не на связи.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const client = params.get("client");
  if (!client) return Response.json({ error: "client required" }, { status: 400 });

  const afterParam = params.get("after");
  if (afterParam === null) {
    return Response.json({ items: recentRequests(client, RECONNECT_GRACE_MS), last: currentSeq() });
  }

  const after = Number(afterParam);
  if (!Number.isFinite(after)) return Response.json({ error: "bad after" }, { status: 400 });
  return Response.json(await waitRequests(client, after, LONG_POLL_MS, request.signal));
}
