const vscode = require('vscode');
const path = require('path');
const { THREAD_CONTEXT, THREAD_CONTEXT_ADO } = require('../helpers/constants');
const { isDebugEnabled, getMethodReviewConfig } = require('../helpers/config');
const { getOutputChannel, updateTokenEstimate } = require('../helpers/output');
const {
  getSafeRange,
  getSurroundingContext,
  buildMethodDependencyContext,
  updateSelectionContextsForEdit,
  normalizeCommentLines
} = require('../helpers/context');
const { resolvePathLike } = require('../helpers/workspace');
const { safeJsonParse, extractFirstJsonPayload, extractAssistantText, postChatCompletions } = require('../helpers/llm');

function registerReviewFeature({ context, controller, threadState }) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeCritic: Reviewing file...',
          cancellable: false
        },
        async () => runReview(controller, threadState, editor.document, editor.document.getText(), 0, { kind: 'file' }, '')
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const text = editor.document.getText(sel);
      if (!text || !text.trim()) {
        vscode.window.showInformationMessage('CodeCritic: No selection to review.');
        return;
      }
      const methodCfg = getMethodReviewConfig();
      const extraContext = await buildMethodDependencyContext(editor.document, sel, methodCfg);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeCritic: Reviewing selection...',
          cancellable: false
        },
        async () =>
          runReview(controller, threadState, editor.document, text, sel.start.line, { kind: 'selection', selection: sel }, extraContext)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.fixThread', async (arg) => {
      await vscode.commands.executeCommand('codeCritic.generateProposedChange', arg);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.discardThread', async (arg) => {
      const thread = arg && arg.thread ? arg.thread : arg;
      if (!thread) return;
      try { thread.dispose(); } catch { /* ignore */ }
      threadState.threadSet.delete(thread);
      threadState.adoThreadSet.delete(thread);
      threadState.adoThreadMeta.delete(thread);
      threadState.proposedChanges.delete(thread);
      threadState.threadContext.delete(thread);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.generateProposedChange', async (arg) => {
      await generateProposedChange(controller, threadState, arg);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.applyProposedChange', async (arg) => {
      await applyProposedChange(threadState, arg);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.regenerateProposedChange', async (arg) => {
      await vscode.commands.executeCommand('codeCritic.generateProposedChange', arg);
    })
  );
}

function clearAllThreads(threadState) {
  if (threadState.threadSet.size) {
    for (const t of threadState.threadSet) {
      try { t.dispose(); } catch { /* ignore */ }
    }
    threadState.threadSet.clear();
    threadState.proposedChanges.clear();
    threadState.threadContext.clear();
  }
  if (threadState.adoThreadSet.size) {
    for (const t of threadState.adoThreadSet) {
      try { t.dispose(); } catch { /* ignore */ }
    }
    threadState.adoThreadSet.clear();
    threadState.adoThreadMeta.clear();
  }
}

function clearReviewThreads(threadState) {
  if (!threadState.threadSet.size) return;
  for (const t of threadState.threadSet) {
    try { t.dispose(); } catch { /* ignore */ }
  }
  threadState.threadSet.clear();
  threadState.proposedChanges.clear();
  threadState.threadContext.clear();
}

