// @ts-check
// Drag & drop из VS Code в веб-интерфейс.
// Браузер при перетаскивании из VS Code получает только пути, без содержимого.
// Страница кладёт пути на сервер (/api/relay), а расширение забирает их long-poll'ом,
// само читает файлы и загружает. Чтобы страница знала, какой машине адресовать запрос,
// при первом перетаскивании она открывает vscode://local.exchanger/pair?id=<pairId>,
// и расширение сообщает серверу свой clientId.
const vscode = require("vscode");
const { randomUUID } = require("node:crypto");

const CLIENT_ID_KEY = "exchanger.clientId";
const RETRY_MS = 5000;

/** @typedef {(targets: vscode.Uri[], opts?: { confirmLarge?: boolean }) => Promise<{ sent: string[], failed: string[] }>} UploadFn */
/** @typedef {(endpoint: string, params: Record<string, string>, init?: RequestInit) => Promise<Response>} ApiFn */

/** Один id на машину: globalState общий для всех окон VS Code. */
function getClientId(/** @type {vscode.ExtensionContext} */ context) {
  let id = context.globalState.get(CLIENT_ID_KEY);
  if (typeof id !== "string") {
    id = randomUUID();
    context.globalState.update(CLIENT_ID_KEY, id);
  }
  return id;
}

/** @param {unknown} p */
function toUri(p) {
  if (typeof p !== "string" || !p) return undefined;
  if (p.startsWith("file:")) return vscode.Uri.parse(p);
  return vscode.Uri.file(p);
}

/**
 * Отправляет файлы по путям, но только те, что лежат в открытом workspace этого окна:
 * так нельзя вытащить произвольный файл с диска, а каждое окно берёт только свои файлы.
 * @param {unknown} paths
 * @param {UploadFn} uploadUris
 */
async function sendFromPaths(paths, uploadUris) {
  const list = Array.isArray(paths) ? paths : [];
  /** @type {vscode.Uri[]} */
  const mine = [];
  /** @type {string[]} */
  const skipped = [];
  for (const p of list) {
    const uri = toUri(p);
    if (uri && vscode.workspace.getWorkspaceFolder(uri)) mine.push(uri);
    else skipped.push(String(p));
  }
  if (!mine.length) return { sent: [], failed: [], skipped };
  return { ...(await uploadUris(mine, { confirmLarge: false })), skipped };
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ api: ApiFn, uploadUris: UploadFn }} deps
 * @returns {vscode.Disposable[]}
 */
function startRelay(context, { api, uploadUris }) {
  const client = getClientId(context);
  let stopped = false;
  /** @type {AbortController | undefined} */
  let current;

  const post = (/** @type {string} */ endpoint, /** @type {unknown} */ body) =>
    api(endpoint, {}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /** @param {{ id: number, paths: string[] }} item */
  async function handle(item) {
    // Сразу подтверждаем получение: страница поймёт, что VS Code на связи, даже если загрузка долгая.
    await post("relay/result", { id: item.id, ack: true }).catch(() => {});
    const result = await sendFromPaths(item.paths, uploadUris);
    await post("relay/result", { id: item.id, ...result }).catch(() => {});
  }

  /** true — текущий long-poll прерван ради переподключения (сменился адрес сервера). */
  let restarting = false;
  /** Будит паузу между повторами, если адрес сервера сменился. */
  let wake = () => {};

  async function loop() {
    /** @type {number | null} */
    let after = null;
    while (!stopped) {
      try {
        current = new AbortController();
        const params = after === null ? { client } : { client, after: String(after) };
        const res = await api("relay", params, { signal: current.signal });
        const { items, last } = await res.json();
        after = last;
        for (const item of items) handle(item);
      } catch {
        if (stopped) return;
        after = null;
        if (restarting) restarting = false;
        else {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, RETRY_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(undefined);
            };
          });
          wake = () => {};
        }
      }
    }
  }
  loop();

  const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration("exchanger.serverUrl")) return;
    restarting = true;
    current?.abort();
    wake();
  });

  /**
   * Страница передаёт свой адрес, чтобы свежеустановленное расширение настроилось само.
   * Переключаемся только с подтверждения: иначе любой сайт мог бы увести запросы на свой сервер.
   * @returns {Promise<boolean>} можно ли знакомиться дальше
   */
  async function adoptServer(/** @type {string | null} */ server) {
    if (!server) return true;
    let url;
    try {
      url = new URL(server);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const config = vscode.workspace.getConfiguration("exchanger");
    const currentUrl = String(config.get("serverUrl") || "").replace(/\/+$/, "");
    if (url.origin === currentUrl) return true;

    const answer = await vscode.window.showWarningMessage(
      `Exchanger: подключиться к серверу ${url.origin}?`,
      { modal: true, detail: `Сейчас в настройках: ${currentUrl || "не задан"}` },
      "Подключить",
    );
    if (answer !== "Подключить") return false;
    await config.update("serverUrl", url.origin, vscode.ConfigurationTarget.Global);
    return true;
  }

  // vscode://local.exchanger/pair?id=<pairId>&server=<origin> — только знакомство; сами пути
  // страница потом шлёт через /api/relay, и их получат все окна VS Code на этой машине.
  const uriHandler = vscode.window.registerUriHandler({
    async handleUri(uri) {
      const query = new URLSearchParams(uri.query);
      const pairId = query.get("id");
      if (uri.path !== "/pair" || !pairId) return;
      if (!(await adoptServer(query.get("server")))) return;
      try {
        await post("relay/pair", { pairId, client });
      } catch (e) {
        vscode.window.showErrorMessage(`Exchanger: ${e instanceof Error ? e.message : e}`);
      }
    },
  });

  return [
    uriHandler,
    onConfig,
    new vscode.Disposable(() => {
      stopped = true;
      current?.abort();
    }),
  ];
}

module.exports = { startRelay };
