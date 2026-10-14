/** Копирует текст в буфер; navigator.clipboard есть только в secure context, поэтому есть запасной способ. */
export async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // http://192.168.x.x — старый способ через выделение текста.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const TEXT_EXT =
  /\.(txt|md|json|jsonc|ya?ml|toml|ini|env|csv|log|xml|html?|css|scss|less|[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|php|sh|ps1|bat|sql|graphql|svg)$/i;
/** Больше этого в буфер как текст не кладём. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Что из файла можно положить в буфер: картинку, текст или ничего. */
export function clipboardKind(name: string, size: number): "image" | "text" | null {
  if (IMAGE_EXT.test(name) && !/\.svg$/i.test(name)) return "image";
  if (TEXT_EXT.test(name) && size <= MAX_TEXT_BYTES) return "text";
  return null;
}

/** Браузер кладёт в буфер только PNG — остальное перекодируем. */
async function toPng(blob: Blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"),
  );
}

/**
 * Копирует содержимое файла с сервера в буфер. Вызывать из клика: ClipboardItem принимает
 * промис, поэтому жест не «протухает», пока файл качается.
 */
export async function copyFileContent(url: string, kind: "image" | "text") {
  const load = () =>
    fetch(url, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.blob();
    });
  if (kind === "image") {
    // Картинки в буфер — только в secure context (https или localhost).
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Копировать картинки браузер разрешает только по https");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": load().then(toPng) })]);
    return;
  }
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const text = load().then((b) => b.text()).then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
    return;
  }
  await copyText(await (await load()).text());
}

/** Читает буфер кнопкой (без Ctrl+V). Есть только в secure context; null — не вышло. */
export async function readClipboard(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null;
  for (const item of await navigator.clipboard.read()) {
    const image = item.types.find((t) => t.startsWith("image/"));
    if (image) return new File([await item.getType(image)], "image", { type: image });
    if (item.types.includes("text/plain")) {
      const text = await (await item.getType("text/plain")).text();
      if (text) return new File([text], "text", { type: "text/plain" });
    }
  }
  return null;
}
