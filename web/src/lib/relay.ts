// Ретранслятор «страница → расширение VS Code».
// Страница кладёт сюда пути перетащенных файлов, расширение на нужной машине забирает их
// long-poll'ом, само читает файлы с диска и загружает через обычный API.
// Состояние в памяти процесса — для «положил-забрал» этого достаточно.
import { EventEmitter } from "node:events";

export type RelayRequest = { id: number; client: string; paths: string[]; t: number };
/** ack — окно VS Code получило запрос; финальный отчёт придёт отдельной записью. */
export type RelayResult = { sent: string[]; failed: string[]; skipped: string[]; ack?: boolean };

const TTL_MS = 60_000;

type State = {
  seq: number;
  requests: RelayRequest[];
  results: Map<number, RelayResult[]>;
  pairs: Map<string, { client: string; t: number }>;
  events: EventEmitter;
};

// globalThis, чтобы состояние переживало HMR в dev-режиме.
const g = globalThis as typeof globalThis & { __exchangerRelay?: State };
const state: State = (g.__exchangerRelay ??= {
  seq: 0,
  requests: [],
  results: new Map(),
  pairs: new Map(),
  events: new EventEmitter().setMaxListeners(0),
});

function prune() {
  const cutoff = Date.now() - TTL_MS;
  state.requests = state.requests.filter((r) => r.t > cutoff);
  for (const id of state.results.keys()) {
    if (!state.requests.some((r) => r.id === id)) state.results.delete(id);
  }
  for (const [k, v] of state.pairs) if (v.t <= cutoff) state.pairs.delete(k);
}

export function pushRequest(client: string, paths: string[]) {
  prune();
  const req = { id: ++state.seq, client, paths, t: Date.now() };
  state.requests.push(req);
  state.events.emit("request");
  return req.id;
}

/** Ждёт запросы для client с id > after, не дольше timeoutMs. */
export async function waitRequests(client: string, after: number, timeoutMs: number, signal: AbortSignal) {
  const pending = () => state.requests.filter((r) => r.client === client && r.id > after);
  // last — общий счётчик: расширение продолжит с него, а после перезапуска сервера
  // (счётчик обнулился) автоматически подстроится.
  if (after > state.seq) return { items: [], last: state.seq };
  let found = pending();
  if (found.length) return { items: found, last: state.seq };

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      state.events.off("request", onRequest);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onRequest = () => {
      if (pending().length) done();
    };
    const timer = setTimeout(done, timeoutMs);
    state.events.on("request", onRequest);
    signal.addEventListener("abort", done);
  });
  found = pending();
  return { items: found, last: state.seq };
}

/** Запросы для client моложе maxAgeMs. */
export function recentRequests(client: string, maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs;
  return state.requests.filter((r) => r.client === client && r.t > cutoff);
}

export function currentSeq() {
  return state.seq;
}

export function addResult(id: number, result: RelayResult) {
  if (!state.requests.some((r) => r.id === id)) return false;
  state.results.set(id, [...(state.results.get(id) ?? []), result]);
  return true;
}

export function getResults(id: number) {
  return state.results.get(id) ?? [];
}

export function setPair(pairId: string, client: string) {
  prune();
  state.pairs.set(pairId, { client, t: Date.now() });
}

export function getPair(pairId: string) {
  return state.pairs.get(pairId)?.client ?? null;
}