async function runReview(controller, threadState, doc, code, lineOffset, origin, extraContext) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const maxChars = cfg.get('maxChars', 80000);

  let payload = code;
  if (payload.length > maxChars) {
    payload = payload.slice(0, maxChars) + "\n\n/* ...TRUNCATED... */\n";
    vscode.window.showWarningMessage(`CodeCritic: Truncated input to ${maxChars.toLocaleString()} chars.`);
  }

  const baseInstructions = await readInstructionsFile();
  const instructions = [baseInstructions, String(extraContext || '').trim()].filter(Boolean).join('\n\n');
  updateTokenEstimate(instructions.length + payload.length);
  if (isDebugEnabled()) {
    const out = getOutputChannel();
    out.appendLine('--- CodeCritic context: instructions ---');
    out.appendLine(instructions || '(empty instructions)');
    out.appendLine('--- CodeCritic context: code payload ---');
    out.appendLine(payload || '(empty payload)');
    out.appendLine('--- CodeCritic context: dependency excerpts ---');
    out.appendLine(String(extraContext || '').trim() || '(none)');
    out.appendLine('--- End CodeCritic context ---');
    out.show(true);
  } else if (extraContext && String(extraContext).trim()) {
    const out = getOutputChannel();
    out.appendLine('--- CodeCritic context: dependency excerpts ---');
    out.appendLine(String(extraContext));
    out.appendLine('--- End CodeCritic context ---');
    out.show(true);
  }

  const resp = await callModelForReview({
    code: payload,
    languageId: doc.languageId,
    instructions
  });

  let normalizedResp = normalizeReviewResponse(resp && resp.parsed ? resp.parsed : null);
  if (!normalizedResp && resp && resp.rawText) {
    normalizedResp = normalizeReviewResponse(safeJsonParse(resp.rawText));
  }
  if (!normalizedResp && resp && resp.rawText) {
    normalizedResp = normalizeReviewResponse(safeJsonParse(extractFirstJsonPayload(resp.rawText)));
  }
  if (!normalizedResp || !Array.isArray(normalizedResp.comments)) {
    const out = getOutputChannel();
    out.appendLine('CodeCritic: Model did not return expected JSON (missing comments). Raw response follows.');
    out.appendLine((resp && resp.rawText) || '(empty response)');
    out.show(true);
    vscode.window.showErrorMessage('CodeCritic: Model did not return expected JSON (missing comments).');
    return;
  }

  const beforeFilterCount = normalizedResp.comments.length;
  normalizedResp.comments = normalizedResp.comments.filter((c) => {
    const hasNewText = typeof c.newText === 'string' && c.newText.trim() !== '';
    return hasNewText;
  });
  const filteredCount = beforeFilterCount - normalizedResp.comments.length;
  if (normalizedResp.comments.length === 0) {
    const out = getOutputChannel();
    out.appendLine('CodeCritic: All review comments were omitted because no proposed fixes were provided.');
    out.show(true);
    vscode.window.showWarningMessage('CodeCritic: No review comments included proposed fixes.');
    return;
  }

  // Clear existing AI review threads and create new ones for this run.
  clearReviewThreads(threadState);

  if (!controller) return;

  let invalidLineCount = 0;
  for (const c of normalizedResp.comments) {
    const normalized = normalizeCommentLines(c, lineOffset, doc.lineCount);
    if (!normalized) {
      invalidLineCount += 1;
      continue;
    }
    const { safeStart, safeEnd } = normalized;

    const range = new vscode.Range(
      new vscode.Position(safeStart, 0),
      new vscode.Position(safeEnd, doc.lineAt(safeEnd).text.length)
    );

    const sev = (c.severity || 'info').toLowerCase();
    const label = sev === 'error' ? 'Error' : sev === 'warning' ? 'Warning' : 'Suggestion';
    const newText = typeof c.newText === 'string' ? c.newText : '';
    const snippet = doc.getText(range);
    const adjustedNewText = newText ? normalizeIndentation(newText, snippet) : '';
    const hasProposed = Boolean(adjustedNewText && adjustedNewText !== snippet);

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.appendMarkdown(`**${label}:** ${escapeMarkdown(c.message || '')}`);
    if (hasProposed) {
      md.appendMarkdown('\n\n**Proposed change (diff):**\n\n');
      md.appendMarkdown('```diff\n' + buildInlineDiff(snippet, adjustedNewText) + '\n```');
    }

    const comment = {
      body: md,
      mode: vscode.CommentMode.Preview,
      author: { name: 'CodeCritic' }
    };

    const thread = controller.createCommentThread(doc.uri, range, [comment]);
    thread.contextValue = hasProposed ? `${THREAD_CONTEXT}-proposed` : THREAD_CONTEXT;
    thread.canReply = true;

    threadState.threadSet.add(thread);
    threadState.threadContext.set(thread, { text: payload, origin });
    if (hasProposed) {
      threadState.proposedChanges.set(thread, { newText: adjustedNewText, comment, range });
    }
  }

  if (invalidLineCount > 0) {
    const out = getOutputChannel();
    out.appendLine(`Skipped ${invalidLineCount} comment(s) due to invalid line numbers from the model.`);
    out.show(true);
  }
  if (filteredCount > 0) {
    const out = getOutputChannel();
    out.appendLine(`Omitted ${filteredCount} comment(s) without proposed fixes.`);
    out.show(true);
  }

  vscode.window.showInformationMessage(`CodeCritic: Posted ${normalizedResp.comments.length} comment(s).`);
}

