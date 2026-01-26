const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const { readOutputBuffer } = require('../helpers/output');

const execAsync = util.promisify(exec);
const SYMBOL_KIND_NAMES = [
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter'
];

function isLikelyFileQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return true;
  const extMatch = /\\.([a-z0-9]{1,6})$/i.exec(raw);
  if (!extMatch) return false;
  return true;
}

function normalizeGlobPattern(pattern, fallback) {
  const raw = String(pattern || '').trim();
  if (!raw) return fallback;
  if (raw === '*' || raw === '*/' || raw === '/*') return '**/*';
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed === 'node_modules') return '**/node_modules/**';
  if (/[?*{}\[\]]/.test(raw)) return raw;
  const lastSegment = trimmed.split(/[\\/]/).pop() || trimmed;
  if (!lastSegment) return raw;
  if (lastSegment.includes('.')) return raw;
  return `${trimmed}/**/*`;
}

function limitToolOutput(text, maxChars) {
  const limit = Math.max(200, Number(maxChars || 12000));
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit) + '\n...[truncated]';
}

function splitLines(text) {
  const src = String(text || '');
  if (!src) return [];
  return src.split(/\r?\n/);
}

function buildSimpleDiff(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const diffLines = [];
  if (oldText) {
    for (const line of oldLines) diffLines.push(`-${line}`);
  }
  if (newText) {
    for (const line of newLines) diffLines.push(`+${line}`);
  }
  if (!diffLines.length) return '';
  return diffLines.join('\n');
}

