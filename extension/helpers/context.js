const vscode = require('vscode');
const path = require('path');
const { getWorkspaceRoot } = require('./workspace');

function getSurroundingContext(doc, range, contextLines) {
  const maxLine = Math.max(0, doc.lineCount - 1);
  const startLine = Math.max(0, range.start.line - contextLines);
  const endLine = Math.min(maxLine, range.end.line + contextLines);
  const startChar = 0;
  const endChar = doc.lineAt(endLine).text.length;
  const ctxRange = new vscode.Range(
    new vscode.Position(startLine, startChar),
    new vscode.Position(endLine, endChar)
  );
  return doc.getText(ctxRange);
}

function isMethodSymbol(sym) {
  if (!sym || typeof sym.kind !== 'number') return false;
  return (
    sym.kind === vscode.SymbolKind.Function ||
    sym.kind === vscode.SymbolKind.Method ||
    sym.kind === vscode.SymbolKind.Constructor
  );
}

function getSafeRange(doc, range) {
  const maxLine = Math.max(0, doc.lineCount - 1);
  const startLine = Math.min(Math.max(range.start.line, 0), maxLine);
  const endLine = Math.min(Math.max(range.end.line, startLine), maxLine);
  const startChar = Math.min(range.start.character, doc.lineAt(startLine).text.length);
  const endChar = doc.lineAt(endLine).text.length;
  return new vscode.Range(new vscode.Position(startLine, startChar), new vscode.Position(endLine, endChar));
}

function countLines(text) {
  return String(text || '').split(/\r?\n/).length;
}

function adjustSelectionForEdit(doc, selection, editRange, oldText, newText) {
  if (!selection) return selection;
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const lineDelta = newLines - oldLines;
  if (lineDelta === 0) return selection;

  let startLine = selection.start.line;
  let endLine = selection.end.line;

  if (editRange.end.line < startLine) {
    startLine += lineDelta;
    endLine += lineDelta;
  } else if (editRange.start.line <= endLine) {
    if (editRange.start.line < startLine) startLine += lineDelta;
    endLine += lineDelta;
  } else {
    return selection;
  }

  if (endLine < startLine) endLine = startLine;

  const maxLine = Math.max(0, doc.lineCount - 1);
  const safeStartLine = Math.min(Math.max(startLine, 0), maxLine);
  const safeEndLine = Math.min(Math.max(endLine, safeStartLine), maxLine);
  const safeStartChar = Math.min(selection.start.character, doc.lineAt(safeStartLine).text.length);
  const safeEndChar = Math.min(selection.end.character, doc.lineAt(safeEndLine).text.length);
  return new vscode.Selection(
    new vscode.Position(safeStartLine, safeStartChar),
    new vscode.Position(safeEndLine, safeEndChar)
  );
}

function updateSelectionContextsForEdit(threadContext, uri, doc, editRange, oldText, newText) {
  for (const [thread, ctx] of threadContext.entries()) {
    if (!ctx || !ctx.origin || ctx.origin.kind !== 'selection' || !ctx.origin.selection) continue;
    if (thread.uri && thread.uri.toString() !== uri.toString()) continue;

    const selection = ctx.origin.selection;
    const selectionRange = new vscode.Range(selection.start, selection.end);
    if (editRange.start.line > selectionRange.end.line) continue;

    const updatedSelection = adjustSelectionForEdit(doc, selection, editRange, oldText, newText);
    if (!updatedSelection) continue;

    ctx.origin = { ...ctx.origin, selection: updatedSelection };
    ctx.text = doc.getText(updatedSelection);
    threadContext.set(thread, ctx);
  }
}

function refreshSelectionContexts(threadContext, doc, uri) {
  for (const [thread, ctx] of threadContext.entries()) {
    if (!ctx || !ctx.origin || ctx.origin.kind !== 'selection' || !ctx.origin.selection) continue;
    if (!thread.uri || thread.uri.toString() !== uri.toString()) continue;
    ctx.text = doc.getText(ctx.origin.selection);
    threadContext.set(thread, ctx);
  }
}

