const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { THREAD_CONTEXT_ADO, ADO_PAT_SECRET_KEY } = require('../helpers/constants');
const { getAdoConfig } = require('../helpers/config');
const { getOutputChannel } = require('../helpers/output');
const { getWorkspaceRoot } = require('../helpers/workspace');
const { normalizeCommentLines } = require('../helpers/context');

const execFileAsync = promisify(execFile);

function registerAdoFeature({ context, controller, threadState }) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.setAdoPat', async () => {
      const pat = await vscode.window.showInputBox({
        prompt: 'CodeCritic: Enter Azure DevOps PAT (stored securely).',
        password: true,
        ignoreFocusOut: true
      });
      if (pat === undefined) return;
      if (!pat.trim()) {
        vscode.window.showErrorMessage('CodeCritic: PAT cannot be empty.');
        return;
      }
      await context.secrets.store(ADO_PAT_SECRET_KEY, pat.trim());
      vscode.window.showInformationMessage('CodeCritic: PAT saved.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.clearAdoPat', async () => {
      await context.secrets.delete(ADO_PAT_SECRET_KEY);
      vscode.window.showInformationMessage('CodeCritic: PAT cleared.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.syncAdoComments', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeCritic: Syncing ADO PR comments...',
          cancellable: false
        },
        async () => syncAdoComments(context, controller, threadState)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.createAdoComment', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      if (!sel || sel.isEmpty) {
        vscode.window.showInformationMessage('CodeCritic: Select a code range to comment on.');
        return;
      }

      const commentText = await vscode.window.showInputBox({
        prompt: 'Create PR comment',
        placeHolder: 'Describe the requested code change...',
        ignoreFocusOut: true
      });
      if (commentText === undefined) return;
      if (!commentText.trim()) {
        vscode.window.showInformationMessage('CodeCritic: Comment text is empty.');
        return;
      }

      const cfg = getAdoConfig();
      const pat = await context.secrets.get(ADO_PAT_SECRET_KEY);
      if (!pat) {
        vscode.window.showErrorMessage('CodeCritic: No ADO PAT found. Run "CodeCritic: Set ADO PAT".');
        return;
      }

      let prId = cfg.prId;
      if (!prId && cfg.autoDetectPrFromBranch) {
        prId = await findAdoPrForCurrentBranch(cfg, pat);
      }
      if (!prId) {
        const input = await vscode.window.showInputBox({
          prompt: 'CodeCritic: Enter Azure DevOps PR ID.',
          placeHolder: 'e.g., 1234',
          ignoreFocusOut: true
        });
        if (input === undefined) return;
        prId = input.trim();
      }
      if (!prId) {
        vscode.window.showErrorMessage('CodeCritic: PR ID is required.');
        return;
      }

      const wsRoot = getWorkspaceRoot();
      if (!wsRoot) {
        vscode.window.showErrorMessage('CodeCritic: Open a workspace folder to create ADO comments.');
        return;
      }

      const relPath = path.relative(wsRoot, editor.document.uri.fsPath).replace(/\\/g, '/');
      const filePath = relPath.startsWith('/') ? relPath : `/${relPath}`;

      let startLine = sel.start.line;
      let endLine = sel.end.line;
      if (sel.end.character === 0 && endLine > startLine) {
        endLine -= 1;
      }

      try {
        const json = await postAdoThread(cfg, pat, prId, {
          filePath,
          startLine,
          endLine,
          content: commentText.trim()
        });

        const threadId = json && json.id != null ? String(json.id) : '';
        const rawComments = Array.isArray(json && json.comments) ? json.comments : [];
        const comments = rawComments.length
          ? rawComments.map((c) => buildAdoComment(c))
          : [buildAdoComment({ content: commentText.trim(), author: { displayName: 'You' } })];

        if (controller) {
          const range = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, editor.document.lineAt(endLine).text.length)
          );
          const vsThread = controller.createCommentThread(editor.document.uri, range, comments);
          vsThread.contextValue = THREAD_CONTEXT_ADO;
          vsThread.label = `ADO PR #${prId}`;
          threadState.adoThreadSet.add(vsThread);
          if (threadId) threadState.adoThreadMeta.set(vsThread, { threadId, prId: String(prId) });
        }

        vscode.window.showInformationMessage('CodeCritic: ADO comment created.');
      } catch (err) {
        const out = getOutputChannel();
        out.appendLine(`ADO create comment failed: ${String(err && err.message ? err.message : err)}`);
        out.show(true);
        vscode.window.showErrorMessage('CodeCritic: Failed to create ADO comment. See output for details.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.replyToAdoComment', async (arg) => {
      const thread = arg && arg.thread ? arg.thread : arg;
      const replyText = arg && typeof arg.text === 'string' ? arg.text : '';
      if (!thread) return;

      const meta = threadState.adoThreadMeta.get(thread);
      if (!meta || !meta.threadId || !meta.prId) {
        vscode.window.showErrorMessage('CodeCritic: ADO thread metadata not found for this comment.');
        return;
      }

      if (!replyText.trim()) {
        vscode.window.showInformationMessage('CodeCritic: Reply text is empty.');
        return;
      }

      const cfg = getAdoConfig();
      const pat = await context.secrets.get(ADO_PAT_SECRET_KEY);
      if (!pat) {
        vscode.window.showErrorMessage('CodeCritic: No ADO PAT found. Run "CodeCritic: Set ADO PAT".');
        return;
      }

      try {
        const json = await postAdoComment(cfg, pat, meta.prId, meta.threadId, replyText.trim());
        const newComment = buildAdoComment(json);
        thread.comments = [...thread.comments, newComment];
        vscode.window.showInformationMessage('CodeCritic: Replied to ADO comment.');
      } catch (err) {
        const out = getOutputChannel();
        out.appendLine(`ADO reply failed: ${String(err && err.message ? err.message : err)}`);
        out.show(true);
        vscode.window.showErrorMessage('CodeCritic: Failed to reply to ADO comment. See output for details.');
      }
    })
  );
}

