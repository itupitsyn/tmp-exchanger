// @ts-check
const vscode = require("vscode");
const { startRelay } = require("./relay");
const { registerDropIn } = require("./drop-in");

/** @typedef {{ path: string, name: string, size: number, mtime: string }} StoredFile */

const FOLDER_CONFIRM_THRESHOLD = 200;

function config() {
  return vscode.workspace.getConfiguration("exchanger");
}

function serverUrl() {
  return String(config().get("serverUrl") || "http://localhost:3000").replace(/\/+$/, "");
}

/** @param {string} endpoint @param {Record<string, string>} [params] */
function apiUrl(endpoint, params = {}) {
  const url = new URL(`${serverUrl()}/api/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** @param {string} endpoint @param {Record<string, string>} params @param {RequestInit} [init] */
async function api(endpoint, params, init) {
  let res;
  try {
    res = await fetch(apiUrl(endpoint, params), init);
  } catch (e) {
    throw new Error(`Сервер ${serverUrl()} недоступен: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

/** Путь файла относительно корня его workspace-папки, всегда через "/". */
function relativePath(/** @type {vscode.Uri} */ uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return uri.path.split("/").pop() || "file";
  return uri.path.slice(folder.uri.path.replace(/\/+$/, "").length + 1);
}

function formatSize(/** @type {number} */ bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Разворачивает выбранные файлы и папки в плоский список файлов. */
async function expandToFiles(/** @type {vscode.Uri[]} */ uris) {
  /** @type {Map<string, vscode.Uri>} */
  const files = new Map();
  for (const uri of uris) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      // findFiles учитывает files.exclude (а значит .git и т.п.).
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, "**/*"),
        "**/node_modules/**",
      );
      for (const f of found) files.set(f.toString(), f);
    } else {
      files.set(uri.toString(), uri);
    }
  }
  return [...files.values()];
}

/** Содержимое файла; для открытого несохранённого документа — текущий текст из редактора. */
async function readContent(/** @type {vscode.Uri} */ uri) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc?.isDirty) return new TextEncoder().encode(doc.getText());
  return vscode.workspace.fs.readFile(uri);
}

/**
 * Отправляет файлы и папки на сервер, показывая прогресс.
 * @param {vscode.Uri[]} targets
 * @param {{ confirmLarge?: boolean }} [opts]
 * @returns {Promise<{ sent: string[], failed: string[] }>}
 */
async function uploadUris(targets, { confirmLarge = true } = {}) {
  /** @type {string[]} */
  const sent = [];
  /** @type {string[]} */
  const failed = [];

  const files = await expandToFiles(targets);
  if (!files.length) {
    vscode.window.showWarningMessage("Exchanger: в выбранных папках нет файлов");
    return { sent, failed };
  }
  if (confirmLarge && files.length > FOLDER_CONFIRM_THRESHOLD) {
    const ok = await vscode.window.showWarningMessage(
      `Exchanger: отправить ${files.length} файлов?`,
      { modal: true },
      "Отправить",
    );
    if (!ok) return { sent, failed };
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Exchanger: отправка", cancellable: true },
    async (progress, token) => {
      for (const [i, uri] of files.entries()) {
        if (token.isCancellationRequested) break;
        const rel = relativePath(uri);
        progress.report({ message: rel, increment: 100 / files.length });
        try {
          await api("files", { path: rel }, { method: "PUT", body: await readContent(uri) });
          sent.push(rel);
        } catch (e) {
          failed.push(`${rel}: ${e instanceof Error ? e.message : e}`);
          if (i === 0 && String(e).includes("недоступен")) break;
        }
      }
    },
  );

  if (failed.length) {
    vscode.window.showErrorMessage(`Exchanger: ошибки (${failed.length}): ${failed.slice(0, 3).join("; ")}`);
  } else if (sent.length) {
    const what = sent.length === 1 ? sent[0] : `файлов: ${sent.length}`;
    vscode.window.setStatusBarMessage(`$(check) Exchanger: отправлено ${what}`, 4000);
  }
  return { sent, failed };
}

/**
 * @param {vscode.Uri | undefined} clicked
 * @param {vscode.Uri[] | undefined} selected
 */
async function send(clicked, selected) {
  /** @type {vscode.Uri[]} */
  let targets = selected?.length ? selected : clicked ? [clicked] : [];
  if (!targets.length) {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === "file") targets = [active];
  }
  if (!targets.length) {
    vscode.window.showWarningMessage("Exchanger: не выбрано ни одного файла");
    return;
  }
  await uploadUris(targets);
}

