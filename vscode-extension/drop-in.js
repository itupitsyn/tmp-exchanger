// @ts-check
// Перетаскивание из веб-интерфейса в VS Code.
// Строка таблицы на странице несёт свой тип данных MIME = { server, files: [{ path }] }.
// Принимаем его в двух местах: в редакторе (Shift + отпустить) и в панели «Exchanger» в Explorer.
// Файлы скачиваются с настроенного сервера и кладутся в проект по своим относительным путям.
const vscode = require("vscode");

const MIME = "application/vnd.exchanger.file+json";
const VIEW_ID = "exchanger.files";
const REFRESH_MS = 5000;

/** @typedef {{ path: string, name: string, size: number, mtime: string }} StoredFile */
/**
 * @typedef {{
 *   api: (endpoint: string, params: Record<string, string>, init?: RequestInit) => Promise<Response>,
 *   serverUrl: () => string,
 *   pullFiles: (root: vscode.Uri, files: { path: string }[]) => Promise<void>,
 *   formatSize: (bytes: number) => string,
 * }} Deps
 */

/**
 * @param {Deps} deps
 * @returns {vscode.Disposable[]}
 */
function registerDropIn({ api, serverUrl, pullFiles, formatSize }) {
  const out = vscode.window.createOutputChannel("Exchanger");

  /** Список типов в DataTransfer — для диагностики, что вообще пришло из браузера. */
  function logTypes(/** @type {string} */ where, /** @type {vscode.DataTransfer} */ dt) {
    const types = [];
    dt.forEach((_item, mime) => types.push(mime));
    out.appendLine(`[${new Date().toLocaleTimeString()}] drop в ${where}: ${types.join(", ") || "(пусто)"}`);
  }

  /**
   * Достаёт файлы из перетащенных данных. Принимаем только со своего сервера:
   * иначе посторонняя страница могла бы подсунуть файл (например, .vscode/tasks.json) в проект.
   * @returns {Promise<{ path: string }[] | null>}
   */
  async function readPayload(/** @type {vscode.DataTransfer} */ dt) {
    const item = dt.get(MIME);
    if (!item) return null;
    let payload;
    try {
      payload = JSON.parse(await item.asString());
    } catch {
      out.appendLine("  не удалось разобрать данные");
      return null;
    }
    let expected, got;
    try {
      expected = new URL(serverUrl()).origin;
      got = new URL(String(payload?.server)).origin;
    } catch {
      return null;
    }
    if (expected !== got) {
      out.appendLine(`  отклонено: сервер ${got}, в настройках ${expected}`);
      vscode.window.showErrorMessage(
        `Exchanger: файл с сервера ${got}, а в настройках ${expected}. Перетащи на ту страницу любой файл из VS Code — расширение предложит к ней подключиться.`,
      );
      return null;
    }
    const files = Array.isArray(payload.files)
      ? payload.files.filter((/** @type {any} */ f) => typeof f?.path === "string").map((/** @type {any} */ f) => ({ path: f.path }))
      : [];
    out.appendLine(`  файлы: ${files.map((f) => f.path).join(", ")}`);
    return files.length ? files : null;
  }

  async function rootFor(/** @type {vscode.Uri | undefined} */ uri) {
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) return folders[0].uri;
    if (!folders.length) {
      vscode.window.showWarningMessage("Exchanger: открой папку проекта, чтобы забирать файлы");
      return undefined;
    }
    return (await vscode.window.showWorkspaceFolderPick({ placeHolder: "В какой проект положить файлы?" }))?.uri;
  }

  // 1. Drop в редактор. VS Code требует держать Shift, иначе в редактор не бросить.
  const kind = vscode.DocumentDropOrPasteEditKind.Empty.append("exchanger");
  const dropProvider = vscode.languages.registerDocumentDropEditProvider(
    [{ scheme: "file" }, { scheme: "untitled" }],
    {
      async provideDocumentDropEdits(document, _position, dataTransfer) {
        logTypes("редактор", dataTransfer);
        const files = await readPayload(dataTransfer);
        if (!files) return undefined;
        const root = await rootFor(document.uri);
        if (!root) return undefined;
        // В сам документ ничего не вставляем — файл ляжет по своему пути в проект.
        setTimeout(() => pullFiles(root, files), 0);
        return new vscode.DocumentDropEdit("", "Exchanger: положить в проект", kind);
      },
    },
    { dropMimeTypes: [MIME], providedDropEditKinds: [kind] },
  );

  // 2. Панель «Exchanger» в Explorer: список файлов на сервере, в неё можно бросать без Shift.
  const changed = new vscode.EventEmitter();
  /** @type {StoredFile[]} */
  let files = [];
  /** @type {string | null} */
  let error = null;

  async function load() {
    try {
      files = (await (await api("files", {})).json()).files;
      error = null;
    } catch (e) {
      files = [];
      error = e instanceof Error ? e.message : String(e);
    }
    changed.fire(undefined);
  }

  /** @type {vscode.TreeDataProvider<StoredFile | { error: string }>} */
  const treeData = {
    onDidChangeTreeData: changed.event,
    getChildren: async (element) => {
      if (element) return [];
      return error ? [{ error }] : files;
    },
    getTreeItem: (f) => {
      if ("error" in f) {
        const item = new vscode.TreeItem("Сервер недоступен");
        item.description = f.error;
        item.iconPath = new vscode.ThemeIcon("warning");
        return item;
      }
      const item = new vscode.TreeItem(f.name);
      const dir = f.path.slice(0, -f.name.length);
      item.description = dir || "/";
      item.tooltip = `${f.path}\n${formatSize(f.size)} · ${new Date(f.mtime).toLocaleString()}\nКлик — забрать в проект`;
      // resourceUri даёт иконку по расширению файла из текущей темы иконок.
      item.resourceUri = vscode.Uri.parse(`exchanger:/${f.path}`);
      item.contextValue = "exchangerFile";
      item.command = { command: "exchanger.pullFile", title: "Забрать", arguments: [f] };
      return item;
    },
  };

  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeData,
    canSelectMany: true,
    dragAndDropController: {
      dropMimeTypes: [MIME, "text/uri-list", "text/plain"],
      dragMimeTypes: [],
      async handleDrop(_target, dataTransfer) {
        logTypes("панель Exchanger", dataTransfer);
        const dropped = await readPayload(dataTransfer);
        if (!dropped) return;
        const root = await rootFor(undefined);
        if (root) await pullFiles(root, dropped);
      },
    },
  });

  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  const syncTimer = () => {
    clearInterval(timer);
    timer = undefined;
    if (view.visible) {
      load();
      timer = setInterval(load, REFRESH_MS);
    }
  };
  syncTimer();

  return [
    out,
    dropProvider,
    changed,
    view,
    view.onDidChangeVisibility(syncTimer),
    new vscode.Disposable(() => clearInterval(timer)),
    vscode.commands.registerCommand("exchanger.refreshFiles", load),
    vscode.commands.registerCommand("exchanger.pullAll", async () => {
      await load();
      if (error) {
        vscode.window.showErrorMessage(`Exchanger: ${error}`);
        return;
      }
      if (!files.length) {
        vscode.window.showInformationMessage("Exchanger: на сервере пусто");
        return;
      }
      const root = await rootFor(undefined);
      if (root) await pullFiles(root, files);
    }),
    vscode.commands.registerCommand(
      "exchanger.pullFile",
      async (/** @type {StoredFile} */ file, /** @type {StoredFile[] | undefined} */ selected) => {
        const picked = selected?.length ? selected : file ? [file] : [...view.selection].filter((f) => !("error" in f));
        if (!picked.length) return;
        const root = await rootFor(undefined);
        if (root) await pullFiles(root, /** @type {StoredFile[]} */ (picked));
      },
    ),
  ];
}

module.exports = { registerDropIn };
