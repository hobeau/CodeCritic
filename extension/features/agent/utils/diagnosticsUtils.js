const path = require('path');
const { toWorkspaceRelativePath } = require('../../../helpers/workspace');

function normalizeContextPath(filePath, workspaceRoot) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  let rel = raw;
  if (workspaceRoot) {
    if (path.isAbsolute(rel)) {
      rel = path.relative(workspaceRoot, rel);
    }
  } else if (path.isAbsolute(rel)) {
    rel = toWorkspaceRelativePath(rel);
  }
  rel = rel.replace(/\\/g, '/').replace(/^\.?\//, '');
  return rel;
}

function getContextFilePathSet(context) {
  const chatState = context?.getChatState ? context.getChatState() : context?.chatState;
  const contexts = Array.isArray(chatState?.contexts) ? chatState.contexts : [];
  const workspaceRoot = context?.deps?.getWorkspaceRoot ? context.deps.getWorkspaceRoot() : '';
  const paths = new Set();

  for (const ctx of contexts) {
    const rel = normalizeContextPath(ctx?.filePath, workspaceRoot);
    if (rel) {
      paths.add(rel.toLowerCase());
    }
  }

  const requested = Array.isArray(context?.requestedFilePaths) ? context.requestedFilePaths : [];
  for (const req of requested) {
    const rel = normalizeContextPath(req, workspaceRoot);
    if (rel) {
      paths.add(rel.toLowerCase());
    }
  }

  return paths;
}

function extractProblemPath(problemText) {
  const text = String(problemText || '').trim();
  const match = text.match(/^\s*-\s*([^:]+):\d+:\d+\s/);
  if (!match) return '';
  return match[1].replace(/\\/g, '/').replace(/^\.?\//, '');
}

function filterProblemsByContext(problems, context) {
  const list = Array.isArray(problems) ? problems : [];
  const contextPaths = getContextFilePathSet(context);
  if (!contextPaths.size) return [];

  const contextBasenames = new Set();
  for (const p of contextPaths) {
    const base = path.basename(p);
    if (base) contextBasenames.add(base.toLowerCase());
  }

  return list.filter((problem) => {
    const problemPath = extractProblemPath(problem);
    if (!problemPath) return false;
    const normalized = problemPath.toLowerCase();
    if (contextPaths.has(normalized)) return true;
    const base = path.basename(normalized);
    if (contextBasenames.has(base)) return true;
    for (const ctx of contextPaths) {
      if (normalized.endsWith(`/${ctx}`)) return true;
      if (ctx.endsWith(`/${normalized}`)) return true;
    }
    return false;
  });
}

module.exports = {
  filterProblemsByContext,
  getContextFilePathSet
};
