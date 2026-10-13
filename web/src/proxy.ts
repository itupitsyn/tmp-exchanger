import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth";

// Только страницы: без входа отправляем на /login. API проверяет авторизацию само (lib/auth deny) —
// через proxy его не пускаем, иначе тело запроса буферизуется и большие файлы обрезаются.
export function proxy(request: NextRequest) {
  if (isAuthorized(request)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!api|login|_next/static|_next/image|favicon.ico).*)"],
};