async function generateProposedChange(controller, threadState, arg) {
  const thread = arg && arg.thread ? arg.thread : arg;
  const replyText = arg && typeof arg.text === 'string' ? arg.text : '';
  if (!thread || !thread.uri || !thread.range) return;

  const isAdoThread = Boolean(
    (thread.contextValue && String(thread.contextValue).startsWith(THREAD_CONTEXT_ADO)) ||
      threadState.adoThreadSet.has(thread)
  );

  const doc = await vscode.workspace.openTextDocument(thread.uri);
  const baseRange = thread.range;
  const fixRange = getFixRange(doc, baseRange);
  const snippet = doc.getText(fixRange);

  const commentText = buildCommentText(thread.comments || []);

  const instructions = await readGenerationInstructionsFile();

  const methodCfg = getMethodReviewConfig();
  const extraContext = await buildMethodDependencyContext(doc, fixRange, methodCfg);
  const stored = threadState.threadContext.get(thread);
  const reviewContext = stored && stored.text ? stored.text : getSurroundingContext(doc, fixRange, 20);

  const fixResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeCritic: Generating proposed change...',
      cancellable: false
    },
    async () => callModelForFix({
      snippet,
      commentText,
      languageId: doc.languageId,
      instructions,
      userResponse: replyText,
      extraContext,
      reviewContext
    })
  );

  const fixJson = fixResult && fixResult.parsed;
  const rawNewText = fixJson && typeof fixJson.newText === 'string' ? fixJson.newText : '';

  if (!rawNewText.trim()) {
    vscode.window.showErrorMessage('CodeCritic: Proposed change failed (model did not return {"newText": "..."}).');
    const out = getOutputChannel();
    out.appendLine('Proposed change failed: raw model response follows.');
    out.appendLine((fixResult && fixResult.rawText) || '(empty response)');
    out.show(true);
    return;
  }

  const adjustedNewText = rawNewText.trim() ? normalizeIndentation(rawNewText, snippet) : '';
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown('**Proposed change (diff):**\n\n');
  md.appendMarkdown('```diff\n' + buildInlineDiff(snippet, adjustedNewText) + '\n```');

  const existing = threadState.proposedChanges.get(thread);
  const existingComment = existing && existing.comment && !isReviewComment(existing.comment) ? existing.comment : null;
  const comment = existingComment ? existingComment : {
    body: md,
    mode: vscode.CommentMode.Preview,
    author: { name: 'CodeCritic' }
  };

  if (existingComment) {
    comment.body = md;
    thread.comments = thread.comments.map((c) => (c === existingComment ? comment : c));
  } else {
    thread.comments = [...thread.comments, comment];
  }

  threadState.proposedChanges.set(thread, { newText: adjustedNewText, comment, range: fixRange });
  thread.contextValue = `${isAdoThread ? THREAD_CONTEXT_ADO : THREAD_CONTEXT}-proposed`;
}