async function syncAdoComments(context, controller, threadState) {
  const cfg = getAdoConfig();
  if (!cfg.orgUrl || !cfg.project || !cfg.repo) {
    vscode.window.showErrorMessage('CodeCritic: Set ADO org URL, project, and repo in settings.');
    return;
  }
  const pat = await context.secrets.get(ADO_PAT_SECRET_KEY);
  if (!pat) {
    vscode.window.showErrorMessage('CodeCritic: ADO PAT not set. Run "CodeCritic: Set ADO PAT".');
    return;
  }

  let prId = cfg.prId;
  if (!prId && cfg.autoDetectPrFromBranch) {
    prId = await findAdoPrForCurrentBranch(cfg, pat);
  }
  if (!prId) {
    const input = await vscode.window.showInputBox({
      prompt: 'CodeCritic: Enter Azure DevOps PR ID.',
      placeHolder: 'e.g., 1234',
      ignoreFocusOut: true
    });
    if (input === undefined) return;
    prId = input.trim();
  }
  if (!prId) {
    vscode.window.showErrorMessage('CodeCritic: PR ID is required.');
    return;
  }

  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) {
    vscode.window.showErrorMessage('CodeCritic: Open a workspace folder to sync ADO comments.');
    return;
  }

  try {
    const threads = await fetchAdoThreads(cfg, pat, prId);
    if (!Array.isArray(threads) || !threads.length) {
      vscode.window.showInformationMessage('CodeCritic: No ADO comments found.');
      return;
    }

    clearAdoThreads(threadState);

    let posted = 0;
    for (const thread of threads) {
      const docPath = thread && thread.artifactContext && thread.artifactContext.filePath
        ? String(thread.artifactContext.filePath)
        : '';
      if (!docPath) continue;
      const filePath = path.join(wsRoot, docPath.replace(/^\//, ''));
      let doc;
      try {
        doc = await vscode.workspace.openTextDocument(filePath);
      } catch {
        continue;
      }

      const range = buildRangeFromAdoThreadContext(thread.artifactContext, doc);
      if (!range) continue;

      const comments = (thread.comments || [])
        .filter((c) => c && !c.isDeleted && String(c.content || '').trim())
        .map((c) => buildAdoComment(c));

      if (!comments.length) continue;

      const vsThread = controller.createCommentThread(doc.uri, range, comments);
      vsThread.contextValue = THREAD_CONTEXT_ADO;
      vsThread.label = `ADO PR #${prId}`;
      threadState.adoThreadSet.add(vsThread);
      if (thread && thread.id != null) {
        threadState.adoThreadMeta.set(vsThread, { threadId: String(thread.id), prId: String(prId) });
      }
      posted += comments.length;
    }

    vscode.window.showInformationMessage(`CodeCritic: Imported ${posted} ADO comment(s).`);
  } catch (err) {
    const out = getOutputChannel();
    out.appendLine(`ADO sync failed: ${String(err && err.message ? err.message : err)}`);
    out.show(true);
    vscode.window.showErrorMessage('CodeCritic: Failed to fetch ADO comments. See output for details.');
  }
}

function clearAdoThreads(threadState) {
  if (!threadState.adoThreadSet.size) return;
  for (const t of threadState.adoThreadSet) {
    try { t.dispose(); } catch { /* ignore */ }
  }
  threadState.adoThreadSet.clear();
  threadState.adoThreadMeta.clear();
}

function buildRangeFromAdoThreadContext(ctx, doc) {
  if (!ctx) return null;
  const startLineRaw = pickAdoLine(ctx, true);
  if (startLineRaw == null) return null;
  const endLineRaw = pickAdoLine(ctx, false);
  const normalized = normalizeCommentLines(
    { startLine: startLineRaw, endLine: endLineRaw == null ? startLineRaw : endLineRaw },
    0,
    doc.lineCount
  );
  if (!normalized) return null;

  const { safeStart, safeEnd } = normalized;
  return new vscode.Range(
    new vscode.Position(safeStart, 0),
    new vscode.Position(safeEnd, doc.lineAt(safeEnd).text.length)
  );
}

function pickAdoLine(ctx, isStart) {
  const rightKey = isStart ? 'rightFileStart' : 'rightFileEnd';
  const leftKey = isStart ? 'leftFileStart' : 'leftFileEnd';
  const right = ctx[rightKey];
  if (right && typeof right.line === 'number') return right.line;
  const left = ctx[leftKey];
  if (left && typeof left.line === 'number') return left.line;
  return null;
}

function buildAdoComment(c) {
  const authorName = c.author && c.author.displayName ? c.author.displayName : 'ADO';
  const dateText = c.publishedDate ? new Date(c.publishedDate).toLocaleString() : '';
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(`**${escapeMarkdown(authorName)}**`);
  if (dateText) md.appendMarkdown(` _(${escapeMarkdown(dateText)})_`);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(escapeMarkdown(String(c.content || '')));

  const comment = {
    body: md,
    mode: vscode.CommentMode.Preview,
    author: { name: authorName }
  };
  if (c.publishedDate) comment.timestamp = new Date(c.publishedDate);
  return comment;
}

function escapeMarkdown(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`");
}

function buildAdoBaseUrl(cfg) {
  const org = normalizeAdoOrgUrl(cfg.orgUrl);
  const projectRaw = String(cfg.project || '').trim();
  const project = encodeURIComponent(projectRaw);
  if (!project) return org;
  if (orgUrlHasProject(org, project, projectRaw)) return org;
  return `${org}/${project}`;
}

function buildAdoUrl(cfg, pathSuffix, query) {
  const base = buildAdoBaseUrl(cfg);
  const repo = encodeURIComponent(cfg.repo || '');
  let url = `${base}/_apis/git/repositories/${repo}${pathSuffix}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }
  return url;
}