async function buildMethodDependencyContext(doc, range, cfg) {
  const maxDepth = Math.max(0, Number(cfg.maxDependencyDepth || 0));
  const maxDeps = Math.max(0, Number(cfg.maxDependencies || 0));
  if (!maxDepth || !maxDeps) return '';

  const items = await collectOutgoingCallHierarchy(doc, range.start, maxDepth, maxDeps);
  if (!items.length) {
    return await collectLocalAndWorkspaceContext(doc, range, maxDeps);
  }

  const wsRoot = getWorkspaceRoot();
  const maxChars = vscode.workspace.getConfiguration('codeCritic').get('maxChars', 80000);
  const maxContextChars = Math.max(2000, Math.floor(maxChars * 0.6));

  let out = 'Additional context (dependent symbols):';
  for (const item of items) {
    let itemDoc;
    try {
      itemDoc = await vscode.workspace.openTextDocument(item.uri);
    } catch {
      continue;
    }
    const itemRange = getSafeRange(itemDoc, item.range);
    const code = itemDoc.getText(itemRange);
    const rel = wsRoot && item.uri.fsPath.startsWith(wsRoot)
      ? path.relative(wsRoot, item.uri.fsPath).replace(/\\/g, '/')
      : item.uri.fsPath;
    const block = `\n---\nFile: ${rel}\nSymbol: ${item.name}\nCode:\n${code}\n`;
    if (out.length + block.length > maxContextChars) {
      out += '\n...(truncated)...';
      break;
    }
    out += block;
  }

  return out;
}

async function collectLocalAndWorkspaceContext(doc, range, maxDeps) {
  const selectionText = doc.getText(range);
  const calledNames = extractCalledIdentifiers(selectionText);
  const referencedNames = extractReferencedIdentifiers(selectionText);

  if (!calledNames.size && !referencedNames.size) return '';

  const symbols = await collectDocumentSymbols(doc);
  if (!symbols.length) return '';

  const matches = [];
  const seen = new Set();
  const names = new Set([...calledNames, ...referencedNames]);

  for (const sym of symbols) {
    if (!sym.name) continue;
    const isMethod = isMethodSymbol(sym) && calledNames.has(sym.name);
    const isValue = isValueSymbol(sym) && referencedNames.has(sym.name);
    if (!isMethod && !isValue) continue;
    if (range.contains(sym.range)) continue;
    const key = `${doc.uri.toString()}#${sym.range.start.line}:${sym.range.start.character}-${sym.range.end.line}:${sym.range.end.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ uri: doc.uri, range: sym.range, name: sym.name });
    if (matches.length >= maxDeps) break;
  }

  if (matches.length < maxDeps) {
    const remaining = maxDeps - matches.length;
    const workspaceMatches = await collectWorkspaceDependencies(doc, range, names, remaining, seen);
    for (const item of workspaceMatches) {
      matches.push(item);
      if (matches.length >= maxDeps) break;
    }
  }

  if (!matches.length) return '';

  const wsRoot = getWorkspaceRoot();
  const maxChars = vscode.workspace.getConfiguration('codeCritic').get('maxChars', 80000);
  const maxContextChars = Math.max(2000, Math.floor(maxChars * 0.6));

  let out = 'Additional context (dependent symbols, local scan):';
  for (const item of matches) {
    let itemDoc;
    try {
      itemDoc = await vscode.workspace.openTextDocument(item.uri);
    } catch {
      continue;
    }
    const itemRange = getSafeRange(itemDoc, item.range);
    const code = itemDoc.getText(itemRange);
    const rel = wsRoot && item.uri.fsPath.startsWith(wsRoot)
      ? path.relative(wsRoot, item.uri.fsPath).replace(/\\/g, '/')
      : item.uri.fsPath;
    const block = `\n---\nFile: ${rel}\nSymbol: ${item.name}\nCode:\n${code}\n`;
    if (out.length + block.length > maxContextChars) {
      out += '\n...(truncated)...';
      break;
    }
    out += block;
  }

  return out;
}

async function collectWorkspaceDependencies(doc, range, names, maxDeps, seen) {
  const results = [];
  const wsRoot = getWorkspaceRoot();
  for (const name of names) {
    if (results.length >= maxDeps) break;
    let symbols;
    try {
      symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name);
    } catch {
      symbols = [];
    }
    if (!Array.isArray(symbols)) continue;
    for (const sym of symbols) {
      if (!sym || !sym.location || !sym.location.uri || !sym.location.range) continue;
      if (!isRelevantWorkspaceSymbol(sym)) continue;
      if (sym.location.uri.toString() === doc.uri.toString() && range.contains(sym.location.range)) {
        continue;
      }
      const key = `${sym.location.uri.toString()}#${sym.location.range.start.line}:${sym.location.range.start.character}-${sym.location.range.end.line}:${sym.location.range.end.character}`;
      if (seen.has(key)) continue;
      if (wsRoot && !sym.location.uri.fsPath.startsWith(wsRoot)) continue;
      seen.add(key);
      results.push({ uri: sym.location.uri, range: sym.location.range, name: sym.name || name });
      if (results.length >= maxDeps) break;
    }
  }
  return results;
}

function isRelevantWorkspaceSymbol(sym) {
  const kind = sym.kind;
  return (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor ||
    kind === vscode.SymbolKind.Field ||
    kind === vscode.SymbolKind.Constant ||
    kind === vscode.SymbolKind.Property ||
    kind === vscode.SymbolKind.Variable ||
    kind === vscode.SymbolKind.Class ||
    kind === vscode.SymbolKind.Struct ||
    kind === vscode.SymbolKind.Interface ||
    kind === vscode.SymbolKind.Enum
  );
}