/** Куда класть скачанное: кликнутая папка или корень workspace. */
async function pickTargetRoot(/** @type {vscode.Uri | undefined} */ clicked) {
  if (clicked) return clicked;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri;
  if (!folders.length) {
    vscode.window.showWarningMessage("Exchanger: открой папку проекта, чтобы забирать файлы");
    return undefined;
  }
  return (await vscode.window.showWorkspaceFolderPick({ placeHolder: "В какой проект положить файлы?" }))?.uri;
}

async function exists(/** @type {vscode.Uri} */ uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function pull(/** @type {vscode.Uri | undefined} */ clicked) {
  /** @type {StoredFile[]} */
  let list;
  try {
    list = (await (await api("files", {})).json()).files;
  } catch (e) {
    vscode.window.showErrorMessage(`Exchanger: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (!list.length) {
    vscode.window.showInformationMessage("Exchanger: на сервере пусто");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    list.map((f) => ({
      label: f.path,
      description: `${formatSize(f.size)} · ${new Date(f.mtime).toLocaleString()}`,
      file: f,
    })),
    { canPickMany: true, placeHolder: "Какие файлы забрать?", matchOnDescription: true },
  );
  if (!picked?.length) return;

  const root = await pickTargetRoot(clicked);
  if (!root) return;
  await pullFiles(root, picked.map(({ file }) => file));
}

/** Путь с сервера, безопасный для записи внутрь проекта (без "..", абсолютных путей и дисков). */
function safeSegments(/** @type {string} */ relPath) {
  const parts = relPath.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.includes(":") || p.includes("\\"))) return null;
  return parts;
}

/**
 * Скачивает файлы с сервера и кладёт их в root по относительным путям.
 * @param {vscode.Uri} root
 * @param {{ path: string }[]} files
 */
async function pullFiles(root, files) {
  /** @type {{ file: { path: string }, target: vscode.Uri }[]} */
  const items = [];
  for (const file of files) {
    const parts = safeSegments(file.path);
    if (parts) items.push({ file, target: vscode.Uri.joinPath(root, ...parts) });
    else vscode.window.showErrorMessage(`Exchanger: недопустимый путь ${file.path}`);
  }
  if (!items.length) return;

  const conflicts = [];
  for (const item of items) if (await exists(item.target)) conflicts.push(item);
  let toWrite = items;
  if (conflicts.length) {
    const answer = await vscode.window.showWarningMessage(
      `Exchanger: уже существует ${conflicts.length} из ${items.length}: ${conflicts
        .slice(0, 5)
        .map((c) => c.file.path)
        .join(", ")}${conflicts.length > 5 ? "…" : ""}`,
      { modal: true },
      "Перезаписать",
      "Пропустить существующие",
    );
    if (!answer) return;
    if (answer !== "Перезаписать") toWrite = items.filter((i) => !conflicts.includes(i));
  }

  const deleteAfter = Boolean(config().get("deleteAfterPull"));
  /** @type {string[]} */
  const failed = [];
  /** @type {vscode.Uri[]} */
  const written = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Exchanger: загрузка" },
    async (progress) => {
      for (const { file, target } of toWrite) {
        progress.report({ message: file.path, increment: 100 / toWrite.length });
        try {
          const res = await api("files/raw", { path: file.path });
          const data = new Uint8Array(await res.arrayBuffer());
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
          await vscode.workspace.fs.writeFile(target, data);
          written.push(target);
          if (deleteAfter) await api("files", { path: file.path }, { method: "DELETE" });
        } catch (e) {
          failed.push(`${file.path}: ${e instanceof Error ? e.message : e}`);
        }
      }
    },
  );

  if (failed.length) {
    vscode.window.showErrorMessage(`Exchanger: ошибки (${failed.length}): ${failed.slice(0, 3).join("; ")}`);
  }
  if (written.length === 1) {
    await vscode.commands.executeCommand("vscode.open", written[0]);
  } else if (written.length) {
    vscode.window.setStatusBarMessage(`$(check) Exchanger: получено файлов: ${written.length}`, 4000);
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("exchanger.send", (uri, uris) =>
      send(uri instanceof vscode.Uri ? uri : undefined, Array.isArray(uris) ? uris : undefined),
    ),
    vscode.commands.registerCommand("exchanger.pull", (uri) =>
      pull(uri instanceof vscode.Uri ? uri : undefined),
    ),
    vscode.commands.registerCommand("exchanger.openWeb", () =>
      vscode.env.openExternal(vscode.Uri.parse(serverUrl())),
    ),
    ...startRelay(context, { api, uploadUris }),
    ...registerDropIn({ api, serverUrl, pullFiles, formatSize }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