async function applyProposedChange(threadState, arg) {
  const thread = arg && arg.thread ? arg.thread : arg;
  if (!thread || !thread.uri || !thread.range) return;
  const proposed = threadState.proposedChanges.get(thread);
  if (!proposed) return;

  const doc = await vscode.workspace.openTextDocument(thread.uri);
  const replaceRange = proposed.range || thread.range;
  const replacementText = proposed.newText || '';
  const oldText = doc.getText(replaceRange);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(thread.uri, replaceRange, replacementText);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showErrorMessage('CodeCritic: Could not apply proposed change.');
    return;
  }
  updateSelectionContextsForEdit(threadState.threadContext, thread.uri, doc, replaceRange, oldText, replacementText);
  vscode.window.showInformationMessage('CodeCritic: Proposed change applied.');
  try { thread.dispose(); } catch { /* ignore */ }
  if (threadState.adoThreadSet.has(thread)) {
    threadState.adoThreadSet.delete(thread);
    threadState.adoThreadMeta.delete(thread);
  } else {
    threadState.threadSet.delete(thread);
  }
  threadState.proposedChanges.delete(thread);
  threadState.threadContext.delete(thread);
}

function getFixRange(doc, baseRange) {
  const safeBase = getSafeRange(doc, baseRange);
  const snippet = doc.getText(safeBase);
  const varName = extractAssignedVariableName(snippet);
  if (!varName) return safeBase;

  const nextLine = Math.min(doc.lineCount - 1, safeBase.end.line + 1);
  if (nextLine <= safeBase.end.line) return safeBase;
  const nextText = doc.lineAt(nextLine).text;
  const re = new RegExp(`\\b${escapeRegExp(varName)}\\b`);
  if (!re.test(nextText)) return safeBase;

  return new vscode.Range(
    new vscode.Position(safeBase.start.line, safeBase.start.character),
    new vscode.Position(nextLine, doc.lineAt(nextLine).text.length)
  );
}

function extractAssignedVariableName(text) {
  const m = /\b(?:var|[A-Za-z_][A-Za-z0-9_<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/m.exec(text);
  return m ? m[1] : '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdown(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`");
}

function buildCommentText(comments) {
  return comments
    .map((c) => stripProposedDiff(typeof c.body === 'string' ? c.body : c.body.value))
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function stripProposedDiff(text) {
  const str = String(text || '');
  const markers = ['**Proposed change (diff):**'];
  let idx = -1;
  for (const marker of markers) {
    const hit = str.indexOf(marker);
    if (hit !== -1 && (idx === -1 || hit < idx)) {
      idx = hit;
    }
  }
  if (idx === -1) return str;
  return str.slice(0, idx).trim();
}

function isReviewComment(comment) {
  const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
  return /\*\*(Suggestion|Warning|Error):\*\*/.test(String(body));
}

async function readInstructionsFile() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const p = cfg.get('instructionsFile', '').trim();
  return readOptionalInstructionsFile(p);
}

async function readGenerationInstructionsFile() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const p = cfg.get('generationInstructionsFile', '').trim();
  return readOptionalInstructionsFile(p);
}

async function readOptionalInstructionsFile(p) {
  if (!p) return '';

  const resolved = resolvePathLike(p);
  if (!resolved) return '';

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
    const text = Buffer.from(bytes).toString('utf8');
    return text.trim();
  } catch {
    // Silent: user may not have the file, and that's fine.
    return '';
  }
}

async function callModelForReview({ code, languageId, instructions }) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const baseUrl = (cfg.get('ollamaBaseUrl', 'http://127.0.0.1:11434/v1') || '').replace(/\/+$/, '');
  const model = cfg.get('model', 'devstral-small-2');

  const system = buildSystemPrompt(instructions);
  const user = buildReviewUserPrompt(code, languageId);
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2
  };

  const json = await postChatCompletions(`${baseUrl}/chat/completions`, body);
  const text = extractAssistantText(json);
  const parsed = safeJsonParse(text);
  return { rawText: text, parsed };
}

