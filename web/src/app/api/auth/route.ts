import type { NextRequest } from "next/server";
import { AUTH_COOKIE, authEnabled, checkPassword, deny, sessionKey } from "@/lib/auth";

const YEAR_S = 365 * 24 * 60 * 60;
const FAIL_DELAY_MS = 1000;

/** GET /api/auth — ключ для расширения VS Code: страница передаёт его при подключении. */
export async function GET(request: NextRequest) {
  const denied = deny(request);
  if (denied) return denied;
  return Response.json({ key: authEnabled() ? sessionKey() : null });
}

/** POST /api/auth { password } — вход: ставит cookie. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (authEnabled() && !checkPassword(body?.password)) {
    // Притормаживаем перебор.
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  const response = Response.json({ ok: true });
  if (authEnabled()) {
    const secure = request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:";
    response.headers.append(
      "Set-Cookie",
      `${AUTH_COOKIE}=${sessionKey()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR_S}${secure ? "; Secure" : ""}`,
    );
  }
  return response;
}

/** DELETE /api/auth — выход. */
export async function DELETE() {
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } },
  );
}
