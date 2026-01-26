const vscode = require('vscode');
const os = require('os');
const path = require('path');

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : '';
}

function resolvePathLike(p) {
  let out = p;

  const folders = vscode.workspace.workspaceFolders;
  const ws = folders && folders.length ? folders[0].uri.fsPath : '';

  if (ws) out = out.replace(/\$\{workspaceFolder\}/g, ws);

  if (out.startsWith('~/')) out = path.join(os.homedir(), out.slice(2));

  if (!path.isAbsolute(out)) {
    if (ws) out = path.join(ws, out);
    else out = path.resolve(out);
  }

  return out;
}

function resolveWorkspacePathForTool(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return '';

  const full = path.isAbsolute(raw) ? raw : path.join(wsRoot, raw);
  const rel = path.relative(wsRoot, full);
  if (rel.startsWith('..') || rel.includes(`..${path.sep}`)) return '';
  return full;
}

function toWorkspaceRelativePath(fullPath) {
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return fullPath;
  if (fullPath.startsWith(wsRoot)) {
    return path.relative(wsRoot, fullPath).replace(/\\/g, '/');
  }
  return fullPath;
}

module.exports = {
  getWorkspaceRoot,
  resolvePathLike,
  resolveWorkspacePathForTool,
  toWorkspaceRelativePath
};