function buildUnifiedDiff(oldText, newText, options = {}) {
  const contextLines = Number.isFinite(Number(options.contextLines)) ? Math.max(0, Number(options.contextLines)) : 3;
  const maxCells = Number.isFinite(Number(options.maxCells)) ? Math.max(1000, Number(options.maxCells)) : 200000;
  const maxDiffLines = Number.isFinite(Number(options.maxDiffLines)) ? Math.max(50, Number(options.maxDiffLines)) : 400;

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (!oldLines.length && !newLines.length) return '';

  let prefix = 0;
  while (prefix < oldLines.length
      && prefix < newLines.length
      && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix
      && newSuffix >= prefix
      && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const oldMid = oldLines.slice(prefix, oldSuffix + 1);
  const newMid = newLines.slice(prefix, newSuffix + 1);

  const size = oldMid.length * newMid.length;
  if (size > maxCells) {
    return buildSimpleDiff(oldText, newText);
  }

  const n = oldMid.length;
  const m = newMid.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (oldMid[i] === newMid[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const ops = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: 'context', line: oldLines[i] });
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) {
      ops.push({ type: 'context', line: oldMid[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: oldMid[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: newMid[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: oldMid[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', line: newMid[j] });
    j += 1;
  }

  for (let k = oldSuffix + 1; k < oldLines.length; k += 1) {
    ops.push({ type: 'context', line: oldLines[k] });
  }

  const entries = [];
  let oldPos = 1;
  let newPos = 1;
  for (const op of ops) {
    entries.push({ ...op, oldPos, newPos });
    if (op.type === 'context') {
      oldPos += 1;
      newPos += 1;
    } else if (op.type === 'del') {
      oldPos += 1;
    } else if (op.type === 'add') {
      newPos += 1;
    }
  }

  const changeIndexes = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    if (entries[idx].type !== 'context') changeIndexes.push(idx);
  }
  if (!changeIndexes.length) return '';

  const ranges = [];
  for (const idx of changeIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(entries.length - 1, idx + contextLines);
    if (!ranges.length || start > ranges[ranges.length - 1].end + 1) {
      ranges.push({ start, end });
    } else {
      ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, end);
    }
  }

  const diffLines = [];
  for (const range of ranges) {
    const slice = entries.slice(range.start, range.end + 1);
    const oldStart = slice[0].oldPos;
    const newStart = slice[0].newPos;
    let oldCount = 0;
    let newCount = 0;
    for (const entry of slice) {
      if (entry.type !== 'add') oldCount += 1;
      if (entry.type !== 'del') newCount += 1;
    }
    diffLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of slice) {
      const prefixChar = entry.type === 'context' ? ' ' : entry.type === 'add' ? '+' : '-';
      diffLines.push(prefixChar + entry.line);
    }
  }

  if (diffLines.length > maxDiffLines) {
    const truncated = diffLines.slice(0, maxDiffLines);
    truncated.push(' ...');
    return truncated.join('\n');
  }

  return diffLines.join('\n');
}

function buildDiffBlock(oldText, newText) {
  const diffText = buildUnifiedDiff(oldText, newText, { contextLines: 3 });
  if (!diffText) return '';
  return '```diff\n' + diffText + '\n```';
}

function normalizePatchPath(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed === '/dev/null') return '';
  const unquoted = trimmed.replace(/^"+|"+$/g, '');
  return unquoted.replace(/^[ab]\//, '');
}

function extractPatchTargets(patch) {
  const lines = String(patch || '').split(/\r?\n/);
  const targets = [];
  let pendingOld = '';
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      pendingOld = normalizePatchPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = normalizePatchPath(line.slice(4));
      targets.push({ oldPath: pendingOld, newPath });
      pendingOld = '';
    }
  }
  return targets;
}

function limitDiffLines(text, maxLines) {
  const lines = String(text || '').split(/\r?\n/);
  const limit = Math.max(20, Number(maxLines || 400));
  if (lines.length <= limit) return { text: String(text || ''), truncated: false };
  const sliced = lines.slice(0, limit).join('\n');
  return { text: `${sliced}\n...`, truncated: true };
}

function createToolRunner({
  vscode,
  getWorkspaceRoot,
  resolveWorkspacePathForTool,
  toWorkspaceRelativePath,
  updateSelectionContextsForEdit,
  requestApproval,
  getThreadState
}) {
  const revertChanges = new Map();
  const revertOrder = [];
  const MAX_REVERTS = 40;

  async function confirmAction({ title, details, approveLabel, cancelLabel }) {
    if (typeof requestApproval === 'function') {
      return await requestApproval({ title, details, approveLabel, cancelLabel });
    }
    const message = String(title || 'Approve action');
    const approve = approveLabel || 'Approve';
    const cancel = cancelLabel || 'Cancel';
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, approve, cancel);
    return choice === approve;
  }

  function shellEscape(value) {
    const raw = String(value || '');
    if (!raw) return '""';
    return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
  }

  async function runRipgrepSearch({ query, include, exclude, maxResults }) {
    const cwd = getWorkspaceRoot();
    if (!cwd) return { ok: false, text: 'Search failed: workspace root not available.' };
    const args = [
      'rg',
      '--vimgrep',
      '--fixed-strings',
      '--no-heading',
      '--color',
      'never'
    ];
    if (include && include !== '**/*') {
      args.push('--glob', include);
    }
    if (exclude) {
      args.push('--glob', `!${exclude}`);
    }
    args.push(query, '.');

    const command = args.map(shellEscape).join(' ');
    try {
      const result = await execAsync(command, {
        cwd,
        timeout: 20000,
        maxBuffer: 1024 * 1024
      });
      const stdout = result.stdout ? String(result.stdout).trim() : '';
      if (!stdout) return { ok: true, text: 'Search results: no matches.' };
      const lines = stdout.split(/\r?\n/);
      const out = [];
      for (const line of lines) {
        if (out.length >= maxResults) break;
        const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
        if (!match) continue;
        const rel = toWorkspaceRelativePath(match[1]) || match[1];
        const lineNo = match[2];
        const preview = match[4] ? match[4].trim() : '';
        out.push(`${rel}:${lineNo} | ${preview}`);
      }
      if (!out.length) return { ok: true, text: 'Search results: no matches.' };
      return { ok: true, text: `Search results (${out.length}):\n` + out.join('\n') };
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      const code = Number.isFinite(err && err.code) ? Number(err.code) : null;
      if (code === 1) {
        return { ok: true, text: 'Search results: no matches.' };
      }
      const message = err && err.message ? err.message : String(err);
      const suffix = stderr ? `\n${stderr}` : '';
      return { ok: false, text: `Search failed: ${message}${suffix}`.trim() };
    }
  }

  function registerRevertChange(change) {
    if (!change || !Array.isArray(change.files) || !change.files.length) return '';
    const id = `revert_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    revertChanges.set(id, change);
    revertOrder.push(id);
    if (revertOrder.length > MAX_REVERTS) {
      const oldest = revertOrder.shift();
      if (oldest) revertChanges.delete(oldest);
    }
    return id;
  }

  function formatRevertTag(id) {
    const safe = String(id || '').trim();
    return safe ? `\n\n[[revert:${safe}]]` : '';
  }

  async function revertChange(id) {
    const key = String(id || '').trim();
    if (!key) return 'Revert failed: missing change id.';
    const change = revertChanges.get(key);
    if (!change) return 'Revert failed: change not found or expired.';
    const results = [];
    for (const file of change.files) {
      if (!file || !file.path) continue;
      const uri = vscode.Uri.file(file.path);
      const rel = toWorkspaceRelativePath(file.path);
      if (!file.existed) {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
          results.push(`Removed ${rel}.`);
        } catch (err) {
          results.push(`Remove failed for ${rel}: ${String(err && err.message ? err.message : err)}`);
        }
        continue;
      }
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.path)));
        const content = typeof file.content === 'string' ? file.content : '';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        results.push(`Restored ${rel}.`);
      } catch (err) {
        results.push(`Restore failed for ${rel}: ${String(err && err.message ? err.message : err)}`);
      }
    }
    revertChanges.delete(key);
    return results.length ? `Revert complete.\n${results.join('\n')}` : 'Revert complete.';
  }

  function toUriFromArgs(argPath) {
    const fullPath = resolveWorkspacePathForTool(argPath);
    if (!fullPath) return null;
    return vscode.Uri.file(fullPath);
  }

  function parsePosition(args) {
    const line = Number.isFinite(Number(args.line)) ? Math.max(1, Number(args.line)) : 1;
    const character = Number.isFinite(Number(args.character)) ? Math.max(1, Number(args.character)) : 1;
    return new vscode.Position(line - 1, character - 1);
  }

  function formatLocation(loc) {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetRange || loc.targetSelectionRange;
    if (!uri || !range) return 'Unknown location';
    const rel = toWorkspaceRelativePath(uri.fsPath);
    const line = range.start.line + 1;
    const col = range.start.character + 1;
    return `${rel}:${line}:${col}`;
  }

  function formatSymbolTree(symbols, depth = 0) {
    const out = [];
    for (const sym of symbols || []) {
      const prefix = '  '.repeat(depth);
      const kind = symbolKindName(sym.kind);
      out.push(`${prefix}- ${sym.name} (${kind})`);
      if (sym.children && sym.children.length) {
        out.push(...formatSymbolTree(sym.children, depth + 1));
      }
    }
    return out;
  }

  async function toolSearch(args) {
    const query = String(args.query || '').trim();
    if (!query) return 'Search failed: query is required.';
    if (isLikelyFileQuery(query)) {
      const result = await toolLocateFile({ query, include: args.include, exclude: args.exclude, maxResults: args.maxResults });
      return `Search redirected to locate_file for "${query}".\n${result}`;
    }
    const include = normalizeGlobPattern(args.include, '**/*');
    const exclude = normalizeGlobPattern(args.exclude, '**/node_modules/**');
    const maxResults = Math.max(1, Math.min(100, Number(args.maxResults || 20)));

    const results = [];
    try {
      await vscode.workspace.findTextInFiles(
        { pattern: query },
        { include, exclude, maxResults },
        (res) => {
          if (results.length >= maxResults) return;
          const rel = toWorkspaceRelativePath(res.uri.fsPath);
          const line = res.range.start.line + 1;
          const preview = res.preview && res.preview.text ? res.preview.text.trim() : '';
          results.push(`${rel}:${line} | ${preview}`);
        }
      );
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (message.includes('findTextInFiles') && message.includes('proposal')) {
        const fallback = await runRipgrepSearch({ query, include, exclude, maxResults });
        if (fallback.ok) {
          return `${fallback.text}\n\nNote: findTextInFiles is unavailable; used ripgrep fallback.`;
        }
        return `${fallback.text}\n\nNote: findTextInFiles requires the proposed API; enable it or run with --enable-proposed-api.`;
      }
      return `Search failed: ${message}`;
    }

    if (!results.length) return 'Search results: no matches.';
    return `Search results (${results.length}):\n` + results.join('\n');
  }

  async function toolReadFile(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Read failed: invalid or out-of-workspace path.';

    const maxChars = Math.max(200, Math.min(50000, Number(args.maxChars || 12000)));
    let startLine = Number.isFinite(Number(args.startLine)) ? Math.max(1, Number(args.startLine)) : 1;
    let endLine = Number.isFinite(Number(args.endLine)) ? Math.max(startLine, Number(args.endLine)) : 0;

    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
      const text = Buffer.from(bytes).toString('utf8');
      const lines = text.split(/\r?\n/);

      if (!endLine || endLine > lines.length) endLine = lines.length;
      if (startLine > lines.length) return `Read failed: startLine exceeds file length (${lines.length}).`;

      const slice = lines.slice(startLine - 1, endLine);
      const width = String(endLine).length;
      const numbered = slice.map((line, i) => `${String(startLine + i).padStart(width, ' ')} | ${line}`);
      const out = numbered.join('\n');

      return limitToolOutput(out, maxChars);
    } catch (err) {
      return `Read failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReadFiles(args) {
    const paths = Array.isArray(args.paths)
      ? args.paths.map((p) => String(p || '').trim()).filter(Boolean)
      : [];
    if (!paths.length) return 'Read files failed: paths[] is required.';
    const ranges = Array.isArray(args.ranges) ? args.ranges : [];
    const sharedRange = args.range && typeof args.range === 'object' ? args.range : null;
    const maxChars = Math.max(500, Math.min(50000, Number(args.maxChars || 12000)));

    const chunks = [];
    for (let i = 0; i < paths.length; i++) {
      const pathText = paths[i];
      const range = ranges[i] && typeof ranges[i] === 'object' ? ranges[i] : sharedRange;
      const startLine = range && Number.isFinite(Number(range.startLine)) ? Number(range.startLine) : undefined;
      const endLine = range && Number.isFinite(Number(range.endLine)) ? Number(range.endLine) : undefined;
      const result = await toolReadFile({
        path: pathText,
        startLine,
        endLine,
        maxChars: maxChars
      });
      chunks.push(`File: ${pathText}\n${result}`);
    }

    return limitToolOutput(chunks.join('\n\n'), maxChars);
  }

  function symbolKindName(kind) {
    if (typeof kind !== 'number') return 'Symbol';
    return SYMBOL_KIND_NAMES[kind] || 'Symbol';
  }

  function flattenSymbols(symbols, out = []) {
    for (const sym of symbols || []) {
      out.push(sym);
      if (sym.children && sym.children.length) {
        flattenSymbols(sym.children, out);
      }
    }
    return out;
  }

  async function toolSearchSymbols(args) {
    const query = String(args.query || '').trim();
    if (!query) return 'Search symbols failed: query is required.';
    const maxResults = Math.max(1, Math.min(50, Number(args.maxResults || 20)));
    try {
      const raw = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
      if (!Array.isArray(raw) || !raw.length) return 'Search symbols: no matches.';
      const list = raw.slice(0, maxResults).map((sym) => {
        const kind = symbolKindName(sym.kind);
        const uri = sym.location && sym.location.uri ? sym.location.uri : null;
        const rel = uri ? toWorkspaceRelativePath(uri.fsPath) : '';
        const line = sym.location ? sym.location.range.start.line + 1 : '';
        const container = sym.containerName ? ` (${sym.containerName})` : '';
        return `${kind} ${sym.name}${container} — ${rel}${line ? `:${line}` : ''}`;
      });
      return `Search symbols (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Search symbols failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolWorkspaceSymbols(args) {
    return await toolSearchSymbols(args);
  }

  async function toolDocumentSymbols(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Document symbols failed: invalid or out-of-workspace path.';
    try {
      const raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
      if (!Array.isArray(raw) || !raw.length) return 'Document symbols: no matches.';
      const tree = formatSymbolTree(raw);
      return `Document symbols (${tree.length}):\n` + tree.join('\n');
    } catch (err) {
      return `Document symbols failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolDefinition(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Definition failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
      if (!result || !result.length) return 'Definition: no matches.';
      const list = result.map(formatLocation);
      return `Definition (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Definition failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolTypeDefinition(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Type definition failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.executeTypeDefinitionProvider', uri, position);
      if (!result || !result.length) return 'Type definition: no matches.';
      const list = result.map(formatLocation);
      return `Type definition (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Type definition failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolImplementation(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Implementation failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.executeImplementationProvider', uri, position);
      if (!result || !result.length) return 'Implementation: no matches.';
      const list = result.map(formatLocation);
      return `Implementation (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Implementation failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReferences(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'References failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    const includeDeclaration = Boolean(args.includeDeclaration ?? true);
    try {
      const result = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        uri,
        position,
        { includeDeclaration }
      );
      if (!result || !result.length) return 'References: no matches.';
      const list = result.map(formatLocation);
      return `References (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `References failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolHover(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Hover failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
      if (!result || !result.length) return 'Hover: no matches.';
      const lines = [];
      for (const hover of result) {
        const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
        for (const item of contents) {
          if (typeof item === 'string') lines.push(item);
          else if (item && typeof item.value === 'string') lines.push(item.value);
        }
      }
      const text = lines.join('\n').trim();
      return text ? `Hover:\n${text}` : 'Hover: no text.';
    } catch (err) {
      return `Hover failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolSignatureHelp(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Signature help failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', uri, position);
      if (!result || !result.signatures || !result.signatures.length) return 'Signature help: no matches.';
      const sig = result.signatures[result.activeSignature || 0];
      const label = sig.label || 'Signature';
      const doc = sig.documentation && sig.documentation.value ? sig.documentation.value : sig.documentation || '';
      return `Signature:\n${label}\n${doc ? `\n${doc}` : ''}`;
    } catch (err) {
      return `Signature help failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  const callHierarchyCache = new Map();

  async function toolCallHierarchyPrepare(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Call hierarchy prepare failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const items = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position);
      if (!Array.isArray(items) || !items.length) return 'Call hierarchy: no matches.';
      const results = items.map((item) => {
        const id = `chi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        callHierarchyCache.set(id, item);
        const kind = symbolKindName(item.kind);
        const rel = toWorkspaceRelativePath(item.uri.fsPath);
        const line = item.range.start.line + 1;
        return `${id} | ${kind} ${item.name} — ${rel}:${line}`;
      });
      return `Call hierarchy items (${results.length}):\n` + results.join('\n');
    } catch (err) {
      return `Call hierarchy prepare failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolCallHierarchyIncoming(args) {
    const id = String(args.itemId || args.id || '').trim();
    if (!id) return 'Call hierarchy incoming failed: itemId is required.';
    const item = callHierarchyCache.get(id);
    if (!item) return 'Call hierarchy incoming failed: item not found (prepare first).';
    try {
      const calls = await vscode.commands.executeCommand('vscode.provideIncomingCallHierarchy', item);
      if (!Array.isArray(calls) || !calls.length) return 'Call hierarchy incoming: no matches.';
      const list = calls.map((call) => {
        const from = call.from;
        const kind = symbolKindName(from.kind);
        const rel = toWorkspaceRelativePath(from.uri.fsPath);
        const line = from.range.start.line + 1;
        return `${kind} ${from.name} — ${rel}:${line}`;
      });
      return `Call hierarchy incoming (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Call hierarchy incoming failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolCallHierarchyOutgoing(args) {
    const id = String(args.itemId || args.id || '').trim();
    if (!id) return 'Call hierarchy outgoing failed: itemId is required.';
    const item = callHierarchyCache.get(id);
    if (!item) return 'Call hierarchy outgoing failed: item not found (prepare first).';
    try {
      const calls = await vscode.commands.executeCommand('vscode.provideOutgoingCallHierarchy', item);
      if (!Array.isArray(calls) || !calls.length) return 'Call hierarchy outgoing: no matches.';
      const list = calls.map((call) => {
        const to = call.to;
        const kind = symbolKindName(to.kind);
        const rel = toWorkspaceRelativePath(to.uri.fsPath);
        const line = to.range.start.line + 1;
        return `${kind} ${to.name} — ${rel}:${line}`;
      });
      return `Call hierarchy outgoing (${list.length}):\n` + list.join('\n');
    } catch (err) {
      return `Call hierarchy outgoing failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolRenamePrepare(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Rename prepare failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const result = await vscode.commands.executeCommand('vscode.prepareRename', uri, position);
      if (!result) return 'Rename prepare: no rename available.';
      const range = result.range || result;
      const placeholder = result.placeholder || '';
      const startLine = range.start.line + 1;
      const startCol = range.start.character + 1;
      const endLine = range.end.line + 1;
      const endCol = range.end.character + 1;
      return `Rename prepare: range ${startLine}:${startCol}-${endLine}:${endCol} ${placeholder ? `placeholder="${placeholder}"` : ''}`.trim();
    } catch (err) {
      return `Rename prepare failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolRenameApply(args) {
    const newName = String(args.newName || '').trim();
    if (!newName) return 'Rename apply failed: newName is required.';
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Rename apply failed: invalid or out-of-workspace path.';
    const position = parsePosition(args);
    try {
      const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, position, newName);
      if (!edit) return 'Rename apply: no edit returned.';
      const approved = await confirmAction({
        title: 'Apply rename?',
        details: [`New name: ${newName}`],
        approveLabel: 'Apply',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Rename canceled by user.';
      const ok = await vscode.workspace.applyEdit(edit);
      return ok ? 'Rename applied.' : 'Rename failed: workspace edit rejected.';
    } catch (err) {
      return `Rename apply failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolSemanticTokens(args) {
    const uri = toUriFromArgs(args.uri || args.path);
    if (!uri) return 'Semantic tokens failed: invalid or out-of-workspace path.';
    try {
      let tokens;
      if (args.range) {
        const range = args.range;
        const start = new vscode.Position(Math.max(0, (range.startLine || 1) - 1), Math.max(0, (range.startCharacter || 1) - 1));
        const end = new vscode.Position(Math.max(0, (range.endLine || start.line + 1) - 1), Math.max(0, (range.endCharacter || 1) - 1));
        tokens = await vscode.commands.executeCommand('vscode.provideDocumentRangeSemanticTokens', uri, new vscode.Range(start, end));
      } else {
        tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri);
      }
      if (!tokens || !tokens.data || !tokens.data.length) return 'Semantic tokens: no data.';
      return `Semantic tokens: ${tokens.data.length} integers.`;
    } catch (err) {
      return `Semantic tokens failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolLocateFile(args) {
    const query = String(args.query || args.name || '').trim();
    if (!query) return 'Locate file failed: query is required.';
    const maxResults = Math.max(1, Math.min(200, Number(args.maxResults || 20)));
    const include = normalizeGlobPattern(args.include, '**/*');
    const exclude = normalizeGlobPattern(args.exclude, '**/node_modules/**');
    const patterns = Array.isArray(args.patterns) && args.patterns.length
      ? args.patterns.map((p) => String(p))
      : [];

    try {
      const files = await vscode.workspace.findFiles(include, exclude, 5000);
      if (!files.length) return 'Locate file: workspace is empty.';
      const needle = query.toLowerCase();

      const candidates = [];
      for (const uri of files) {
        const rel = toWorkspaceRelativePath(uri.fsPath);
        const relLower = rel.toLowerCase();
        const base = path.basename(rel).toLowerCase();
        let score = 0;
        if (base === needle) score += 100;
        if (base.startsWith(needle)) score += 60;
        if (base.includes(needle)) score += 40;
        if (relLower.includes(needle)) score += 20;
        if (patterns.length && patterns.some((p) => relLower.includes(String(p).toLowerCase()))) score += 10;
        if (score > 0) {
          candidates.push({ rel, score });
        }
      }

      if (!candidates.length) return `Locate file: no matches for "${query}".`;
      candidates.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
      const top = candidates.slice(0, maxResults).map((c) => c.rel);
      return `Locate file (${top.length}):\n` + top.join('\n');
    } catch (err) {
      return `Locate file failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReadFileRangeBySymbols(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Read by symbols failed: invalid or out-of-workspace path.';
    const symbolsArg = args.symbols;
    const names = Array.isArray(symbolsArg)
      ? symbolsArg.map((s) => String(s || '').trim()).filter(Boolean)
      : String(symbolsArg || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return 'Read by symbols failed: symbols list is required.';

    const maxChars = Math.max(500, Math.min(50000, Number(args.maxChars || 12000)));
    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      const flat = flattenSymbols(raw || []);
      if (!flat.length) return 'Read by symbols: no symbols found in file.';

      const results = [];
      for (const name of names) {
        const exact = flat.filter((sym) => sym.name === name);
        const matches = exact.length ? exact : flat.filter((sym) => sym.name.toLowerCase() === name.toLowerCase());
        if (!matches.length) {
          results.push(`Symbol "${name}": not found.`);
          continue;
        }
        for (const sym of matches) {
          const range = sym.range || sym.selectionRange || sym.location?.range;
          if (!range) continue;
          const startLine = range.start.line + 1;
          const endLine = range.end.line + 1;
          const slice = doc.getText(range);
          const header = `${symbolKindName(sym.kind)} ${sym.name} (lines ${startLine}-${endLine})`;
          results.push(`${header}\n${slice}`);
        }
      }

      if (!results.length) return 'Read by symbols: no matches.';
      return limitToolOutput(results.join('\n\n'), maxChars);
    } catch (err) {
      return `Read by symbols failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolEditFile(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Edit failed: invalid or out-of-workspace path.';

    const startLine = Number(args.startLine);
    const endLine = Number(args.endLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      return 'Edit failed: startLine and endLine are required numbers.';
    }
    if (endLine < startLine) return 'Edit failed: endLine must be >= startLine.';

    const rawNewText = String(args.newText || '');

    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const beforeDocText = doc.getText();
      const maxLine = Math.max(1, doc.lineCount);
      const safeStart = Math.min(Math.max(1, startLine), maxLine);
      const safeEnd = Math.min(Math.max(safeStart, endLine), maxLine);
      const startPos = new vscode.Position(safeStart - 1, 0);
      const endPos = new vscode.Position(safeEnd - 1, doc.lineAt(safeEnd - 1).text.length);
      const range = new vscode.Range(startPos, endPos);
      const oldText = doc.getText(range);
      const docLines = doc.getText().split(/\r?\n/);
      const newLines = rawNewText.split(/\r?\n/);

      // Trim duplicated context lines that already exist immediately before/after the range.
      const beforeLines = docLines.slice(0, safeStart - 1);
      let prefixTrim = 0;
      const maxPrefix = Math.min(beforeLines.length, newLines.length);
      for (let k = maxPrefix; k > 0; k -= 1) {
        let matches = true;
        for (let i = 0; i < k; i += 1) {
          if (beforeLines[beforeLines.length - k + i] !== newLines[i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          prefixTrim = k;
          break;
        }
      }

      const afterLines = docLines.slice(safeEnd);
      let suffixTrim = 0;
      const maxSuffix = Math.min(afterLines.length, newLines.length - prefixTrim);
      for (let k = maxSuffix; k > 0; k -= 1) {
        let matches = true;
        for (let i = 0; i < k; i += 1) {
          if (afterLines[i] !== newLines[newLines.length - k + i]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          suffixTrim = k;
          break;
        }
      }

      const normalizedLines = newLines.slice(prefixTrim, newLines.length - suffixTrim);
      const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const newText = normalizedLines.join(eol);

      const rel = toWorkspaceRelativePath(fullPath);
      const approved = await confirmAction({
        title: 'Apply file edit?',
        details: [
          `File: ${rel}`,
          `Lines: ${safeStart}-${safeEnd}`,
          `New text length: ${newText.length}`
        ],
        approveLabel: 'Apply',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Edit canceled by user.';

      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, range, newText);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return 'Edit failed: workspace edit was rejected.';

      const threadState = typeof getThreadState === 'function' ? getThreadState() : null;
      if (threadState && threadState.threadContext) {
        updateSelectionContextsForEdit(threadState.threadContext, doc.uri, doc, range, oldText, newText);
      }

      const afterDocText = doc.getText();
      const diff = buildDiffBlock(beforeDocText, afterDocText);
      const trimNote = (prefixTrim || suffixTrim)
        ? `\n\nNote: trimmed ${prefixTrim} leading and ${suffixTrim} trailing line(s) that duplicated adjacent content.`
        : '';
      const suffix = diff ? `\n\n${diff}` : '';
      const revertId = registerRevertChange({
        files: [{ path: fullPath, existed: true, content: beforeDocText }]
      });
      const revertTag = formatRevertTag(revertId);
      return `Edit applied to ${rel} (lines ${safeStart}-${safeEnd}).${suffix}${trimNote}${revertTag}`;
    } catch (err) {
      return `Edit failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  function clampPosition(doc, line, character, allowEnd = true) {
    const maxLine = Math.max(1, doc.lineCount);
    const safeLine = Math.min(Math.max(1, Number(line || 1)), maxLine);
    const lineText = doc.lineAt(safeLine - 1).text;
    const maxChar = allowEnd ? lineText.length + 1 : Math.max(1, lineText.length);
    const safeChar = Math.min(Math.max(1, Number(character || 1)), maxChar);
    return new vscode.Position(safeLine - 1, safeChar - 1);
  }

  async function toolInsertText(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Insert text failed: invalid or out-of-workspace path.';
    const text = String(args.text || '');
    const pos = args.position && typeof args.position === 'object' ? args.position : {};
    const line = Number.isFinite(Number(pos.line)) ? Number(pos.line) : Number(args.line);
    const character = Number.isFinite(Number(pos.character)) ? Number(pos.character) : Number(args.character);
    if (!Number.isFinite(line) || !Number.isFinite(character)) {
      return 'Insert text failed: position.line and position.character are required.';
    }

    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const beforeDocText = doc.getText();
      const position = clampPosition(doc, line, character, true);
      const rel = toWorkspaceRelativePath(fullPath);
      const approved = await confirmAction({
        title: 'Insert text?',
        details: [
          `File: ${rel}`,
          `Position: ${position.line + 1}:${position.character + 1}`,
          `Text length: ${text.length}`
        ],
        approveLabel: 'Insert',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Insert text canceled by user.';

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, position, text);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return 'Insert text failed: workspace edit rejected.';

      const threadState = typeof getThreadState === 'function' ? getThreadState() : null;
      if (threadState && threadState.threadContext) {
        updateSelectionContextsForEdit(threadState.threadContext, doc.uri, doc, new vscode.Range(position, position), '', text);
      }

      const afterDocText = doc.getText();
      const diff = buildDiffBlock(beforeDocText, afterDocText);
      const suffix = diff ? `\n\n${diff}` : '';
      const revertId = registerRevertChange({
        files: [{ path: fullPath, existed: true, content: beforeDocText }]
      });
      const revertTag = formatRevertTag(revertId);
      return `Inserted text into ${rel} at ${position.line + 1}:${position.character + 1}.${suffix}${revertTag}`;
    } catch (err) {
      return `Insert text failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReplaceRange(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Replace range failed: invalid or out-of-workspace path.';
    const text = String(args.text || '');
    const rangeArg = args.range && typeof args.range === 'object' ? args.range : {};
    const startLine = Number.isFinite(Number(rangeArg.startLine)) ? Number(rangeArg.startLine) : Number(args.startLine);
    const startChar = Number.isFinite(Number(rangeArg.startChar)) ? Number(rangeArg.startChar)
      : Number.isFinite(Number(rangeArg.startCharacter)) ? Number(rangeArg.startCharacter) : Number(args.startChar);
    const endLine = Number.isFinite(Number(rangeArg.endLine)) ? Number(rangeArg.endLine) : Number(args.endLine);
    const endChar = Number.isFinite(Number(rangeArg.endChar)) ? Number(rangeArg.endChar)
      : Number.isFinite(Number(rangeArg.endCharacter)) ? Number(rangeArg.endCharacter) : Number(args.endChar);

    if (![startLine, startChar, endLine, endChar].every((v) => Number.isFinite(v))) {
      return 'Replace range failed: range start/end line/char are required.';
    }

    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const beforeDocText = doc.getText();
      const startPos = clampPosition(doc, startLine, startChar, true);
      const endPos = clampPosition(doc, endLine, endChar, true);
      if (endPos.isBefore(startPos)) {
        return 'Replace range failed: end position must be after start position.';
      }
      const range = new vscode.Range(startPos, endPos);
      const oldText = doc.getText(range);

      const rel = toWorkspaceRelativePath(fullPath);
      const approved = await confirmAction({
        title: 'Replace range?',
        details: [
          `File: ${rel}`,
          `Range: ${startPos.line + 1}:${startPos.character + 1}-${endPos.line + 1}:${endPos.character + 1}`,
          `New text length: ${text.length}`
        ],
        approveLabel: 'Replace',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Replace range canceled by user.';

      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, range, text);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return 'Replace range failed: workspace edit rejected.';

      const threadState = typeof getThreadState === 'function' ? getThreadState() : null;
      if (threadState && threadState.threadContext) {
        updateSelectionContextsForEdit(threadState.threadContext, doc.uri, doc, range, oldText, text);
      }

      const afterDocText = doc.getText();
      const diff = buildDiffBlock(beforeDocText, afterDocText);
      const suffix = diff ? `\n\n${diff}` : '';
      const revertId = registerRevertChange({
        files: [{ path: fullPath, existed: true, content: beforeDocText }]
      });
      const revertTag = formatRevertTag(revertId);
      return `Replaced range in ${rel}.${suffix}${revertTag}`;
    } catch (err) {
      return `Replace range failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolListFiles(args) {
    const include = normalizeGlobPattern(args.include, '**/*');
    const exclude = normalizeGlobPattern(args.exclude, '**/node_modules/**');
    const maxResults = Math.max(1, Math.min(1000, Number(args.maxResults || 200)));
    try {
      const files = await vscode.workspace.findFiles(include, exclude, maxResults);
      if (!files.length) return 'Files: no matches.';
      const rels = files.map((uri) => toWorkspaceRelativePath(uri.fsPath));
      return `Files (${rels.length}):\n` + rels.join('\n');
    } catch (err) {
      return `List failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolFileStat(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'File stat failed: invalid or out-of-workspace path.';
    const rel = toWorkspaceRelativePath(fullPath);
    try {
      const stat = await fs.stat(fullPath);
      const type = stat.isDirectory() ? 'directory' : (stat.isFile() ? 'file' : 'other');
      const mtime = new Date(stat.mtimeMs).toISOString();
      return [
        `File stat for ${rel}:`,
        `- exists: true`,
        `- type: ${type}`,
        `- size: ${stat.size}`,
        `- mtime: ${mtime}`
      ].join('\n');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return `File stat for ${rel}:\n- exists: false`;
      }
      return `File stat failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolWriteFile(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Write failed: invalid or out-of-workspace path.';
    const content = String(args.content || '');
    const overwrite = Boolean(args.overwrite);
    const append = Boolean(args.append);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fullPath)));
      let exists = false;
      let existingContent = '';
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
        exists = true;
      } catch {
        exists = false;
      }

      const rel = toWorkspaceRelativePath(fullPath);
      const actionLabel = append ? 'Append' : (exists ? 'Overwrite' : 'Create');
      const approved = await confirmAction({
        title: `${actionLabel} file?`,
        details: [
          `File: ${rel}`,
          `Mode: ${append ? 'append' : (exists ? 'overwrite' : 'create')}`,
          `Content length: ${content.length}`
        ],
        approveLabel: actionLabel,
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Write canceled by user.';

      if (append) {
        if (exists) {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
          existingContent = Buffer.from(bytes).toString('utf8');
        }
        const next = existingContent + content;
        await vscode.workspace.fs.writeFile(vscode.Uri.file(fullPath), Buffer.from(next, 'utf8'));
        const diff = buildDiffBlock(existingContent, next);
        const suffix = diff ? `\n\n${diff}` : '';
        const revertId = registerRevertChange({
          files: [{ path: fullPath, existed, content: existingContent }]
        });
        const revertTag = formatRevertTag(revertId);
        return `Write appended to ${rel}.${suffix}${revertTag}`;
      }

      if (exists && !overwrite) {
        return `Write failed: ${rel} already exists (set overwrite=true).`;
      }

      if (exists) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
          existingContent = Buffer.from(bytes).toString('utf8');
        } catch {
          existingContent = '';
        }
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.file(fullPath), Buffer.from(content, 'utf8'));
      const diff = buildDiffBlock(existingContent, content);
      const suffix = diff ? `\n\n${diff}` : '';
      const revertId = registerRevertChange({
        files: [{ path: fullPath, existed, content: existingContent }]
      });
      const revertTag = formatRevertTag(revertId);
      return `Write succeeded: ${rel}.${suffix}${revertTag}`;
    } catch (err) {
      return `Write failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolCreateDir(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Create dir failed: invalid or out-of-workspace path.';
    try {
      const rel = toWorkspaceRelativePath(fullPath);
      const approved = await confirmAction({
        title: 'Create directory?',
        details: [`Directory: ${rel}`],
        approveLabel: 'Create',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Create dir canceled by user.';
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath));
      return `Directory created: ${rel}.`;
    } catch (err) {
      return `Create dir failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolDeleteFile(args) {
    const fullPath = resolveWorkspacePathForTool(args.path);
    if (!fullPath) return 'Delete failed: invalid or out-of-workspace path.';
    const recursive = Boolean(args.recursive);
    try {
      const rel = toWorkspaceRelativePath(fullPath);
      let existingContent = '';
      try {
        await fs.stat(fullPath);
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
        existingContent = Buffer.from(bytes).toString('utf8');
      } catch {
        return `Delete failed: ${rel} not found.`;
      }
      const approved = await confirmAction({
        title: 'Delete file?',
        details: [`Target: ${rel}`, `Recursive: ${recursive}`],
        approveLabel: 'Delete',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Delete canceled by user.';
      await vscode.workspace.fs.delete(vscode.Uri.file(fullPath), { recursive, useTrash: true });
      try {
        await fs.stat(fullPath);
        return `Delete failed: ${rel} still exists after delete.`;
      } catch {
        const diff = buildDiffBlock(existingContent, '');
        const suffix = diff ? `\n\n${diff}` : '';
        const revertId = registerRevertChange({
          files: [{ path: fullPath, existed: true, content: existingContent }]
        });
        const revertTag = formatRevertTag(revertId);
        return `Deleted ${rel}.${suffix}${revertTag}`;
      }
    } catch (err) {
      return `Delete failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolMoveFile(args) {
    const fromPath = resolveWorkspacePathForTool(args.from);
    const toPath = resolveWorkspacePathForTool(args.to);
    if (!fromPath || !toPath) return 'Move failed: invalid or out-of-workspace path.';
    const overwrite = Boolean(args.overwrite);
    try {
      const relFrom = toWorkspaceRelativePath(fromPath);
      const relTo = toWorkspaceRelativePath(toPath);
      const approved = await confirmAction({
        title: 'Move file?',
        details: [`From: ${relFrom}`, `To: ${relTo}`, `Overwrite: ${overwrite}`],
        approveLabel: 'Move',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Move canceled by user.';
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(toPath)));
      await vscode.workspace.fs.rename(vscode.Uri.file(fromPath), vscode.Uri.file(toPath), { overwrite });
      return `Moved ${relFrom} → ${relTo}.`;
    } catch (err) {
      return `Move failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReadDir(args) {
    const rawPath = args.path ? String(args.path) : '.';
    const fullPath = resolveWorkspacePathForTool(rawPath || '.');
    if (!fullPath) return 'Read dir failed: invalid or out-of-workspace path.';
    const maxDepth = Math.max(0, Math.min(10, Number(args.maxDepth || 3)));
    const maxEntries = Math.max(20, Math.min(2000, Number(args.maxEntries || 400)));
    const exclude = Array.isArray(args.exclude)
      ? args.exclude.map((v) => String(v))
      : ['node_modules', '.git', '.vscode', '.DS_Store'];

    let count = 0;
    const lines = [];
    let truncated = false;

    function shouldSkip(name) {
      return exclude.includes(name);
    }

    async function walk(dir, depth, prefix) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries = entries
        .filter((entry) => !shouldSkip(entry.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
      for (let i = 0; i < entries.length; i++) {
        if (count >= maxEntries) {
          truncated = true;
          return;
        }
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const pointer = isLast ? '└──' : '├──';
        const name = entry.name + (entry.isDirectory() ? '/' : '');
        lines.push(`${prefix}${pointer} ${name}`);
        count += 1;
        if (entry.isDirectory() && depth > 0) {
          const nextPrefix = prefix + (isLast ? '    ' : '│   ');
          await walk(path.join(dir, entry.name), depth - 1, nextPrefix);
        }
      }
    }

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) {
        return `Read dir failed: ${toWorkspaceRelativePath(fullPath)} is not a directory.`;
      }
      const rel = toWorkspaceRelativePath(fullPath) || '.';
      await walk(fullPath, maxDepth, '');
      const header = `Tree for ${rel} (depth ${maxDepth}):`;
      const body = lines.length ? lines.join('\n') : '(empty)';
      const tail = truncated ? '\n...[truncated]' : '';
      return `${header}\n${body}${tail}`;
    } catch (err) {
      return `Read dir failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolReadOutput(args) {
    const maxChars = Math.max(200, Math.min(50000, Number(args.maxChars || 12000)));
    const tail = args.tail !== false;
    const result = readOutputBuffer({ maxChars, tail });
    if (!result.text) return 'Output is empty.';
    if (result.truncated) {
      const scope = tail ? 'tail' : 'head';
      return `Output (${scope}, ${result.text.length} chars of ${result.total}):\n${result.text}`;
    }
    return `Output (${result.total} chars):\n${result.text}`;
  }

  async function toolApplyPatch(args) {
    const patch = String(args.patch || args.diff || '').trim();
    if (!patch) return 'Apply patch failed: patch content is empty.';
    const rawCwd = args.cwd ? String(args.cwd) : '';
    const cwd = rawCwd ? resolveWorkspacePathForTool(rawCwd) : getWorkspaceRoot();
    if (!cwd) return 'Apply patch failed: invalid or missing workspace cwd.';
    const relCwd = toWorkspaceRelativePath(cwd);
    const approved = await confirmAction({
      title: 'Apply patch?',
      details: [`Cwd: ${relCwd}`, `Patch size: ${patch.length} chars`],
      approveLabel: 'Apply',
      cancelLabel: 'Cancel'
    });
    if (!approved) return 'Apply patch canceled by user.';

    const wsRoot = getWorkspaceRoot();
    const targets = extractPatchTargets(patch);
    const targetPaths = new Set();
    for (const target of targets) {
      const candidates = [target.oldPath, target.newPath].filter(Boolean);
      for (const relPath of candidates) {
        const full = path.resolve(cwd, relPath);
        if (!wsRoot) continue;
        const rel = path.relative(wsRoot, full);
        if (rel.startsWith('..') || rel.includes(`..${path.sep}`)) continue;
        targetPaths.add(full);
      }
    }

    const beforeFiles = [];
    for (const full of targetPaths) {
      let existed = false;
      let content = '';
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(full));
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(full));
        content = Buffer.from(bytes).toString('utf8');
        existed = true;
      } catch {
        existed = false;
        content = '';
      }
      beforeFiles.push({ path: full, existed, content });
    }

    const tmpPath = path.join(os.tmpdir(), `codecritic_patch_${Date.now()}.diff`);
    let output = '';
    let applied = false;

    try {
      await fs.writeFile(tmpPath, patch, 'utf8');
      let gitAvailable = false;
      try {
        await execAsync('git --version', { cwd, timeout: 5000 });
        gitAvailable = true;
      } catch {
        gitAvailable = false;
      }

      if (gitAvailable) {
        try {
          const result = await execAsync(`git apply --whitespace=nowarn \"${tmpPath}\"`, {
            cwd,
            timeout: 60000,
            maxBuffer: 1024 * 1024
          });
          output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          applied = true;
        } catch (err) {
          const stderr = err && err.stderr ? String(err.stderr).trim() : '';
          const message = err && err.message ? err.message : String(err);
          output = `git apply failed: ${message}${stderr ? `\n${stderr}` : ''}`.trim();
          applied = false;
        }
      }

      if (!applied) {
        const attempts = ['patch -p0 -i', 'patch -p1 -i'];
        for (const cmd of attempts) {
          try {
            const result = await execAsync(`${cmd} \"${tmpPath}\"`, {
              cwd,
              timeout: 60000,
              maxBuffer: 1024 * 1024
            });
            const out = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
            if (out) output = out;
            applied = true;
            break;
          } catch (err) {
            const stderr = err && err.stderr ? String(err.stderr).trim() : '';
            const message = err && err.message ? err.message : String(err);
            output = `patch failed: ${message}${stderr ? `\n${stderr}` : ''}`.trim();
          }
        }
      }
    } catch (err) {
      output = `Apply patch failed: ${String(err && err.message ? err.message : err)}`;
    } finally {
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }

    if (!applied) return output || 'Apply patch failed.';
    const limited = limitDiffLines(patch, 400);
    const diff = limited.text ? `\`\`\`diff\n${limited.text}\n\`\`\`` : '';
    const note = limited.truncated ? '\n\nPatch diff truncated.' : '';
    const suffix = diff ? `\n\n${diff}${note}` : '';
    const revertId = registerRevertChange({ files: beforeFiles });
    const revertTag = formatRevertTag(revertId);
    return output ? `Patch applied.\n${output}${suffix}${revertTag}` : `Patch applied.${suffix}${revertTag}`;
  }

  async function toolApplyPatchPreview(args) {
    const patch = String(args.patch || args.diff || '').trim();
    if (!patch) return 'Apply patch preview failed: patch content is empty.';
    const rawCwd = args.cwd ? String(args.cwd) : '';
    const cwd = rawCwd ? resolveWorkspacePathForTool(rawCwd) : getWorkspaceRoot();
    if (!cwd) return 'Apply patch preview failed: invalid or missing workspace cwd.';

    let checkResult = 'Patch check: not run.';
    try {
      await execAsync('git --version', { cwd, timeout: 5000 });
      const tmpPath = path.join(os.tmpdir(), `codecritic_patch_preview_${Date.now()}.diff`);
      await fs.writeFile(tmpPath, patch, 'utf8');
      try {
        await execAsync(`git apply --check \"${tmpPath}\"`, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 });
        checkResult = 'Patch check: applies cleanly.';
      } catch (err) {
        const stderr = err && err.stderr ? String(err.stderr).trim() : '';
        checkResult = `Patch check: failed${stderr ? `\n${stderr}` : ''}`;
      } finally {
        try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      }
    } catch {
      checkResult = 'Patch check: git not available.';
    }

    const limited = limitDiffLines(patch, 400);
    const diffBlock = `\`\`\`diff\n${limited.text}\n\`\`\``;
    const note = limited.truncated ? '\n\nPatch diff truncated.' : '';
    return `${checkResult}\n\n${diffBlock}${note}`;
  }

  async function toolCopyFile(args) {
    const fromPath = resolveWorkspacePathForTool(args.from);
    const toPath = resolveWorkspacePathForTool(args.to);
    if (!fromPath || !toPath) return 'Copy failed: invalid or out-of-workspace path.';
    const overwrite = Boolean(args.overwrite);
    try {
      const relFrom = toWorkspaceRelativePath(fromPath);
      const relTo = toWorkspaceRelativePath(toPath);
      const approved = await confirmAction({
        title: 'Copy file?',
        details: [`From: ${relFrom}`, `To: ${relTo}`, `Overwrite: ${overwrite}`],
        approveLabel: 'Copy',
        cancelLabel: 'Cancel'
      });
      if (!approved) return 'Copy canceled by user.';
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(toPath)));
      await vscode.workspace.fs.copy(vscode.Uri.file(fromPath), vscode.Uri.file(toPath), { overwrite });
      return `Copied ${relFrom} → ${relTo}.`;
    } catch (err) {
      return `Copy failed: ${String(err && err.message ? err.message : err)}`;
    }
  }

  async function toolRunCommand(args) {
    const command = String(args.command || '').trim();
    if (!command) return 'Run failed: command is required.';
    const rawCwd = args.cwd ? String(args.cwd) : '';
    const cwd = rawCwd ? resolveWorkspacePathForTool(rawCwd) : getWorkspaceRoot();
    if (!cwd) return 'Run failed: invalid or missing workspace cwd.';
    const timeoutMs = Math.max(1000, Math.min(5 * 60 * 1000, Number(args.timeoutMs || 60000)));

    const relCwd = toWorkspaceRelativePath(cwd);
    const approved = await confirmAction({
      title: 'Run command?',
      details: [`Command: ${command}`, `Cwd: ${relCwd}`, `Timeout: ${timeoutMs}ms`],
      approveLabel: 'Run',
      cancelLabel: 'Cancel'
    });
    if (!approved) return 'Command canceled by user.';

    try {
      const result = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });
      const stdout = result.stdout ? String(result.stdout).trim() : '';
      const stderr = result.stderr ? String(result.stderr).trim() : '';
      const output = [stdout, stderr].filter(Boolean).join('\n');
      if (!output) return 'Command succeeded (exit 0) with no output.';
      return `Command succeeded (exit 0):\n${output}`;
    } catch (err) {
      const stdout = err && err.stdout ? String(err.stdout).trim() : '';
      const stderr = err && err.stderr ? String(err.stderr).trim() : '';
      const message = err && err.message ? err.message : String(err);
      const code = Number.isFinite(err && err.code) ? ` (exit ${err.code})` : '';
      let output = `Command failed${code}: ${message}`;
      if (stdout) output += `\nSTDOUT:\n${stdout}`;
      if (stderr) output += `\nSTDERR:\n${stderr}`;
      return output;
    }
  }

  async function runToolCall(call) {
    if (!call || typeof call.tool !== 'string') return 'Invalid tool call.';
    const tool = call.tool;
    const args = call.args && typeof call.args === 'object' ? call.args : {};

    if (tool === 'search') return await toolSearch(args);
    if (tool === 'read_file') return await toolReadFile(args);
    if (tool === 'read_files') return await toolReadFiles(args);
    if (tool === 'read_file_range_by_symbols') return await toolReadFileRangeBySymbols(args);
    if (tool === 'edit_file') return await toolEditFile(args);
    if (tool === 'insert_text') return await toolInsertText(args);
    if (tool === 'replace_range') return await toolReplaceRange(args);
    if (tool === 'search_symbols') return await toolSearchSymbols(args);
    if (tool === 'workspace_symbols') return await toolWorkspaceSymbols(args);
    if (tool === 'document_symbols') return await toolDocumentSymbols(args);
    if (tool === 'definition') return await toolDefinition(args);
    if (tool === 'type_definition') return await toolTypeDefinition(args);
    if (tool === 'implementation') return await toolImplementation(args);
    if (tool === 'references') return await toolReferences(args);
    if (tool === 'hover') return await toolHover(args);
    if (tool === 'signature_help') return await toolSignatureHelp(args);
    if (tool === 'call_hierarchy_prepare') return await toolCallHierarchyPrepare(args);
    if (tool === 'call_hierarchy_incoming') return await toolCallHierarchyIncoming(args);
    if (tool === 'call_hierarchy_outgoing') return await toolCallHierarchyOutgoing(args);
    if (tool === 'rename_prepare') return await toolRenamePrepare(args);
    if (tool === 'rename_apply') return await toolRenameApply(args);
    if (tool === 'semantic_tokens') return await toolSemanticTokens(args);
    if (tool === 'locate_file') return await toolLocateFile(args);
    if (tool === 'list_files') return await toolListFiles(args);
    if (tool === 'file_stat') return await toolFileStat(args);
    if (tool === 'write_file') return await toolWriteFile(args);
    if (tool === 'create_dir') return await toolCreateDir(args);
    if (tool === 'delete_file') return await toolDeleteFile(args);
    if (tool === 'move_file') return await toolMoveFile(args);
    if (tool === 'read_dir') return await toolReadDir(args);
    if (tool === 'read_output') return await toolReadOutput(args);
    if (tool === 'apply_patch_preview') return await toolApplyPatchPreview(args);
    if (tool === 'copy_file') return await toolCopyFile(args);
    if (tool === 'apply_patch') return await toolApplyPatch(args);
    if (tool === 'run_command') return await toolRunCommand(args);

    return `Unknown tool: ${tool}`;
  }

  return {
    runToolCall,
    toolSearch,
    toolSearchSymbols,
    toolWorkspaceSymbols,
    toolDocumentSymbols,
    toolDefinition,
    toolTypeDefinition,
    toolImplementation,
    toolReferences,
    toolHover,
    toolSignatureHelp,
    toolCallHierarchyPrepare,
    toolCallHierarchyIncoming,
    toolCallHierarchyOutgoing,
    toolRenamePrepare,
    toolRenameApply,
    toolSemanticTokens,
    toolLocateFile,
    toolReadFile,
    toolReadFiles,
    toolReadFileRangeBySymbols,
    toolEditFile,
    toolInsertText,
    toolReplaceRange,
    toolListFiles,
    toolFileStat,
    toolWriteFile,
    toolCreateDir,
    toolDeleteFile,
    toolMoveFile,
    toolReadDir,
    toolReadOutput,
    toolApplyPatchPreview,
    toolCopyFile,
    toolApplyPatch,
    toolRunCommand,
    revertChange
  };
}

module.exports = {
  createToolRunner,
  limitToolOutput
};