function normalizeAdoOrgUrl(orgUrl) {
  const raw = String(orgUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return encodeURIComponent(decodeURIComponent(segment));
        } catch {
          return encodeURIComponent(segment);
        }
      });
    url.pathname = parts.join('/');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function orgUrlHasProject(orgUrl, projectEncoded, projectRaw) {
  if (!orgUrl) return false;
  const lower = orgUrl.toLowerCase();
  const rawLower = String(projectRaw || '').toLowerCase();
  return lower.endsWith(`/${projectEncoded.toLowerCase()}`) || (rawLower && lower.endsWith(`/${rawLower}`));
}

async function adoRequest(url, pat) {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
  }
  return res.json();
}

async function adoPost(url, pat, body) {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
  }
  return res.json();
}

async function fetchAdoThreads(cfg, pat, prId) {
  const url = buildAdoUrl(cfg, `/pullRequests/${encodeURIComponent(prId)}/threads`, {
    'api-version': '7.1-preview.1'
  });
  const json = await adoRequest(url, pat);
  return Array.isArray(json && json.value) ? json.value : [];
}

async function postAdoComment(cfg, pat, prId, threadId, content) {
  const url = buildAdoUrl(cfg, `/pullRequests/${encodeURIComponent(prId)}/threads/${encodeURIComponent(threadId)}/comments`, {
    'api-version': '7.1-preview.1'
  });
  return adoPost(url, pat, { content, commentType: 1 });
}

async function postAdoThread(cfg, pat, prId, { filePath, startLine, endLine, content }) {
  const body = {
    comments: [{ content, commentType: 1 }],
    status: 1,
    threadContext: {
      filePath,
      leftFileStart: null,
      leftFileEnd: null,
      rightFileStart: { line: startLine, offset: 0 },
      rightFileEnd: { line: endLine, offset: 0 }
    }
  };
  const url = buildAdoUrl(cfg, `/pullRequests/${encodeURIComponent(prId)}/threads`, {
    'api-version': '7.1-preview.1'
  });
  return adoPost(url, pat, body);
}

async function findAdoPrForCurrentBranch(cfg, pat) {
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return '';
  let branch = '';
  try {
    const out = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wsRoot });
    branch = String(out && out.stdout ? out.stdout : '').trim();
  } catch {
    return '';
  }
  if (!branch) return '';

  const url = buildAdoUrl(cfg, '/pullRequests', {
    'searchCriteria.status': 'active',
    'searchCriteria.sourceRefName': `refs/heads/${branch}`,
    'api-version': '7.1-preview.1'
  });
  const json = await adoRequest(url, pat);
  const value = Array.isArray(json && json.value) ? json.value : [];
  if (!value.length) return '';
  return String(value[0].pullRequestId || '');
}

module.exports = {
  registerAdoFeature
};
