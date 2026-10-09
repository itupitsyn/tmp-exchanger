import os from "node:os";
import type { NextConfig } from "next";

// В dev-режиме Next блокирует запросы со страниц, открытых не через localhost.
// Разрешаем адреса этой машины, чтобы приложение работало по LAN (http://192.168.x.x:3000).
const lanHosts = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && !i.internal)
  .map((i) => (i!.family === "IPv6" ? `[${i!.address}]` : i!.address));

const nextConfig: NextConfig = {
  // Минимальная сборка для Docker: .next/standalone/server.js (см. Dockerfile).
  output: "standalone",
  // Пути в storage.ts строятся динамически, и трассировщик тащит в сборку хранилище и исходники.
  outputFileTracingExcludes: {
    "/**": ["./storage/**/*", "./src/**/*"],
  },
  allowedDevOrigins: [...lanHosts, os.hostname().toLowerCase()],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
