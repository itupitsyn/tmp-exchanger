/** Кусок меньше 100 МБ — лимита Cloudflare и типичных прокси, и быстрее их таймаутов. */
export const CHUNK_SIZE = 32 * 1024 * 1024;
const RETRIES = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function uploadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Загружает файл кусками с повторами. onProgress — доля от 0 до 1.
 * После обрыва сервер говорит, сколько уже принял, и загрузка продолжается с этого места.
 */
export async function uploadChunked(
  path: string,
  file: Blob,
  onProgress: (fraction: number) => void,
) {
  const id = uploadId();
  const total = file.size;
  let offset = 0;
  let attempt = 0;

  for (;;) {
    try {
      // Хотя бы один кусок (пустой для пустого файла), чтобы на сервере появилась заготовка.
      if (offset < total || offset === 0) {
        const res = await fetch(`/api/files/chunk?upload=${id}&offset=${offset}`, {
          method: "PUT",
          body: file.slice(offset, offset + CHUNK_SIZE),
        });
        if (res.status === 409) {
          offset = (await res.json()).size;
          continue;
        }
        if (!res.ok) throw new HttpError(res.status);
        offset = (await res.json()).size;
        attempt = 0;
        onProgress(total ? offset / total : 1);
        if (offset < total) continue;
      }

      const res = await fetch(
        `/api/files/chunk?upload=${id}&path=${encodeURIComponent(path)}&total=${total}`,
        { method: "POST" },
      );
      if (res.status === 409) {
        offset = (await res.json()).size;
        continue;
      }
      if (!res.ok) throw new HttpError(res.status);
      return;
    } catch (e) {
      // 4xx (кроме 409) повтором не лечится.
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw e;
      if (++attempt > RETRIES) throw e;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
