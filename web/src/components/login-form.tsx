"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      router.replace("/");
      return;
    }
    setBusy(false);
    setError(res?.status === 401 ? "Неверный пароль" : "Сервер недоступен");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Exchanger</h1>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          autoComplete="current-password"
          autoFocus
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !password}>
          {busy && <LoaderCircleIcon className="animate-spin" />} Войти
        </Button>
      </form>
    </div>
  );
}
