import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Один общий пароль из EXCHANGER_PASSWORD. Не задан — авторизации нет (локальная сеть, разработка).
// Браузер после входа носит cookie с ключом (хэш пароля, не сам пароль),
// расширение VS Code шлёт тот же ключ (или сам пароль) в Authorization: Bearer.

export const AUTH_COOKIE = "exchanger_auth";

function password() {
  return process.env.EXCHANGER_PASSWORD || "";
}

export function authEnabled() {
  return Boolean(password());
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Ключ, который получают браузер (cookie) и расширение (при подключении со страницы). */
export function sessionKey() {
  return sha256(`exchanger-auth:${password()}`).toString("hex");
}

/** Сравнение без утечки по времени; хэшируем, чтобы длины совпадали. */
function same(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function checkPassword(value: unknown) {
  return typeof value === "string" && same(value, password());
}

export function isAuthorized(request: NextRequest) {
  if (!authEnabled()) return true;
  const key = sessionKey();
  const cookie = request.cookies.get(AUTH_COOKIE)?.value;
  if (cookie && same(cookie, key)) return true;
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return Boolean(bearer && (same(bearer, key) || same(bearer, password())));
}

/** Для route handlers: ответ 401, если запрос не авторизован, иначе null. */
export function deny(request: NextRequest) {
  return isAuthorized(request) ? null : Response.json({ error: "unauthorized" }, { status: 401 });
}