async function collectDocumentSymbols(doc) {
  let result;
  try {
    result = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
  } catch {
    return [];
  }
  if (!Array.isArray(result)) return [];
  const list = [];
  for (const item of result) {
    if (item && Array.isArray(item.children)) {
      flattenDocumentSymbols(item, list);
    } else if (item && item.name) {
      list.push(item);
    }
  }
  return list;
}

function flattenDocumentSymbols(symbol, out) {
  out.push(symbol);
  if (!Array.isArray(symbol.children)) return;
  for (const child of symbol.children) {
    flattenDocumentSymbols(child, out);
  }
}

function extractCalledIdentifiers(text) {
  const names = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = re.exec(text))) {
    const name = match[1];
    if (isLikelyKeyword(name)) continue;
    names.add(name);
  }
  return names;
}

function extractReferencedIdentifiers(text) {
  const names = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match;
  while ((match = re.exec(text))) {
    const name = match[1];
    if (isLikelyKeyword(name)) continue;
    names.add(name);
  }
  return names;
}

function isValueSymbol(sym) {
  return (
    sym.kind === vscode.SymbolKind.Field ||
    sym.kind === vscode.SymbolKind.Constant ||
    sym.kind === vscode.SymbolKind.Property ||
    sym.kind === vscode.SymbolKind.Variable
  );
}

function isLikelyKeyword(name) {
  const keywords = new Set([
    'if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'throw',
    'new', 'typeof', 'nameof', 'default', 'await', 'yield',
    'function', 'class', 'constructor', 'get', 'set', 'async'
  ]);
  const commonTypes = new Set([
    'Task', 'ValueTask', 'List', 'Dictionary', 'HashSet', 'IEnumerable', 'IList', 'IDictionary',
    'String', 'Object', 'Boolean', 'Int32', 'Int64', 'Double', 'Decimal', 'DateTime', 'Guid',
    'CancellationToken', 'CancellationTokenSource', 'Exception'
  ]);
  return keywords.has(name) || commonTypes.has(name);
}

async function collectOutgoingCallHierarchy(doc, position, maxDepth, maxDeps) {
  let roots;
  try {
    roots = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', doc.uri, position);
  } catch {
    return [];
  }
  if (!Array.isArray(roots) || !roots.length) return [];

  const rootKeys = new Set(roots.map((item) => callHierarchyKey(item)));
  const seen = new Set(rootKeys);
  const queue = roots.map((item) => ({ item, depth: 0 }));
  const results = [];

  while (queue.length && results.length < maxDeps) {
    const { item, depth } = queue.shift();
    if (depth >= maxDepth) continue;

    let outgoing;
    try {
      outgoing = await vscode.commands.executeCommand('vscode.provideOutgoingCalls', item);
    } catch {
      outgoing = [];
    }
    if (!Array.isArray(outgoing)) continue;

    for (const call of outgoing) {
      const target = call && call.to;
      if (!target || !target.uri || !target.range) continue;
      const key = callHierarchyKey(target);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(target);
      if (depth + 1 < maxDepth && results.length < maxDeps) {
        queue.push({ item: target, depth: depth + 1 });
      }
      if (results.length >= maxDeps) break;
    }
  }

  return results;
}

function callHierarchyKey(item) {
  const r = item.range;
  return `${item.uri.toString()}#${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
}

function normalizeCommentLines(comment, lineOffset, lineCount) {
  const startRaw = Number(comment.startLine);
  const endRaw = Number(comment.endLine ?? comment.startLine);

  if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return null;

  let startLine = Math.max(1, Math.floor(startRaw));
  let endLine = Math.max(1, Math.floor(endRaw));
  if (endLine < startLine) endLine = startLine;

  const startLineAbs = lineOffset + startLine - 1;
  const endLineAbs = lineOffset + endLine - 1;
  const maxLineIndex = Math.max(0, lineCount - 1);

  return {
    safeStart: Math.min(Math.max(startLineAbs, 0), maxLineIndex),
    safeEnd: Math.min(Math.max(endLineAbs, 0), maxLineIndex)
  };
}

module.exports = {
  getSurroundingContext,
  isMethodSymbol,
  getSafeRange,
  countLines,
  adjustSelectionForEdit,
  updateSelectionContextsForEdit,
  refreshSelectionContexts,
  buildMethodDependencyContext,
  collectDocumentSymbols,
  extractCalledIdentifiers,
  extractReferencedIdentifiers,
  isRelevantWorkspaceSymbol,
  isValueSymbol,
  isLikelyKeyword,
  collectOutgoingCallHierarchy,
  normalizeCommentLines
};