async function callModelForFix({ snippet, commentText, languageId, instructions, userResponse, extraContext, reviewContext }) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const baseUrl = (cfg.get('ollamaBaseUrl', 'http://127.0.0.1:11434/v1') || '').replace(/\/+$/, '');
  const model = cfg.get('model', 'devstral-small-2');

  const system = buildFixSystemPrompt(instructions);
  const user = buildFixUserPrompt(snippet, commentText, languageId, userResponse, extraContext, reviewContext);
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2
  };

  const json = await postChatCompletions(`${baseUrl}/chat/completions`, body);
  const rawText = extractAssistantText(json);
  const parsed = safeJsonParse(rawText) || safeJsonParse(extractFirstJsonPayload(rawText));
  return { rawText, parsed };
}

function buildSystemPrompt(instructions) {
  const base = [
    'You are a code review assistant.',
    'Return JSON only, no prose.',
    'Your JSON must include a "comments" array.',
    'Each comment: {"message":"...","startLine":1,"endLine":1,"severity":"info|warning|error","newText":"..."}.',
    'Provide a proposed fix in newText for every comment.',
    'Line numbers are 1-based within the provided snippet.',
    'If you need multiple comments, return multiple items.',
    'Do not return markdown or any extra keys.'
  ];
  if (instructions && instructions.trim()) {
    base.push('', 'EXTRA INSTRUCTIONS:', instructions.trim());
  }
  return base.join('\n');
}

function buildReviewUserPrompt(code, languageId) {
  return [
    'Review the following code and suggest fixes.',
    `Language: ${languageId}`,
    '',
    'CODE START',
    code,
    'CODE END'
  ].join('\n');
}

function buildFixSystemPrompt(instructions) {
  const base = [
    'You are a code assistant.',
    'Given the user feedback and snippet, return JSON only.',
    'Return JSON with {"newText":"..."} only.'
  ];
  if (instructions && instructions.trim()) {
    base.push('', 'EXTRA INSTRUCTIONS:', instructions.trim());
  }
  return base.join('\n');
}

function buildFixUserPrompt(snippet, commentText, languageId, userResponse, extraContext, reviewContext) {
  const parts = [
    'Apply the requested change to the snippet.',
    `Language: ${languageId}`,
    'Return JSON with {"newText":"..."} only.',
    '\nREVIEW COMMENTS:',
    commentText || '(none)'
  ];

  if (userResponse && userResponse.trim()) {
    parts.push('\nUSER RESPONSE:', userResponse.trim());
  }

  if (reviewContext && String(reviewContext).trim()) {
    parts.push(
      '\nREVIEW CONTEXT (read-only):',
      reviewContext
    );
  }

  if (extraContext && String(extraContext).trim()) {
    parts.push(
      '\nDEPENDENCY CONTEXT (read-only):',
      String(extraContext).trim()
    );
  }

  parts.push(
    '\nSNIPPET START',
    snippet,
    'SNIPPET END'
  );

  return parts.join('\n');
}

function normalizeReviewResponse(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (Array.isArray(resp)) return { comments: resp };
  if (Array.isArray(resp.comments)) return { comments: resp.comments };
  if (Array.isArray(resp.comment)) return { comments: resp.comment };
  if (Array.isArray(resp.issues)) return { comments: resp.issues };
  if (Array.isArray(resp.findings)) return { comments: resp.findings };
  return null;
}

function normalizeIndentation(newText, snippet) {
  const newLines = String(newText || '').split(/\r?\n/);
  const oldLines = String(snippet || '').split(/\r?\n/);
  const oldIndent = (oldLines[0] || '').match(/^\s*/)[0];
  const stripped = newLines.map((line) => line.replace(/^\s*/, ''));
  return stripped.map((line) => (line ? oldIndent + line : line)).join('\n');
}

function buildInlineDiff(oldText, newText) {
  const oldLines = String(oldText).split(/\r?\n/);
  const newLines = String(newText).split(/\r?\n/);
  const out = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      out.push(` ${oldLine ?? ''}`);
    } else {
      if (typeof oldLine === 'string') out.push(`-${oldLine}`);
      if (typeof newLine === 'string') out.push(`+${newLine}`);
    }
  }
  return out.join('\n');
}

module.exports = {
  registerReviewFeature,
  clearAllThreads
};
