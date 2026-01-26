const vscode = require('vscode');
const path = require('path');
let sqlite3;
try {
  sqlite3 = require('sqlite3');
} catch {
  sqlite3 = null;
}

const { isDebugEnabled, getMethodReviewConfig, getChatHistoryCharLimit, getAgentMaxSteps } = require('../helpers/config');
const { getOutputChannel, updateTokenEstimate } = require('../helpers/output');
const { buildMethodDependencyContext, updateSelectionContextsForEdit } = require('../helpers/context');
const { getWorkspaceRoot, resolveWorkspacePathForTool, toWorkspaceRelativePath } = require('../helpers/workspace');
const { safeJsonParse, extractFirstJsonPayload, extractAssistantText, postChatCompletions } = require('../helpers/llm');
const { createToolRunner, limitToolOutput } = require('../tools/agentTools');

/** @type {vscode.ExtensionContext | undefined} */
let extensionContext;
/** @type {vscode.WebviewView | undefined} */
let chatView;
let chatViewInitialized = false;
/** @type {{ mode: 'chat'|'agent', contexts: any[], messages: Array<{ role: 'user'|'assistant', content: string }>, todos: any[], approvals: any[], model?: string }} */
let chatState = { mode: 'chat', contexts: [], messages: [], todos: [], approvals: [], model: '' };
let chatBusy = false;
/** @type {import('sqlite3').Database | undefined} */
let chatDb;
/** @type {Promise<void> | undefined} */
let chatDbReady;
/** @type {Array<{ id: string, title: string, updatedAt: string }>} */
let chatThreads = [];
/** @type {string | null} */
let activeChatThreadId = null;
let chatDbUnavailable = false;
let chatWebviewReady = false;
let toolRunner;
const pendingApprovals = new Map();
const approvalQueue = [];
let todoSeedCache = null;
let stopRequested = false;
let activeAbortController = null;
let agentContinuationMessages = null;
let lastDebugStackItem = null;
let lastDebugSession = null;
let debugListenEnabled = false;
const DEBUG_CONTEXT_ID = 'debug_snapshot_live';
let chatModelOptions = [];

function getToolRunner() {
  if (!toolRunner) {
    toolRunner = createToolRunner({
      vscode,
      getWorkspaceRoot,
      resolveWorkspacePathForTool,
      toWorkspaceRelativePath,
      updateSelectionContextsForEdit,
      requestApproval: requestChatApproval,
      getThreadState: () => registerChatFeature.threadState
    });
  }
  return toolRunner;
}

function getChatWebview() {
  return chatView ? chatView.webview : undefined;
}

function sendToChatWebview(payload) {
  const webview = getChatWebview();
  if (!webview) return false;
  try {
    webview.postMessage(payload);
    return true;
  } catch {
    return false;
  }
}

function requestChatApproval({ title, details, approveLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const id = `approve_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    pendingApprovals.set(id, { resolve });
    const payload = {
      type: 'approval',
      id,
      title: String(title || 'Approve action'),
      details,
      approveLabel: approveLabel || 'Approve',
      cancelLabel: cancelLabel || 'Cancel'
    };
    chatState.approvals = [
      ...(Array.isArray(chatState.approvals) ? chatState.approvals.filter((item) => String(item.id) !== id) : []),
      { ...payload }
    ];
    postChatState();
    if (chatWebviewReady) {
      const sent = sendToChatWebview(payload);
      if (sent) {
        if (isDebugEnabled()) {
          const out = getOutputChannel();
          out.appendLine(`Chat UI: approval sent ${id}`);
        }
        return;
      }
    }
    approvalQueue.push(payload);
    if (isDebugEnabled()) {
      const out = getOutputChannel();
      out.appendLine(`Chat UI: approval queued ${id}`);
    }
  });
}

function flushApprovalQueue() {
  if (!chatWebviewReady || !approvalQueue.length) return;
  const webview = getChatWebview();
  if (!webview) return;
  while (approvalQueue.length) {
    const payload = approvalQueue.shift();
    if (payload) {
      webview.postMessage(payload);
    }
  }
}

function registerChatFeature({ context, threadState }) {
  extensionContext = context;
  loadChatModelPrefs();

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.openChat', async () => {
      await openChatPanel();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeCritic.chatWithSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const text = editor.document.getText(sel);
      if (!text || !text.trim()) {
        vscode.window.showInformationMessage('CodeCritic: No selection to send to chat.');
        return;
      }
      const methodCfg = getMethodReviewConfig();
      const extraContext = await buildMethodDependencyContext(editor.document, sel, methodCfg);
      const contextInfo = buildChatContextFromSelection(editor.document, sel, extraContext);
      await setChatContext(contextInfo, { resetChat: false, append: true });
      await openChatPanel();
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'codeCritic.chatView',
      {
        resolveWebviewView(view) {
          chatView = view;
          chatViewInitialized = true;

          const localRoots = extensionContext
            ? [vscode.Uri.joinPath(extensionContext.extensionUri, 'media')]
            : [];
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: localRoots
          };
          view.webview.html = getChatHtml(view.webview);

          view.webview.onDidReceiveMessage((msg) => {
            void handleChatMessage(msg);
          });

          view.onDidDispose(() => {
            chatView = undefined;
            chatViewInitialized = false;
            chatWebviewReady = false;
          });

          chatWebviewReady = false;
          scheduleChatWebviewPing();
          flushApprovalQueue();
          postChatState();
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.debug.onDidChangeActiveDebugSession((session) => {
      if (session) {
        lastDebugSession = session;
      }
      if (debugListenEnabled) {
        void refreshDebugSnapshot();
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidChangeActiveStackItem((item) => {
      if (item) {
        lastDebugStackItem = item;
        if (item.session) {
          lastDebugSession = item.session;
        }
      }
      if (debugListenEnabled) {
        void refreshDebugSnapshot();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (chatDb) {
        try {
          chatDb.close();
        } catch {
          // ignore
        }
        chatDb = undefined;
      }
    }
  });

  // Expose threadState to tool edits
  registerChatFeature.threadState = threadState;
}

function normalizeModelName(value) {
  return String(value || '').trim();
}

function getConfiguredModel() {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  return normalizeModelName(cfg.get('model', 'devstral-small-2')) || 'devstral-small-2';
}

function getActiveChatModel() {
  return normalizeModelName(chatState.model) || getConfiguredModel();
}

function getChatModelOptions() {
  const list = Array.isArray(chatModelOptions) ? [...chatModelOptions] : [];
  const active = getActiveChatModel();
  const configured = getConfiguredModel();
  if (configured && !list.includes(configured)) list.unshift(configured);
  if (active && !list.includes(active)) list.unshift(active);
  return list;
}

function loadChatModelPrefs() {
  if (!extensionContext) return;
  const storedList = extensionContext.globalState.get('codeCritic.chatModels');
  const list = Array.isArray(storedList)
    ? storedList.map(normalizeModelName).filter(Boolean)
    : [];
  chatModelOptions = list;
  const storedActive = normalizeModelName(extensionContext.globalState.get('codeCritic.chatModel'));
  chatState.model = storedActive || getConfiguredModel();
}

async function setActiveChatModel(nextModel) {
  const cleaned = normalizeModelName(nextModel);
  if (!cleaned) return false;
  chatState.model = cleaned;
  const list = getChatModelOptions();
  if (!list.includes(cleaned)) list.unshift(cleaned);
  chatModelOptions = list;
  if (extensionContext) {
    await extensionContext.globalState.update('codeCritic.chatModel', cleaned);
    await extensionContext.globalState.update('codeCritic.chatModels', chatModelOptions);
  }
  return true;
}

async function openChatPanel() {
  await ensureChatReady();
  await vscode.commands.executeCommand('workbench.view.extension.codeCritic');
  await vscode.commands.executeCommand('codeCritic.chatView.focus');
  if (chatView && chatViewInitialized) {
    if (!chatWebviewReady) {
      scheduleChatWebviewPing();
    } else {
      postChatState();
      flushApprovalQueue();
    }
  }
}

function buildChatContextFromSelection(doc, sel, extraContext) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const maxChars = cfg.get('maxChars', 80000);
  let code = doc.getText(sel);
  if (code.length > maxChars) {
    code = code.slice(0, maxChars) + "\n\n/* ...TRUNCATED... */\n";
    vscode.window.showWarningMessage(`CodeCritic: Truncated selection to ${maxChars.toLocaleString()} chars for chat.`);
  }

  const wsRoot = getWorkspaceRoot();
  const rel = wsRoot && doc.uri.fsPath.startsWith(wsRoot)
    ? path.relative(wsRoot, doc.uri.fsPath).replace(/\\/g, '/')
    : doc.uri.fsPath;

  return {
    id: buildContextId(),
    kind: 'selection',
    title: `${rel}:${sel.start.line + 1}-${sel.end.line + 1}`,
    code,
    languageId: doc.languageId,
    extraContext: String(extraContext || ''),
    filePath: rel,
    selection: { startLine: sel.start.line + 1, endLine: sel.end.line + 1 }
  };
}

function buildContextId() {
  return `ctx_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeContextEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const normalized = { ...entry };
  if (!normalized.id) normalized.id = buildContextId();
  if (!normalized.kind) normalized.kind = normalized.content ? 'note' : 'selection';
  return normalized;
}

function normalizeContextList(input) {
  if (Array.isArray(input)) {
    return input.map(normalizeContextEntry).filter(Boolean);
  }
  if (input && typeof input === 'object') {
    const normalized = normalizeContextEntry(input);
    return normalized ? [normalized] : [];
  }
  return [];
}

async function setChatContext(context, options) {
  await ensureChatReady();
  const nextContexts = normalizeContextList(context);
  if (options && options.append) {
    chatState.contexts = [...chatState.contexts, ...nextContexts];
  } else {
    chatState.contexts = nextContexts;
  }
  if (options && options.resetChat) {
    chatState.messages = [];
    setAgentContinuation(null);
    if (activeChatThreadId) {
      await clearChatMessages(activeChatThreadId);
    }
  }
  if (activeChatThreadId) {
    await updateChatThreadContext(activeChatThreadId, chatState.contexts);
    await touchChatThread(activeChatThreadId);
    await refreshChatThreads();
  }
  postChatState();
}

function buildChatViewState() {
  return {
    mode: chatState.mode,
    contexts: chatState.contexts,
    todos: chatState.todos,
    approvals: chatState.approvals,
    messages: chatState.messages,
    busy: chatBusy,
    threads: chatThreads,
    activeThreadId: activeChatThreadId,
    debugListenEnabled,
    models: getChatModelOptions(),
    activeModel: getActiveChatModel()
  };
}

function postChatState() {
  const webview = getChatWebview();
  if (!webview) return;
  const stateId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = { type: 'state', stateId, state: buildChatViewState() };
  const thenable = webview.postMessage(payload);
  Promise.resolve(thenable).then((ok) => {
    if (!isDebugEnabled()) return;
    const out = getOutputChannel();
    out.appendLine(`Chat UI: post state ${stateId} => ${ok ? 'ok' : 'failed'}`);
    if (chatWebviewReady) {
      flushApprovalQueue();
    }
  }, (err) => {
    const out = getOutputChannel();
    out.appendLine(`Chat UI: post state ${stateId} error: ${String(err && err.message ? err.message : err)}`);
  });
}

function scheduleChatWebviewPing() {
  const webview = getChatWebview();
  if (!webview) return;
  webview.postMessage({ type: 'ping', at: Date.now() });
  setTimeout(() => {
    if (chatWebviewReady) return;
    const out = getOutputChannel();
    out.appendLine('CodeCritic: Chat webview did not initialize (no ready message).');
    out.show(true);
    vscode.window.showWarningMessage('CodeCritic: Chat webview did not initialize. Try reloading the window.');
  }, 2000);
}

async function handleChatMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  chatWebviewReady = true;

  if (msg.type === 'log') {
    const out = getOutputChannel();
    out.appendLine(`Chat UI: ${String(msg.message || '').trim()}`);
    out.show(true);
    return;
  }

  if (msg.type === 'stateAck') {
    if (isDebugEnabled()) {
      const out = getOutputChannel();
      out.appendLine(`Chat UI: state ack ${String(msg.stateId || '')}`);
      out.show(true);
    }
    return;
  }

  if (msg.type === 'ready') {
    chatWebviewReady = true;
    await ensureChatReady();
    flushApprovalQueue();
    postChatState();
    return;
  }

  if (msg.type === 'approvalResponse') {
    const id = String(msg.id || '').trim();
    if (!id) return;
    const entry = pendingApprovals.get(id);
    if (!entry) return;
    pendingApprovals.delete(id);
    chatState.approvals = Array.isArray(chatState.approvals)
      ? chatState.approvals.filter((item) => String(item.id) !== id)
      : [];
    postChatState();
    entry.resolve(Boolean(msg.approved));
    return;
  }

  if (msg.type === 'setMode') {
    if (msg.mode === 'chat' || msg.mode === 'agent') {
      chatState.mode = msg.mode;
      setAgentContinuation(null);
      postChatState();
    }
    return;
  }

  if (msg.type === 'setModel') {
    const model = String(msg.model || '').trim();
    if (model) {
      await setActiveChatModel(model);
      postChatState();
    }
    return;
  }

  if (msg.type === 'manageModel') {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter model name',
      placeHolder: getActiveChatModel(),
      ignoreFocusOut: true
    });
    if (input && input.trim()) {
      await setActiveChatModel(input);
    }
    postChatState();
    return;
  }

  if (msg.type === 'toggleDebugListen') {
    debugListenEnabled = Boolean(msg.enabled);
    if (debugListenEnabled) {
      await refreshDebugSnapshot();
    } else {
      await removeDebugContext();
    }
    postChatState();
    return;
  }

  if (msg.type === 'newThread') {
    await ensureChatReady();
    setAgentContinuation(null);
    const newId = await createChatThread({ title: defaultChatTitle(), context: null, todos: [] });
    if (newId) {
      await loadChatThread(newId);
      await persistActiveChatThreadId();
    }
    if (debugListenEnabled) {
      await refreshDebugSnapshot();
    }
    postChatState();
    return;
  }

  if (msg.type === 'openFile') {
    const rawPath = String(msg.path || '').trim();
    if (!rawPath) return;
    const line = Number.isFinite(Number(msg.line)) ? Math.max(1, Number(msg.line)) : 1;
    const fullPath = resolveWorkspacePathForTool(rawPath);
    if (!fullPath) {
      vscode.window.showInformationMessage('CodeCritic: Unable to open file outside the workspace.');
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (err) {
      vscode.window.showErrorMessage(`CodeCritic: Failed to open file. ${String(err && err.message ? err.message : err)}`);
    }
    return;
  }

  if (msg.type === 'revertChange') {
    const id = String(msg.id || '').trim();
    if (!id) return;
    if (chatBusy) return;
    chatBusy = true;
    postChatState();
    try {
      await ensureChatReady();
      const toolLabel = `Tool call: revert_change ${id}`;
      const result = await getToolRunner().revertChange(id);
      const resultText = formatToolResultForUi('revert_change', limitToolOutput(result, 12000));
      const nextMessages = [
        ...chatState.messages,
        { role: 'assistant', content: toolLabel },
        { role: 'assistant', content: resultText }
      ];
      chatState.messages = nextMessages;
      if (activeChatThreadId) {
        await addChatMessage(activeChatThreadId, 'assistant', toolLabel);
        await addChatMessage(activeChatThreadId, 'assistant', resultText);
        await touchChatThread(activeChatThreadId);
        await refreshChatThreads();
      }
    } catch (err) {
      const out = getOutputChannel();
      out.appendLine(`CodeCritic revert failed: ${String(err && err.message ? err.message : err)}`);
      out.show(true);
      chatState.messages = [
        ...chatState.messages,
        { role: 'assistant', content: 'Error: failed to revert change. See output for details.' }
      ];
      if (activeChatThreadId) {
        await addChatMessage(activeChatThreadId, 'assistant', 'Error: failed to revert change. See output for details.');
        await touchChatThread(activeChatThreadId);
        await refreshChatThreads();
      }
    } finally {
      chatBusy = false;
      postChatState();
    }
    return;
  }

  if (msg.type === 'selectThread') {
    setAgentContinuation(null);
    await selectChatThread(msg.threadId);
    if (debugListenEnabled) {
      await refreshDebugSnapshot();
    }
    return;
  }

  if (msg.type === 'clearChat') {
    await ensureChatReady();
    setAgentContinuation(null);
    chatState.messages = [];
    if (activeChatThreadId) {
      await clearChatMessages(activeChatThreadId);
      await touchChatThread(activeChatThreadId);
      await refreshChatThreads();
    }
    postChatState();
    return;
  }

  if (msg.type === 'clearContext') {
    debugListenEnabled = false;
    await setChatContext([], { resetChat: false });
    return;
  }

  if (msg.type === 'addContextFromSelection') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('CodeCritic: No active editor to pull context from.');
      return;
    }
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    if (!text || !text.trim()) {
      vscode.window.showInformationMessage('CodeCritic: No selection to add as context.');
      return;
    }
    const methodCfg = getMethodReviewConfig();
    const extraContext = await buildMethodDependencyContext(editor.document, sel, methodCfg);
    const contextInfo = buildChatContextFromSelection(editor.document, sel, extraContext);
    await setChatContext(contextInfo, { resetChat: false, append: true });
    return;
  }

  if (msg.type === 'addContextManual') {
    const title = String(msg.title || '').trim();
    const content = String(msg.content || '').trim();
    if (!content) {
      vscode.window.showInformationMessage('CodeCritic: Context text is empty.');
      return;
    }
    const entry = normalizeContextEntry({
      id: buildContextId(),
      kind: 'note',
      title: title || 'Note',
      content
    });
    await setChatContext(entry, { resetChat: false, append: true });
    return;
  }

  if (msg.type === 'removeContext') {
    const id = String(msg.id || '').trim();
    if (!id) return;
    if (id === DEBUG_CONTEXT_ID) {
      debugListenEnabled = false;
    }
    await ensureChatReady();
    chatState.contexts = chatState.contexts.filter((ctx) => String(ctx.id) !== id);
    if (activeChatThreadId) {
      await updateChatThreadContext(activeChatThreadId, chatState.contexts);
      await touchChatThread(activeChatThreadId);
      await refreshChatThreads();
    }
    postChatState();
    return;
  }

  if (msg.type === 'updateContext') {
    const id = String(msg.id || '').trim();
    if (!id) return;
    await ensureChatReady();
    chatState.contexts = chatState.contexts.map((ctx) => {
      if (String(ctx.id) !== id) return ctx;
      const next = { ...ctx };
      if (typeof msg.title === 'string') next.title = String(msg.title);
      if (typeof msg.content === 'string') next.content = String(msg.content);
      if (typeof msg.extraContext === 'string') next.extraContext = String(msg.extraContext);
      return next;
    });
    if (activeChatThreadId) {
      await updateChatThreadContext(activeChatThreadId, chatState.contexts);
      await touchChatThread(activeChatThreadId);
      await refreshChatThreads();
    }
    postChatState();
    return;
  }

  if (msg.type === 'send') {
    const text = String(msg.text || '').trim();
    if (!text) return;
    if (chatBusy) return;
    const isContinuation = isContinuationRequest(text);
    const continuationMessages = isContinuation ? agentContinuationMessages : null;
    if (!isContinuation) {
      setAgentContinuation(null);
    }
    stopRequested = false;
    await ensureChatReady();
    if (chatState.mode === 'agent') {
      const seeded = seedTodosFromPrompt(text);
      if (seeded && seeded.length) {
        await applyTodoUpdate(seeded);
        todoSeedCache = seeded;
      } else {
        todoSeedCache = null;
      }
    }
    if (!activeChatThreadId && chatDb) {
      activeChatThreadId = await createChatThread({
        title: defaultChatTitle(),
        context: chatState.contexts,
        todos: chatState.todos
      });
      await persistActiveChatThreadId();
    }
    chatBusy = true;
    postChatState();

    try {
      const threadId = activeChatThreadId;
      const userMessage = { role: 'user', content: text };
      const baseMessages = [...chatState.messages, userMessage];
      chatState.messages = baseMessages;
      postChatState();

      if (threadId) {
        await addChatMessage(threadId, 'user', text);
        await maybeUpdateThreadTitleFromMessage(threadId, text);
        await touchChatThread(threadId);
        await refreshChatThreads();
      }

      if (chatState.mode === 'agent') {
        const debugCmd = parseDebuggerCommand(text);
        const searchCmd = !debugCmd ? parseSearchCommand(text) : null;
        const symbolsCmd = !debugCmd && !searchCmd ? parseSymbolsCommand(text) : null;
        const commandType = debugCmd ? 'debugger' : (searchCmd ? 'search' : (symbolsCmd ? 'symbols' : ''));
        const commandQuery = debugCmd
          ? debugCmd.query
          : (searchCmd ? searchCmd.query : (symbolsCmd ? symbolsCmd.query : ''));

        const commandMessages = [];
        if (debugCmd) {
          const debuggerPayload = await buildDebuggerContextMessage(debugCmd.sessionFilter);
          commandMessages.push({ role: 'assistant', content: debuggerPayload });
        } else if (searchCmd) {
          const searchPayload = await buildSearchContextMessage(searchCmd.query);
          commandMessages.push({ role: 'assistant', content: searchPayload });
        } else if (symbolsCmd) {
          const symbolsPayload = await buildSymbolsContextMessage(symbolsCmd.query);
          commandMessages.push({ role: 'assistant', content: symbolsPayload });
        }

        const baseWithTools = commandMessages.length ? [...baseMessages, ...commandMessages] : baseMessages;
        if (commandMessages.length) {
          chatState.messages = baseWithTools;
          postChatState();
          if (threadId) {
            for (const toolMsg of commandMessages) {
              await addChatMessage(threadId, 'assistant', toolMsg.content);
            }
            await touchChatThread(threadId);
            await refreshChatThreads();
          }
        }

        const historyLimit = getChatHistoryCharLimit();
        const defaultQuery = commandType === 'debugger'
          ? 'Analyze the current debugger context.'
          : (commandType === 'search'
            ? 'Use the search results above.'
            : (commandType === 'symbols' ? 'Use the symbol search results above.' : ''));
        let modelSeed = [];
        if (continuationMessages && continuationMessages.length) {
          const userForModel = commandType
            ? { ...userMessage, content: commandQuery || defaultQuery }
            : userMessage;
          modelSeed = [...continuationMessages, userForModel];
          if (commandMessages.length) {
            const commandAsUser = commandMessages.map((msg) => ({ role: 'user', content: msg.content }));
            modelSeed = [...commandAsUser, ...modelSeed];
          }
        } else {
          let seedSource = baseWithTools;
          if (commandType) {
            const cloned = [...baseWithTools];
            const userIndex = baseMessages.length - 1;
            if (userIndex >= 0 && cloned[userIndex] && cloned[userIndex].role === 'user') {
              cloned[userIndex] = {
                ...cloned[userIndex],
                content: commandQuery || defaultQuery
              };
            }
            seedSource = cloned;
          }
          const modelBase = buildAgentModelMessages(seedSource);
          if (commandMessages.length) {
            const commandSet = new Set(commandMessages.map((msg) => msg.content));
            const commandAsUser = commandMessages.map((msg) => ({ role: 'user', content: msg.content }));
            const withoutCommand = modelBase.filter((msg) => !(msg && msg.role === 'user' && commandSet.has(msg.content)));
            modelSeed = [...commandAsUser, ...withoutCommand];
          } else {
            modelSeed = modelBase;
          }
        }

        const modelMessages = trimChatMessagesForModel(modelSeed, historyLimit);
        const beforeCount = baseWithTools.length;
        await runAgentTurn(baseWithTools, modelMessages);
        const newMessages = chatState.messages.slice(beforeCount);
        if (threadId) {
          for (const newMsg of newMessages) {
            await addChatMessage(threadId, newMsg.role, newMsg.content);
          }
          await touchChatThread(threadId);
          await refreshChatThreads();
        }
      } else {
        setAgentContinuation(null);
        const debugCmd = parseDebuggerCommand(text);
        const searchCmd = !debugCmd ? parseSearchCommand(text) : null;
        const symbolsCmd = !debugCmd && !searchCmd ? parseSymbolsCommand(text) : null;
        const commandType = debugCmd ? 'debugger' : (searchCmd ? 'search' : (symbolsCmd ? 'symbols' : ''));
        const commandQuery = debugCmd
          ? debugCmd.query
          : (searchCmd ? searchCmd.query : (symbolsCmd ? symbolsCmd.query : ''));

        const commandMessages = [];
        if (debugCmd) {
          const debuggerPayload = await buildDebuggerContextMessage(debugCmd.sessionFilter);
          commandMessages.push({ role: 'assistant', content: debuggerPayload });
        } else if (searchCmd) {
          const searchPayload = await buildSearchContextMessage(searchCmd.query);
          commandMessages.push({ role: 'assistant', content: searchPayload });
        } else if (symbolsCmd) {
          const symbolsPayload = await buildSymbolsContextMessage(symbolsCmd.query);
          commandMessages.push({ role: 'assistant', content: symbolsPayload });
        }

        const smartSearchMessages = commandType ? [] : await buildSmartSearchMessages(text);
        const toolMessages = commandMessages.length || smartSearchMessages.length
          ? [...commandMessages, ...smartSearchMessages]
          : [];
        const baseWithTools = toolMessages.length ? [...baseMessages, ...toolMessages] : baseMessages;
        if (toolMessages.length) {
          chatState.messages = baseWithTools;
          postChatState();
          if (threadId) {
            for (const toolMsg of toolMessages) {
              await addChatMessage(threadId, 'assistant', toolMsg.content);
            }
            await touchChatThread(threadId);
            await refreshChatThreads();
          }
        }

        const historyLimit = getChatHistoryCharLimit();
        const defaultQuery = commandType === 'debugger'
          ? 'Analyze the current debugger context.'
          : (commandType === 'search'
            ? 'Use the search results above.'
            : (commandType === 'symbols' ? 'Use the symbol search results above.' : ''));
        const modelInput = commandType
          ? (() => {
            const cloned = [...baseWithTools];
            const userIndex = baseWithTools.length - toolMessages.length - 1;
            if (userIndex >= 0 && cloned[userIndex] && cloned[userIndex].role === 'user') {
              cloned[userIndex] = {
                ...cloned[userIndex],
                content: commandQuery || defaultQuery
              };
            }
            if (commandMessages.length) {
              const commandSet = new Set(commandMessages.map((msg) => msg.content));
              const withoutCommand = cloned.filter(
                (msg) => !(msg && msg.role === 'assistant' && commandSet.has(msg.content))
              );
              return [...commandMessages, ...withoutCommand];
            }
            return cloned;
          })()
          : baseWithTools;
        const modelMessages = trimChatMessagesForModel(modelInput, historyLimit);
        const assistantText = await callModelForChat({
          messages: modelMessages,
          mode: chatState.mode,
          context: chatState.contexts
        });
        const trimmedAssistant = String(assistantText || '').trim();
        if (!trimmedAssistant) {
          const content = 'Error: model returned an empty response. Try another model or check the endpoint.';
          chatState.messages = [...baseWithTools, { role: 'assistant', content }];
          if (threadId) {
            await addChatMessage(threadId, 'assistant', content);
            await touchChatThread(threadId);
            await refreshChatThreads();
          }
          return;
        }
        let parsed = parseAgentResponse(assistantText);
        if (!parsed) {
          parsed = parseTaggedToolCalls(assistantText) || extractToolCallsFromText(assistantText);
        }
        const todoExtraction = extractTodoFromText(assistantText);
        const extractedTodo = todoExtraction ? todoExtraction.todo : null;
        const displayText = todoExtraction
          ? stripTodoJsonFromText(assistantText, todoExtraction.range)
          : assistantText;
        if (parsed && parsed.toolCalls && parsed.toolCalls.length) {
          const toolMessages = [];
          for (const call of parsed.toolCalls) {
            const normalizedCall = normalizeToolCall(call);
            const toolLabel = describeToolCall(normalizedCall);
            toolMessages.push({ role: 'assistant', content: toolLabel });
            const result = await runToolCall(normalizedCall);
            const resultText = formatToolResultForUi(normalizedCall.tool, limitToolOutput(result, 12000));
            toolMessages.push({ role: 'assistant', content: resultText });
          }
          chatState.messages = [...baseWithTools, ...toolMessages];
          if (threadId) {
            for (const toolMsg of toolMessages) {
              await addChatMessage(threadId, 'assistant', toolMsg.content);
            }
            await touchChatThread(threadId);
            await refreshChatThreads();
          }
        } else {
          if (parsed && parsed.todo) {
            await applyTodoUpdate(parsed.todo);
          } else if (extractedTodo) {
            await applyTodoUpdate(extractedTodo);
          }
          const cleanedDisplay = displayText && displayText.trim() ? displayText : '';
          let content = parsed && parsed.final
            ? parsed.final
            : (cleanedDisplay ? cleanedDisplay : '(empty response)');
          const isBareTodo = parsed && parsed.todo
            ? isBareTodoResponse(parsed, assistantText)
            : (extractedTodo && !cleanedDisplay);
          if (isBareTodo) {
            chatState.messages = baseWithTools;
            if (threadId) {
              await touchChatThread(threadId);
              await refreshChatThreads();
            }
          } else {
            chatState.messages = [...baseWithTools, { role: 'assistant', content }];
            if (threadId) {
              await addChatMessage(threadId, 'assistant', content);
              await touchChatThread(threadId);
              await refreshChatThreads();
            }
          }
        }
      }
    } catch (err) {
      if (stopRequested || (err && err.name === 'AbortError')) {
        stopRequested = false;
        chatBusy = false;
        postChatState();
        return;
      }
      const out = getOutputChannel();
      out.appendLine(`CodeCritic chat failed: ${String(err && err.message ? err.message : err)}`);
      out.show(true);
      const fallback = [
        ...chatState.messages,
        { role: 'assistant', content: 'Error: failed to get response. See output for details.' }
      ];
      chatState.messages = fallback;
      if (activeChatThreadId) {
        await addChatMessage(activeChatThreadId, 'assistant', 'Error: failed to get response. See output for details.');
        await touchChatThread(activeChatThreadId);
        await refreshChatThreads();
      }
    } finally {
      chatBusy = false;
      postChatState();
    }
  }

  if (msg.type === 'stop') {
    stopRequested = true;
    setAgentContinuation(null);
    if (activeAbortController) {
      try { activeAbortController.abort(); } catch { /* ignore */ }
    }
    for (const entry of pendingApprovals.values()) {
      try { entry.resolve(false); } catch { /* ignore */ }
    }
    pendingApprovals.clear();
    chatState.approvals = [];
    chatBusy = false;
    chatState.messages = [...chatState.messages, { role: 'assistant', content: 'Stopped.' }];
    postChatState();
    return;
  }
}

function parseDebuggerCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('/debugger')) return null;
  const rest = raw.slice('/debugger'.length).trim();
  if (!rest) return { query: '', sessionFilter: '' };
  const sessionMatch = /^session[:=]("([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/.exec(rest);
  if (sessionMatch) {
    const sessionFilter = sessionMatch[2] || sessionMatch[3] || sessionMatch[4] || '';
    const query = sessionMatch[5] || '';
    return { query, sessionFilter };
  }
  return { query: rest, sessionFilter: '' };
}

function parseSearchCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('/search')) return null;
  const rest = raw.slice('/search'.length).trim();
  return { query: rest };
}

function parseSymbolsCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('/symbols')) return null;
  const rest = raw.slice('/symbols'.length).trim();
  return { query: rest };
}

function formatSourceSnippet(sourceText, lineNumber, contextLines = 6) {
  const lines = String(sourceText || '').split(/\r?\n/);
  if (!lines.length) return '';
  const line = Number(lineNumber || 1);
  const start = Math.max(1, line - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  const width = String(end).length;
  const out = [];
  for (let i = start; i <= end; i += 1) {
    const marker = i === line ? '>' : ' ';
    out.push(`${marker} ${String(i).padStart(width, ' ')} | ${lines[i - 1]}`);
  }
  return out.join('\n');
}

async function collectDebuggerSnapshot(sessionFilter = '') {
  const activeItem = vscode.debug.activeStackItem || lastDebugStackItem;
  let session = (activeItem && activeItem.session) ? activeItem.session : null;
  if (!session && activeItem && typeof activeItem.customRequest === 'function') {
    session = activeItem;
  }
  if (!session) session = vscode.debug.activeDebugSession || lastDebugSession;
  const allSessions = Array.isArray(vscode.debug.sessions) ? vscode.debug.sessions : [];
  if (!session && !allSessions.length) {
    return { ok: false, text: 'No active debug session.' };
  }

  let thread = null;
  let frame = null;
  if (activeItem && typeof activeItem.line === 'number' && activeItem.source) {
    frame = activeItem;
    if (activeItem.threadId) {
      thread = { id: activeItem.threadId, name: 'Active thread' };
    }
  } else if (activeItem && typeof activeItem.id === 'number') {
    thread = activeItem;
  }

  function sessionMatchesFilter(target) {
    if (!sessionFilter) return true;
    const needle = String(sessionFilter || '').toLowerCase();
    const name = String(target && target.name ? target.name : '').toLowerCase();
    const type = String(target && target.type ? target.type : '').toLowerCase();
    return name.includes(needle) || type.includes(needle);
  }

  async function resolveFrameForSession(targetSession, diagnostics) {
    if (!targetSession) return null;
    const info = {
      id: targetSession.id,
      name: targetSession.name || targetSession.type || 'debug session',
      type: targetSession.type || 'unknown',
      threads: 0,
      stackTraces: [],
      errors: []
    };

    let localThread = null;
    let localFrame = null;
    let threads = [];

    if (thread && frame) {
      diagnostics.push(info);
      return { session: targetSession, thread, frame };
    }

    if (thread && thread.id) {
      try {
        let stackResp = await targetSession.customRequest('stackTrace', {
          threadId: thread.id,
          startFrame: 0,
          levels: 20
        });
        let frames = stackResp && Array.isArray(stackResp.stackFrames) ? stackResp.stackFrames : [];
        info.stackTraces.push(`thread ${thread.id}: ${frames.length} frame(s)`);
        if (!frames.length) {
          stackResp = await targetSession.customRequest('stackTrace', {
            threadId: thread.id,
            startFrame: 0,
            levels: 50
          });
          frames = stackResp && Array.isArray(stackResp.stackFrames) ? stackResp.stackFrames : [];
          info.stackTraces.push(`thread ${thread.id} (extended): ${frames.length} frame(s)`);
        }
        if (frames.length) {
          diagnostics.push(info);
          return { session: targetSession, thread, frame: frames[0] };
        }
      } catch (err) {
        info.errors.push(`stackTrace(${thread.id}) failed: ${String(err && err.message ? err.message : err)}`);
      }
    }

    try {
      const threadsResp = await targetSession.customRequest('threads');
      threads = threadsResp && Array.isArray(threadsResp.threads) ? threadsResp.threads : [];
      info.threads = threads.length;
    } catch (err) {
      info.errors.push(`threads failed: ${String(err && err.message ? err.message : err)}`);
      diagnostics.push(info);
      return null;
    }

    for (const candidate of threads.slice(0, 5)) {
      if (!candidate || !candidate.id) continue;
      try {
        const stackResp = await targetSession.customRequest('stackTrace', {
          threadId: candidate.id,
          startFrame: 0,
          levels: 50
        });
        const frames = stackResp && Array.isArray(stackResp.stackFrames) ? stackResp.stackFrames : [];
        info.stackTraces.push(`thread ${candidate.id}: ${frames.length} frame(s)`);
        if (frames.length) {
          localThread = candidate;
          localFrame = frames[0];
          break;
        }
      } catch (err) {
        info.errors.push(`stackTrace(${candidate.id}) failed: ${String(err && err.message ? err.message : err)}`);
      }
    }

    diagnostics.push(info);

    if (localFrame) {
      return { session: targetSession, thread: localThread, frame: localFrame };
    }
    return null;
  }

  const sessionCandidates = [];
  if (session) sessionCandidates.push(session);
  if (vscode.debug.activeDebugSession) sessionCandidates.push(vscode.debug.activeDebugSession);
  if (lastDebugSession) sessionCandidates.push(lastDebugSession);
  for (const s of allSessions) sessionCandidates.push(s);

  const seenSessions = new Set();
  const diagnostics = [];
  let resolved = null;
  for (const candidate of sessionCandidates) {
    if (!candidate || seenSessions.has(candidate.id)) continue;
    if (!sessionMatchesFilter(candidate)) continue;
    seenSessions.add(candidate.id);
    const result = await resolveFrameForSession(candidate, diagnostics);
    if (result && result.frame) {
      resolved = result;
      break;
    }
  }

  if (!resolved && sessionFilter) {
    const available = allSessions.map((s) => s.name || s.type || s.id).filter(Boolean);
    const list = available.length ? available.join(', ') : '(none)';
    return { ok: false, text: `No sessions matched filter "${sessionFilter}". Available sessions: ${list}` };
  }

  if (resolved) {
    session = resolved.session;
    thread = resolved.thread;
    frame = resolved.frame;
  }

  if (!frame) {
    const sessionName = session ? (session.name || session.type || 'debug session') : 'debug session';
    const threadCount = thread ? 1 : 0;
    const hint = activeItem ? 'Active stack item was present but not a frame.' : 'No active stack item.';
    const diagLines = diagnostics.length
      ? diagnostics.map((entry) => {
        const traces = entry.stackTraces.length ? ` | ${entry.stackTraces.join('; ')}` : '';
        const errors = entry.errors.length ? ` | errors: ${entry.errors.join('; ')}` : '';
        return `- ${entry.name} (${entry.type}) threads=${entry.threads}${traces}${errors}`;
      }).join('\n')
      : '(no diagnostics)';
    return {
      ok: false,
      text: `No stack frame available. Active session: ${sessionName}. Thread count: ${threadCount}. ${hint} Is the debugger paused on a breakpoint?\nDiagnostics:\n${diagLines}`
    };
  }

  const lines = [];
  const sessionName = session.name || session.type || 'debug session';
  lines.push(`Debug session: ${sessionName} (${session.type || 'unknown'})`);
  if (thread && thread.id) {
    lines.push(`Thread: ${thread.name || thread.id} (id ${thread.id})`);
  }

  const src = frame.source || {};
  const lineNumber = Number(frame.line || 1);
  const columnNumber = Number(frame.column || 1);
  const displayPath = src.path || src.name || '(unknown source)';
  const relPath = src.path ? toWorkspaceRelativePath(src.path) : displayPath;
  lines.push(`Frame: ${frame.name || '(anonymous)'} at ${relPath}:${lineNumber}:${columnNumber}`);

  let snippet = '';
  if (src.path) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(src.path));
      snippet = formatSourceSnippet(doc.getText(), lineNumber, 6);
    } catch {
      snippet = '';
    }
  } else if (src.sourceReference) {
    try {
      const sourceResp = await session.customRequest('source', { sourceReference: src.sourceReference });
      if (sourceResp && typeof sourceResp.content === 'string') {
        snippet = formatSourceSnippet(sourceResp.content, lineNumber, 6);
      }
    } catch {
      snippet = '';
    }
  }

  if (snippet) {
    lines.push('', 'Source snippet:', snippet);
  } else {
    lines.push('', 'Source snippet: (unavailable)');
  }

  const frameId = Number.isFinite(Number(frame.id)) ? Number(frame.id) : Number(frame.frameId);
  try {
    if (!Number.isFinite(frameId)) {
      throw new Error('Missing frame id');
    }
    const scopesResp = await session.customRequest('scopes', { frameId });
    const scopes = scopesResp && Array.isArray(scopesResp.scopes) ? scopesResp.scopes : [];
    if (scopes.length) {
      lines.push('', 'Scopes:');
      for (const scope of scopes.slice(0, 4)) {
        lines.push(`- ${scope.name || 'Scope'}:`);
        if (!scope.variablesReference) {
          lines.push('  (no variables)');
          continue;
        }
        let varsResp;
        try {
          varsResp = await session.customRequest('variables', {
            variablesReference: scope.variablesReference,
            start: 0,
            count: 50
          });
        } catch {
          lines.push('  (failed to read variables)');
          continue;
        }
        const vars = varsResp && Array.isArray(varsResp.variables) ? varsResp.variables : [];
        const maxVars = 20;
        for (const variable of vars.slice(0, maxVars)) {
          const name = variable.name || '(unnamed)';
          const value = typeof variable.value === 'string' ? variable.value : String(variable.value || '');
          const type = variable.type ? `: ${variable.type}` : '';
          lines.push(`  - ${name}${type} = ${value}`);
        }
        if (vars.length > maxVars) {
          lines.push(`  ...and ${vars.length - maxVars} more`);
        }
      }
    }
  } catch {
    lines.push('', 'Scopes: (unavailable)');
  }

  return { ok: true, text: lines.join('\n') };
}

async function buildDebuggerContextMessage(sessionFilter = '') {
  const snapshot = await collectDebuggerSnapshot(sessionFilter);
  return formatToolResultForUi('debugger', snapshot.text);
}

async function buildSearchContextMessage(query) {
  const text = String(query || '').trim();
  const result = await getToolRunner().toolSearch({
    query: text,
    include: '**/*',
    exclude: '**/node_modules/**',
    maxResults: 20
  });
  return formatToolResultForUi('search', result);
}

async function buildSymbolsContextMessage(query) {
  const text = String(query || '').trim();
  const result = await getToolRunner().toolSearchSymbols({ query: text, maxResults: 20 });
  return formatToolResultForUi('search_symbols', result);
}

async function upsertDebugContext(content) {
  await ensureChatReady();
  const entry = {
    id: DEBUG_CONTEXT_ID,
    kind: 'note',
    title: debugListenEnabled ? 'Debug Snapshot (live)' : 'Debug Snapshot',
    content: String(content || '').trim()
  };
  const hasEntry = chatState.contexts.some((ctx) => String(ctx.id) === DEBUG_CONTEXT_ID);
  chatState.contexts = hasEntry
    ? chatState.contexts.map((ctx) => (String(ctx.id) === DEBUG_CONTEXT_ID ? entry : ctx))
    : [...chatState.contexts, entry];
  if (activeChatThreadId) {
    await updateChatThreadContext(activeChatThreadId, chatState.contexts);
    await touchChatThread(activeChatThreadId);
    await refreshChatThreads();
  }
  postChatState();
}

async function removeDebugContext() {
  await ensureChatReady();
  const next = chatState.contexts.filter((ctx) => String(ctx.id) !== DEBUG_CONTEXT_ID);
  chatState.contexts = next;
  if (activeChatThreadId) {
    await updateChatThreadContext(activeChatThreadId, chatState.contexts);
    await touchChatThread(activeChatThreadId);
    await refreshChatThreads();
  }
  postChatState();
}

async function refreshDebugSnapshot() {
  if (!debugListenEnabled) return;
  try {
    const snapshot = await collectDebuggerSnapshot();
    const text = snapshot && snapshot.text ? snapshot.text : '(empty debug snapshot)';
    await upsertDebugContext(text);
  } catch (err) {
    const message = `Debug snapshot failed: ${String(err && err.message ? err.message : err)}`;
    await upsertDebugContext(message);
  }
}

function buildChatContextBlock(contexts) {
  const list = normalizeContextList(contexts);
  if (!list.length) return '';
  const blocks = [];
  for (const ctx of list) {
    const headerParts = [];
    const title = ctx.title || ctx.filePath || ctx.kind || 'Context';
    headerParts.push(`Context: ${title}`);
    if (ctx.filePath) headerParts.push(`File: ${ctx.filePath}`);
    if (ctx.languageId) headerParts.push(`Language: ${ctx.languageId}`);
    if (ctx.selection) {
      headerParts.push(`Selection: lines ${ctx.selection.startLine}-${ctx.selection.endLine}`);
    }
    const blockParts = [...headerParts];
    if (ctx.code && String(ctx.code).trim()) {
      blockParts.push('Selected code:', String(ctx.code).trim());
    }
    if (ctx.extraContext && String(ctx.extraContext).trim()) {
      blockParts.push('Additional context:', String(ctx.extraContext).trim());
    }
    if (ctx.content && String(ctx.content).trim()) {
      blockParts.push('Notes:', String(ctx.content).trim());
    }
    blocks.push(blockParts.join('\n'));
  }
  return blocks.join('\n\n');
}

function buildChatSystemPrompt(context) {
  const base = [
    'You are a helpful coding assistant.',
    'Answer the user clearly and directly.',
    'Use the provided context when relevant.',
    'Do not perform a code review unless the user explicitly asks.',
	'',
    'You can use tools to inspect but not modify the workspace. Respond with JSON only.',
	'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
    'Tool schema:',
    '{"toolCalls":[{"tool":"search","args":{"query":"text","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"locate_file","args":{"query":"about.md","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"search_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"workspace_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"document_symbols","args":{"uri":"src/App.jsx"}}]}',
    '{"toolCalls":[{"tool":"definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"type_definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"implementation","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"references","args":{"uri":"src/App.jsx","line":10,"character":5,"includeDeclaration":true}}]}',
    '{"toolCalls":[{"tool":"hover","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"signature_help","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_prepare","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_incoming","args":{"itemId":"chi_123"}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_outgoing","args":{"itemId":"chi_123"}}]}',
    '{"toolCalls":[{"tool":"semantic_tokens","args":{"uri":"src/App.jsx","range":{"startLine":1,"startCharacter":1,"endLine":50,"endCharacter":1}}}]}',
    '{"toolCalls":[{"tool":"read_file","args":{"path":"relative/path","startLine":1,"endLine":200}}]}',
    '{"toolCalls":[{"tool":"read_files","args":{"paths":["src/App.jsx","src/main.jsx"],"ranges":[{"startLine":1,"endLine":200},{"startLine":1,"endLine":200}]}}]}',
    '{"toolCalls":[{"tool":"read_file_range_by_symbols","args":{"path":"relative/path","symbols":["Foo","Bar"],"maxChars":12000}}]}',
    '{"toolCalls":[{"tool":"list_files","args":{"include":"**/*","exclude":"**/node_modules/**","maxResults":200}}]}',
    '{"toolCalls":[{"tool":"file_stat","args":{"path":"relative/path"}}]}',
    '{"toolCalls":[{"tool":"read_dir","args":{"path":"relative/path","maxDepth":3,"maxEntries":400}}]}',
    '{"toolCalls":[{"tool":"read_output","args":{"maxChars":12000,"tail":true}}]}',
    'When done, respond with {"final":"..."} and no other text.',
    'If no tool is needed, respond with {"final":"..."}.'
  ];
  const ctx = buildChatContextBlock(context);
  if (ctx) {
    base.push('', 'CONTEXT:', ctx);
  }
  return base.join('\n');
}

function buildAgentSystemPrompt(context) {
  const base = [
    'You are a coding agent.',
    'Provide a concise plan and actionable steps.',
    'If you propose code changes, include file paths and minimal patches or snippets.',
    'Ask a clarifying question if required.',
    'Do not perform a code review unless the user explicitly asks.',
    '',
    'You can use tools to inspect and modify the workspace. Respond with JSON only.',
    'Prefer non-interactive commands (use flags like --yes). Keep commands scoped to the workspace.',
    'After making changes, verify the workspace state (a tree and file list may be provided) before returning the final response.',
    'If workspace problems are provided, attempt to resolve them before finishing when possible.',
    'Maintain a TODO list in your JSON responses using {"todo":[{"id":"1","text":"...","status":"pending|done"}]}. Update statuses as you complete steps.',
    'When using edit_file or replace_range, set newText to ONLY the replacement lines for the specified range.',
    'Do not include unchanged context lines before/after the range, and do not re-emit entire functions/files for small edits.',
    'Avoid duplicate imports or JSX blocks; when adding an import, insert only the new line.',
    'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
    'Tool schema:',
    '{"toolCalls":[{"tool":"search","args":{"query":"text","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"locate_file","args":{"query":"about.md","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"search_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"workspace_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
    '{"toolCalls":[{"tool":"document_symbols","args":{"uri":"src/App.jsx"}}]}',
    '{"toolCalls":[{"tool":"definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"type_definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"implementation","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"references","args":{"uri":"src/App.jsx","line":10,"character":5,"includeDeclaration":true}}]}',
    '{"toolCalls":[{"tool":"hover","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"signature_help","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_prepare","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_incoming","args":{"itemId":"chi_123"}}]}',
    '{"toolCalls":[{"tool":"call_hierarchy_outgoing","args":{"itemId":"chi_123"}}]}',
    '{"toolCalls":[{"tool":"rename_prepare","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
    '{"toolCalls":[{"tool":"rename_apply","args":{"uri":"src/App.jsx","line":10,"character":5,"newName":"newSymbolName"}}]}',
    '{"toolCalls":[{"tool":"semantic_tokens","args":{"uri":"src/App.jsx","range":{"startLine":1,"startCharacter":1,"endLine":50,"endCharacter":1}}}]}',
    '{"toolCalls":[{"tool":"read_file","args":{"path":"relative/path","startLine":1,"endLine":200}}]}',
    '{"toolCalls":[{"tool":"read_files","args":{"paths":["src/App.jsx","src/main.jsx"],"ranges":[{"startLine":1,"endLine":200},{"startLine":1,"endLine":200}]}}]}',
    '{"toolCalls":[{"tool":"read_file_range_by_symbols","args":{"path":"relative/path","symbols":["Foo","Bar"],"maxChars":12000}}]}',
    '{"toolCalls":[{"tool":"edit_file","args":{"path":"relative/path","startLine":1,"endLine":5,"newText":"replacement text"}}]}',
    '{"toolCalls":[{"tool":"insert_text","args":{"path":"relative/path","position":{"line":10,"character":5},"text":"text to insert"}}]}',
    '{"toolCalls":[{"tool":"replace_range","args":{"path":"relative/path","range":{"startLine":10,"startChar":1,"endLine":12,"endChar":1},"text":"replacement text"}}]}',
    '{"toolCalls":[{"tool":"copy_file","args":{"from":"relative/path","to":"relative/path","overwrite":false}}]}',
    '{"toolCalls":[{"tool":"apply_patch_preview","args":{"patch":"diff content","cwd":"."}}]}',
    '{"toolCalls":[{"tool":"apply_patch","args":{"patch":"diff content","cwd":"."}}]}',
    '{"toolCalls":[{"tool":"list_files","args":{"include":"**/*","exclude":"**/node_modules/**","maxResults":200}}]}',
    '{"toolCalls":[{"tool":"file_stat","args":{"path":"relative/path"}}]}',
    '{"toolCalls":[{"tool":"write_file","args":{"path":"relative/path","content":"text","overwrite":false,"append":false}}]}',
    '{"toolCalls":[{"tool":"create_dir","args":{"path":"relative/path"}}]}',
    '{"toolCalls":[{"tool":"delete_file","args":{"path":"relative/path","recursive":false}}]}',
    '{"toolCalls":[{"tool":"move_file","args":{"from":"relative/path","to":"relative/path","overwrite":false}}]}',
    '{"toolCalls":[{"tool":"read_dir","args":{"path":"relative/path","maxDepth":3,"maxEntries":400}}]}',
    '{"toolCalls":[{"tool":"read_output","args":{"maxChars":12000,"tail":true}}]}',
    '{"toolCalls":[{"tool":"run_command","args":{"command":"npm create vite@latest app -- --template react","cwd":".","timeoutMs":60000}}]}',
    'When done, respond with {"final":"..."} and no other text.',
    'If no tool is needed, respond with {"final":"..."}.'
  ];
  const ctx = buildChatContextBlock(context);
  if (ctx) {
    base.push('', 'CONTEXT:', ctx);
  }
  return base.join('\n');
}

function parseAgentResponse(text) {
  const parsed = safeJsonParse(text) || safeJsonParse(extractFirstJsonPayload(text));
  if (!parsed || typeof parsed !== 'object') return null;
  const todo = Array.isArray(parsed.todo) ? parsed.todo : (Array.isArray(parsed.todos) ? parsed.todos : null);
  const normalizedTodo = todo ? normalizeTodoList(todo) : null;
  if (typeof parsed.final === 'string') return { final: parsed.final, todo: normalizedTodo };
  if (typeof parsed.reply === 'string') return { final: parsed.reply, todo: normalizedTodo };
  if (Array.isArray(parsed.toolCalls)) {
    return { toolCalls: parsed.toolCalls, todo: normalizedTodo };
  }
  if (parsed.tool && typeof parsed.tool === 'string') {
    return { toolCalls: [{ tool: parsed.tool, args: parsed.args || {} }], todo: normalizedTodo };
  }
  if (normalizedTodo) return { todo: normalizedTodo };
  return null;
}

function extractTodoFromText(text) {
  const src = String(text || '');
  const ranges = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        ranges.push([start, i + 1]);
        start = -1;
      }
    }
  }

  for (const [from, to] of ranges) {
    const chunk = src.slice(from, to);
    const parsed = safeJsonParse(chunk);
    if (!parsed || typeof parsed !== 'object') continue;
    const todo = Array.isArray(parsed.todo) ? parsed.todo : (Array.isArray(parsed.todos) ? parsed.todos : null);
    const normalized = todo ? normalizeTodoList(todo) : null;
    if (normalized && normalized.length) {
      return { todo: normalized, range: [from, to] };
    }
  }
  return null;
}

function stripTodoJsonFromText(text, range) {
  const src = String(text || '');
  if (!range || range.length !== 2) return src.trim();
  const from = Number(range[0]);
  const to = Number(range[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return src.trim();

  const fenceStart = src.lastIndexOf('```', from);
  if (fenceStart !== -1) {
    const fenceEnd = src.indexOf('```', to);
    if (fenceEnd !== -1) {
      const lineEnd = src.indexOf('\n', fenceStart + 3);
      if (lineEnd !== -1 && lineEnd < fenceEnd) {
        const innerStart = lineEnd + 1;
        const innerEnd = fenceEnd;
        if (from >= innerStart && to <= innerEnd) {
          const beforeInner = src.slice(innerStart, from);
          const afterInner = src.slice(to, innerEnd);
          if (!beforeInner.trim() && !afterInner.trim()) {
            return (src.slice(0, fenceStart) + src.slice(fenceEnd + 3))
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          }
        }
      }
    }
  }

  return (src.slice(0, from) + src.slice(to))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseTaggedToolCalls(text) {
  const src = String(text || '');
  const toolCalls = [];
  const parts = [];
  let cursor = 0;

  while (cursor < src.length) {
    const toolIdx = src.indexOf('[TOOL_CALLS]', cursor);
    if (toolIdx === -1) {
      parts.push(src.slice(cursor));
      break;
    }
    parts.push(src.slice(cursor, toolIdx));
    const toolNameStart = toolIdx + '[TOOL_CALLS]'.length;
    const argsIdx = src.indexOf('[ARGS]', toolNameStart);
    if (argsIdx === -1) {
      parts.push(src.slice(toolIdx));
      break;
    }
    const toolName = src.slice(toolNameStart, argsIdx).trim();
    const argsStart = argsIdx + '[ARGS]'.length;
    const nextToolIdx = src.indexOf('[TOOL_CALLS]', argsStart);
    const argsText = (nextToolIdx === -1 ? src.slice(argsStart) : src.slice(argsStart, nextToolIdx)).trim();

    if (toolName) {
      const args = safeJsonParse(argsText) || safeJsonParse(extractFirstJsonPayload(argsText)) || {};
      toolCalls.push({ tool: toolName, args });
    } else {
      parts.push(src.slice(toolIdx, nextToolIdx === -1 ? src.length : nextToolIdx));
    }

    cursor = nextToolIdx === -1 ? src.length : nextToolIdx;
  }

  const textOut = parts.join('').trim();
  return toolCalls.length ? { toolCalls, text: textOut } : null;
}

function extractToolCallsFromText(text) {
  const src = String(text || '');
  const toolCalls = [];
  const ranges = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = src.slice(start, i + 1);
        const parsed = safeJsonParse(chunk);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.toolCalls)) {
          toolCalls.push(...parsed.toolCalls);
          ranges.push([start, i + 1]);
        }
        start = -1;
      }
    }
  }

  if (!toolCalls.length) return null;

  let remaining = '';
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from > cursor) remaining += src.slice(cursor, from);
    cursor = to;
  }
  if (cursor < src.length) remaining += src.slice(cursor);
  const textOut = remaining.trim();
  return { toolCalls, text: textOut };
}

function normalizeTodoItem(item, index) {
  if (!item || typeof item !== 'object') {
    return { id: `todo_${index + 1}`, text: String(item || '').trim(), status: 'pending' };
  }
  const text = String(item.text || item.title || item.description || '').trim();
  if (!text) return null;
  const statusRaw = String(item.status || '').toLowerCase();
  const status = statusRaw === 'done' || statusRaw === 'complete' ? 'done' : 'pending';
  const id = String(item.id || `todo_${index + 1}`);
  return { id, text, status };
}

function normalizeTodoList(input) {
  if (!Array.isArray(input)) return [];
  const list = input.map((item, index) => normalizeTodoItem(item, index)).filter(Boolean);
  return list;
}

function mergeTodoLists(current, incoming) {
  const next = normalizeTodoList(incoming || []);
  if (!next.length) return normalizeTodoList(current || []);
  const currentList = normalizeTodoList(current || []);
  const currentById = new Map(currentList.map((item) => [String(item.id), item]));
  const currentByText = new Map(currentList.map((item) => [String(item.text).toLowerCase(), item]));

  const merged = next.map((item) => {
    const idKey = String(item.id);
    const textKey = String(item.text).toLowerCase();
    const existing = currentById.get(idKey) || currentByText.get(textKey);
    if (!existing) return item;
    const status = existing.status === 'done' || item.status === 'done' ? 'done' : 'pending';
    return { ...item, status };
  });

  for (const item of currentList) {
    if (item.status !== 'done') continue;
    const idKey = String(item.id);
    const textKey = String(item.text).toLowerCase();
    const exists = merged.some((entry) => String(entry.id) === idKey || String(entry.text).toLowerCase() === textKey);
    if (!exists) merged.push(item);
  }

  return merged;
}

function getPendingTodos(todos) {
  if (!Array.isArray(todos)) return [];
  return todos.filter((item) => item && item.status !== 'done');
}

function buildPlannerInstruction(todos) {
  const pending = getPendingTodos(todos);
  if (!pending.length) {
    return '';
  }
  const list = todos.map((item, idx) => {
    const status = item.status === 'done' ? 'done' : 'pending';
    return `${idx + 1}. [${status}] ${item.text}`;
  }).join('\n');
  const next = pending[0];
  return [
    'You are executing a TODO plan. Focus on ONE pending item at a time.',
    'Current TODOs:',
    list,
    '',
    `Next item to execute: ${next.text}`,
    'Work on the next item only, then return updated {"todo":[...]} with statuses.',
    'Do not repeat the TODO list without taking action; use tools to make progress.'
  ].join('\n');
}

async function applyTodoUpdate(incoming) {
  const merged = mergeTodoLists(chatState.todos, incoming);
  chatState.todos = merged;
  if (activeChatThreadId) {
    await updateChatThreadTodos(activeChatThreadId, chatState.todos);
  }
  postChatState();
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (match) return match[1].trim();
  return trimmed;
}

function isBareTodoResponse(parsed, rawText) {
  if (!parsed || !parsed.todo || parsed.final || (parsed.toolCalls && parsed.toolCalls.length)) return false;
  const raw = String(rawText || '').trim();
  const jsonText = extractFirstJsonPayload(raw);
  if (!jsonText) return false;
  const stripped = stripCodeFence(raw);
  if (stripped !== jsonText.trim()) return false;
  return true;
}

function extractTodoSeedFromText(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  const hasTodoCue = /todo|to[-\s]?do|task list|checklist|plan/i.test(src);
  if (!hasTodoCue) return null;
  const lines = src.split(/\r?\n/).map((line) => line.trim());
  const items = [];
  for (const line of lines) {
    const match = /^(\d+)[\).]\s+(.*)$/.exec(line);
    if (match) {
      const textItem = match[2].trim();
      if (textItem) items.push(textItem);
    }
  }
  if (!items.length) return null;
  return items;
}

function seedTodosFromPrompt(promptText) {
  const items = extractTodoSeedFromText(promptText);
  if (!items || !items.length) return null;
  const seeded = items.map((text, index) => ({
    id: `todo_${index + 1}`,
    text,
    status: 'pending'
  }));
  return seeded;
}

function formatDiagnosticSeverity(severity) {
  if (severity === vscode.DiagnosticSeverity.Error) return 'Error';
  if (severity === vscode.DiagnosticSeverity.Warning) return 'Warning';
  if (severity === vscode.DiagnosticSeverity.Information) return 'Info';
  if (severity === vscode.DiagnosticSeverity.Hint) return 'Hint';
  return 'Unknown';
}

function collectWorkspaceProblems(maxItems = 50) {
  const diagnostics = vscode.languages.getDiagnostics();
  const items = [];
  for (const [uri, diags] of diagnostics) {
    if (!diags || !diags.length) continue;
    const rel = toWorkspaceRelativePath(uri.fsPath);
    for (const diag of diags) {
      if (items.length >= maxItems) break;
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const severity = formatDiagnosticSeverity(diag.severity);
      const source = diag.source ? ` (${diag.source})` : '';
      const code = diag.code ? ` [${diag.code}]` : '';
      items.push(`- ${rel}:${line}:${col} ${severity}${code}${source}: ${diag.message}`);
    }
    if (items.length >= maxItems) break;
  }
  return items;
}

const PREFERRED_SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Event,
  vscode.SymbolKind.Operator,
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Package,
  vscode.SymbolKind.TypeParameter
]);

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

function symbolKindName(kind) {
  if (typeof kind !== 'number') return 'Symbol';
  return SYMBOL_KIND_NAMES[kind] || 'Symbol';
}

function isNoiseSymbol(sym) {
  if (!sym || !sym.location || !sym.location.uri) return true;
  const kind = sym.kind;
  if (kind === vscode.SymbolKind.String || kind === vscode.SymbolKind.Number || kind === vscode.SymbolKind.Boolean) {
    return true;
  }
  const pathText = sym.location.uri.fsPath.toLowerCase();
  if (pathText.includes('.aider.chat.history')) return true;
  if (pathText.endsWith('.md') || pathText.endsWith('.mdx') || pathText.endsWith('.markdown')) return true;
  return false;
}

function buildOpenFileLink(pathText, line) {
  if (!pathText) return '';
  const encoded = encodeURIComponent(String(pathText));
  const linePart = line ? `#${line}` : '';
  return `codecritic-open:${encoded}${linePart}`;
}

function formatSymbolResultMarkdown(sym) {
  if (!sym) return null;
  const name = sym.name || sym.displayName || 'Symbol';
  const kind = symbolKindName(sym.kind);
  const location = sym.location && sym.location.uri ? sym.location : null;
  if (!location) return `${kind} ${name}`;
  const rel = toWorkspaceRelativePath(location.uri.fsPath);
  const line = location.range ? location.range.start.line + 1 : null;
  const displayPath = rel || location.uri.fsPath;
  const locText = displayPath ? `${displayPath}${line ? `:${line}` : ''}` : `${line || ''}`;
  const link = buildOpenFileLink(displayPath, line);
  const container = sym.containerName ? ` (${sym.containerName})` : '';
  const linkedLoc = link ? `[${locText}](${link})` : locText;
  return `- ${kind} ${name}${container} — ${linkedLoc}`;
}

async function searchWorkspaceSymbols(query) {
  try {
    const raw = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return raw;
  } catch {
    return [];
  }
}

function extractBacktickTerms(text) {
  const terms = [];
  const seen = new Set();
  const re = /`([^`]+)`/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    const term = String(match[1] || '').trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

async function buildSmartSearchMessages(text) {
  const terms = extractBacktickTerms(text);
  if (!terms.length) return [];
  const maxTerms = 5;
  const selected = terms.slice(0, maxTerms);
  const messages = [];

  for (const term of selected) {
    const symbolResults = await searchWorkspaceSymbols(term);
    const preferred = symbolResults.filter((sym) => PREFERRED_SYMBOL_KINDS.has(sym.kind) && !isNoiseSymbol(sym));
    const usable = preferred.length
      ? preferred
      : symbolResults.filter((sym) => !isNoiseSymbol(sym));
    const limited = usable.slice(0, 20);

    if (limited.length) {
      const formatted = limited.map(formatSymbolResultMarkdown).filter(Boolean);
      const payload = `Symbol search results for \`${term}\` (${formatted.length}):\n` + formatted.join('\n');
      messages.push({ role: 'assistant', content: formatToolResultForUi('search', payload) });
    } else {
      const textResults = await getToolRunner().toolSearch({ query: term, include: '**/*', exclude: '**/node_modules/**', maxResults: 20 });
      const payload = `No code symbols found for \`${term}\`. Text search results:\n${textResults}`;
      messages.push({ role: 'assistant', content: formatToolResultForUi('search', payload) });
    }
  }

  if (terms.length > maxTerms) {
    messages.push({
      role: 'assistant',
      content: formatToolResultForUi('search', `Note: limited smart search to ${maxTerms} backtick terms.`)
    });
  }

  return messages;
}

function describeToolCall(call) {
  if (!call || typeof call.tool !== 'string') return 'Tool call: (invalid)';
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  if (call.tool === 'search') {
    const query = String(args.query || '').trim();
    const include = args.include ? ` include=${args.include}` : '';
    const exclude = args.exclude ? ` exclude=${args.exclude}` : '';
    return `Tool call: search "${query}"${include}${exclude}`;
  }
  if (call.tool === 'read_file') {
    const pathText = String(args.path || '').trim();
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : '';
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : '';
    const range = start && end ? ` lines ${start}-${end}` : '';
    return `Tool call: read_file ${pathText}${range}`;
  }
  if (call.tool === 'read_files') {
    const paths = Array.isArray(args.paths) ? args.paths.join(', ') : String(args.paths || '').trim();
    return `Tool call: read_files ${paths}`;
  }
  if (call.tool === 'read_file_range_by_symbols') {
    const pathText = String(args.path || '').trim();
    const symbols = Array.isArray(args.symbols) ? args.symbols.join(', ') : String(args.symbols || '').trim();
    return `Tool call: read_file_range_by_symbols ${pathText} (${symbols})`;
  }
  if (call.tool === 'search_symbols') {
    const query = String(args.query || '').trim();
    return `Tool call: search_symbols "${query}"`;
  }
  if (call.tool === 'workspace_symbols') {
    const query = String(args.query || '').trim();
    return `Tool call: workspace_symbols "${query}"`;
  }
  if (call.tool === 'document_symbols') {
    const uri = String(args.uri || args.path || '').trim();
    return `Tool call: document_symbols ${uri}`;
  }
  if (call.tool === 'definition') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: definition ${uri}${pos}`;
  }
  if (call.tool === 'type_definition') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: type_definition ${uri}${pos}`;
  }
  if (call.tool === 'implementation') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: implementation ${uri}${pos}`;
  }
  if (call.tool === 'references') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const include = args.includeDeclaration === false ? ' (exclude declaration)' : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: references ${uri}${pos}${include}`;
  }
  if (call.tool === 'hover') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: hover ${uri}${pos}`;
  }
  if (call.tool === 'signature_help') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: signature_help ${uri}${pos}`;
  }
  if (call.tool === 'call_hierarchy_prepare') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: call_hierarchy_prepare ${uri}${pos}`;
  }
  if (call.tool === 'call_hierarchy_incoming') {
    const id = String(args.itemId || args.id || '').trim();
    return `Tool call: call_hierarchy_incoming ${id}`;
  }
  if (call.tool === 'call_hierarchy_outgoing') {
    const id = String(args.itemId || args.id || '').trim();
    return `Tool call: call_hierarchy_outgoing ${id}`;
  }
  if (call.tool === 'rename_prepare') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const pos = line && character ? ` @ ${line}:${character}` : '';
    return `Tool call: rename_prepare ${uri}${pos}`;
  }
  if (call.tool === 'rename_apply') {
    const uri = String(args.uri || args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : '';
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : '';
    const name = String(args.newName || '').trim();
    const pos = line && character ? ` @ ${line}:${character}` : '';
    const suffix = name ? ` -> ${name}` : '';
    return `Tool call: rename_apply ${uri}${pos}${suffix}`;
  }
  if (call.tool === 'semantic_tokens') {
    const uri = String(args.uri || args.path || '').trim();
    return `Tool call: semantic_tokens ${uri}`;
  }
  if (call.tool === 'locate_file') {
    const query = String(args.query || args.name || '').trim();
    return `Tool call: locate_file "${query}"`;
  }
  if (call.tool === 'edit_file') {
    const pathText = String(args.path || '').trim();
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : '';
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : '';
    const range = start && end ? ` lines ${start}-${end}` : '';
    return `Tool call: edit_file ${pathText}${range}`;
  }
  if (call.tool === 'insert_text') {
    const pathText = String(args.path || '').trim();
    const line = Number.isFinite(Number(args.line)) ? Number(args.line) : Number(args.position && args.position.line);
    const character = Number.isFinite(Number(args.character)) ? Number(args.character) : Number(args.position && args.position.character);
    const pos = Number.isFinite(line) && Number.isFinite(character) ? ` @ ${line}:${character}` : '';
    return `Tool call: insert_text ${pathText}${pos}`;
  }
  if (call.tool === 'replace_range') {
    const pathText = String(args.path || '').trim();
    return `Tool call: replace_range ${pathText}`;
  }
  if (call.tool === 'copy_file') {
    const from = String(args.from || '').trim();
    const to = String(args.to || '').trim();
    const overwrite = args.overwrite ? ' overwrite' : '';
    return `Tool call: copy_file ${from} -> ${to}${overwrite}`;
  }
  if (call.tool === 'apply_patch_preview') {
    const patch = String(args.patch || args.diff || '');
    const size = patch ? `${patch.length} chars` : 'empty';
    return `Tool call: apply_patch_preview (${size})`;
  }
  if (call.tool === 'list_files') {
    const include = args.include ? ` include=${args.include}` : '';
    const exclude = args.exclude ? ` exclude=${args.exclude}` : '';
    return `Tool call: list_files${include}${exclude}`;
  }
  if (call.tool === 'file_stat') {
    const pathText = String(args.path || '').trim();
    return `Tool call: file_stat ${pathText}`;
  }
  if (call.tool === 'write_file') {
    const pathText = String(args.path || '').trim();
    const overwrite = args.overwrite ? ' overwrite' : '';
    const append = args.append ? ' append' : '';
    return `Tool call: write_file ${pathText}${overwrite}${append}`;
  }
  if (call.tool === 'create_dir') {
    const pathText = String(args.path || '').trim();
    return `Tool call: create_dir ${pathText}`;
  }
  if (call.tool === 'run_command') {
    const cmd = String(args.command || '').trim();
    const cwd = String(args.cwd || '').trim();
    const lines = ['Tool call: run_command'];
    lines.push(`- command: \`${cmd || '(empty)'}\``);
    if (cwd) lines.push(`- cwd: \`${cwd}\``);
    return lines.join('\n');
  }
  if (call.tool === 'delete_file') {
    const pathText = String(args.path || '').trim();
    const recursive = args.recursive ? ' recursive' : '';
    return `Tool call: delete_file ${pathText}${recursive}`;
  }
  if (call.tool === 'move_file') {
    const from = String(args.from || '').trim();
    const to = String(args.to || '').trim();
    return `Tool call: move_file ${from} -> ${to}`;
  }
  if (call.tool === 'read_dir') {
    const pathText = String(args.path || '').trim();
    const depth = Number.isFinite(Number(args.maxDepth)) ? ` depth=${Number(args.maxDepth)}` : '';
    return `Tool call: read_dir ${pathText}${depth}`;
  }
  if (call.tool === 'read_output') {
    const maxChars = Number.isFinite(Number(args.maxChars)) ? ` maxChars=${Number(args.maxChars)}` : '';
    const tail = args.tail === false ? ' tail=false' : '';
    return `Tool call: read_output${maxChars}${tail}`;
  }
  if (call.tool === 'apply_patch') {
    const patch = String(args.patch || args.diff || '');
    const size = patch ? `${patch.length} chars` : 'empty';
    return `Tool call: apply_patch (${size})`;
  }
  return `Tool call: ${call.tool}`;
}

function formatToolResultForUi(tool, resultText) {
  const label = tool ? `Tool result (${tool}):` : 'Tool result:';
  const body = String(resultText || '').trim();
  const hasFence = body.includes('```');
  if (tool === 'run_command') {
    return `${label}\n\`\`\`\n${body}\n\`\`\``;
  }
  const codeTools = new Set(['read_file', 'read_files', 'read_file_range_by_symbols', 'read_output']);
  if (tool && codeTools.has(tool)) {
    if (hasFence) return `${label}\n${body}`;
    return `${label}\n\`\`\`\n${body}\n\`\`\``;
  }
  return `${label}\n${resultText}`;
}

function isLikelyFileQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return true;
  return /\\.([a-z0-9]{1,6})$/i.test(raw);
}

function normalizeToolCall(call) {
  if (!call || typeof call.tool !== 'string') return call;
  const args = call.args && typeof call.args === 'object' ? { ...call.args } : {};
  if (call.tool === 'search') {
    const query = String(args.query || '').trim();
    if (isLikelyFileQuery(query)) {
      return { tool: 'locate_file', args: { ...args, query } };
    }
  }
  return { tool: call.tool, args };
}

function isContinuationRequest(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  return /^(please\s+)?(continue|resume|keep going|go on|carry on|next)\.?$/.test(raw);
}

function buildAgentModelMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg.content !== 'string') continue;
    const content = String(msg.content || '');
    if (msg.role === 'assistant' && content.startsWith('Tool call:')) continue;
    if (msg.role === 'assistant' && content.startsWith('Tool result')) {
      out.push({ role: 'user', content });
      continue;
    }
    if (msg.role === 'assistant'
        && (content === 'Agent stopped: too many tool steps.' || content === 'Stopped.')) {
      continue;
    }
    out.push(msg);
  }
  return out;
}

function setAgentContinuation(messages) {
  if (Array.isArray(messages) && messages.length) {
    agentContinuationMessages = messages.map((msg) => ({ ...msg }));
  } else {
    agentContinuationMessages = null;
  }
}

async function runAgentTurn(baseMessages, modelMessagesSeed) {
  const uiMessages = [...baseMessages];
  let modelMessages = Array.isArray(modelMessagesSeed) && modelMessagesSeed.length
    ? [...modelMessagesSeed]
    : [...baseMessages];
  const maxSteps = getAgentMaxSteps();
  const historyLimit = getChatHistoryCharLimit();
  const mutatingTools = new Set([
    'edit_file',
    'write_file',
    'create_dir',
    'delete_file',
    'move_file',
    'apply_patch',
    'run_command'
  ]);
  const verifyTools = new Set(['read_dir', 'list_files']);
  let lastBareTodoSignature = null;
  let bareTodoRepeatCount = 0;
  let lastCommandSignature = null;
  let sawMutationSinceCommand = false;
  let mutationSinceProblems = false;

  for (let step = 0; step < maxSteps; step++) {
    if (stopRequested) {
      stopRequested = false;
      chatBusy = false;
      setAgentContinuation(null);
      uiMessages.push({ role: 'assistant', content: 'Stopped.' });
      chatState.messages = uiMessages;
      postChatState();
      return;
    }
    const pendingTodos = getPendingTodos(chatState.todos);
    const plannerText = pendingTodos.length ? buildPlannerInstruction(chatState.todos) : '';
    const plannerMessage = plannerText
      ? { role: 'user', content: plannerText }
      : null;
    const modelSeed = plannerMessage ? [...modelMessages, plannerMessage] : modelMessages;
    const assistantText = await callModelForChat({
      messages: trimChatMessagesForModel(modelSeed, historyLimit),
      mode: 'agent',
      context: chatState.contexts
    });
    const trimmedAssistant = String(assistantText || '').trim();
    if (!trimmedAssistant) {
      setAgentContinuation(null);
      uiMessages.push({
        role: 'assistant',
        content: 'Error: model returned an empty response. Try another model or check the endpoint.'
      });
      chatState.messages = uiMessages;
      postChatState();
      return;
    }
    let parsed = parseAgentResponse(assistantText);
    if (!parsed) {
      parsed = parseTaggedToolCalls(assistantText) || extractToolCallsFromText(assistantText);
    }
    const todoExtraction = extractTodoFromText(assistantText);
    if (!parsed && todoExtraction && todoExtraction.todo) {
      parsed = { todo: todoExtraction.todo };
    }
    const cleanedAssistantText = todoExtraction
      ? stripTodoJsonFromText(assistantText, todoExtraction.range)
      : assistantText;
    modelMessages.push({ role: 'assistant', content: assistantText });
    modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);

    if (!parsed) {
      setAgentContinuation(null);
      uiMessages.push({ role: 'assistant', content: assistantText });
      chatState.messages = uiMessages;
      return;
    }

    if (parsed.final) {
      if (parsed.todo) {
        await applyTodoUpdate(parsed.todo);
      } else if (todoSeedCache && todoSeedCache.length) {
        await applyTodoUpdate(todoSeedCache);
      }
      if (mutationSinceProblems && getPendingTodos(chatState.todos).length === 0) {
        const problems = collectWorkspaceProblems(50);
        if (problems.length) {
          const problemsText = formatToolResultForUi(
            'problems',
            `Workspace problems (${problems.length}):\n` + problems.join('\n')
          );
          mutationSinceProblems = false;
          uiMessages.push({ role: 'assistant', content: problemsText });
          modelMessages.push({ role: 'user', content: problemsText });
          modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
          chatState.messages = uiMessages;
          postChatState();
          continue;
        }
      }
      setAgentContinuation(null);
      uiMessages.push({ role: 'assistant', content: parsed.final });
      chatState.messages = uiMessages;
      return;
    }

    if (parsed.toolCalls && parsed.toolCalls.length) {
      lastBareTodoSignature = null;
      bareTodoRepeatCount = 0;
      if (parsed.todo) {
        await applyTodoUpdate(parsed.todo);
      } else if (todoSeedCache && todoSeedCache.length) {
        await applyTodoUpdate(todoSeedCache);
      }
      if (parsed.text && parsed.text.trim()) {
        uiMessages.push({ role: 'assistant', content: parsed.text.trim() });
        chatState.messages = uiMessages;
        postChatState();
      }
      let didMutate = false;
      let didVerify = false;
      for (const call of parsed.toolCalls) {
        const normalizedCall = normalizeToolCall(call);
        uiMessages.push({ role: 'assistant', content: describeToolCall(normalizedCall) });
        chatState.messages = uiMessages;
        postChatState();

        if (normalizedCall && mutatingTools.has(normalizedCall.tool)) {
          didMutate = true;
          mutationSinceProblems = true;
        }
        if (normalizedCall && verifyTools.has(normalizedCall.tool)) didVerify = true;

        if (normalizedCall && normalizedCall.tool === 'run_command') {
          const command = normalizedCall.args && normalizedCall.args.command
            ? String(normalizedCall.args.command).trim()
            : '';
          const cwd = normalizedCall.args && normalizedCall.args.cwd
            ? String(normalizedCall.args.cwd).trim()
            : '';
          const timeoutMs = normalizedCall.args && normalizedCall.args.timeoutMs
            ? Number(normalizedCall.args.timeoutMs)
            : '';
          const signature = JSON.stringify({ command, cwd, timeoutMs });
          if (lastCommandSignature && signature === lastCommandSignature && !sawMutationSinceCommand) {
            const skipped = 'Skipped: command already run with the same args and no file changes since then. Make a change or ask to force a rerun.';
            const resultText = formatToolResultForUi('run_command', skipped);
            uiMessages.push({ role: 'assistant', content: resultText });
            modelMessages.push({ role: 'user', content: resultText });
            modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
            chatState.messages = uiMessages;
            postChatState();
            continue;
          }
          const result = await runToolCall(normalizedCall);
          lastCommandSignature = signature;
          sawMutationSinceCommand = false;
          const resultText = formatToolResultForUi(normalizedCall.tool, limitToolOutput(result, 12000));
          uiMessages.push({ role: 'assistant', content: resultText });
          modelMessages.push({ role: 'user', content: resultText });
          modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
          chatState.messages = uiMessages;
          postChatState();
          continue;
        }

        const result = await runToolCall(normalizedCall);
        const resultText = formatToolResultForUi(normalizedCall.tool, limitToolOutput(result, 12000));
        uiMessages.push({ role: 'assistant', content: resultText });
        modelMessages.push({ role: 'user', content: resultText });
        modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
        chatState.messages = uiMessages;
        postChatState();

        if (normalizedCall && mutatingTools.has(normalizedCall.tool)) {
          sawMutationSinceCommand = true;
          mutationSinceProblems = true;
        }
      }

      if (didMutate && !didVerify) {
        const runner = getToolRunner();
        const tree = await runner.toolReadDir({ path: '.', maxDepth: 3, maxEntries: 400 });
        const treeText = formatToolResultForUi('read_dir', limitToolOutput(tree, 12000));
        uiMessages.push({ role: 'assistant', content: treeText });
        modelMessages.push({ role: 'user', content: treeText });

        const files = await runner.toolListFiles({ include: '**/*', exclude: '**/node_modules/**', maxResults: 200 });
        const filesText = formatToolResultForUi('list_files', limitToolOutput(files, 12000));
        uiMessages.push({ role: 'assistant', content: filesText });
        modelMessages.push({ role: 'user', content: filesText });

        modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
        chatState.messages = uiMessages;
        postChatState();
      }

      continue;
    }

    if (parsed.todo) {
      await applyTodoUpdate(parsed.todo);
    } else if (todoSeedCache && todoSeedCache.length) {
      await applyTodoUpdate(todoSeedCache);
    }
    const cleanedBody = cleanedAssistantText && cleanedAssistantText.trim() ? cleanedAssistantText : '';
    const isBareTodo = parsed.todo
      ? isBareTodoResponse(parsed, assistantText)
      : (todoExtraction && !cleanedBody);
    if (!isBareTodo) {
      if (mutationSinceProblems && getPendingTodos(chatState.todos).length === 0) {
        const problems = collectWorkspaceProblems(50);
        if (problems.length) {
          const problemsText = formatToolResultForUi(
            'problems',
            `Workspace problems (${problems.length}):\n` + problems.join('\n')
          );
          mutationSinceProblems = false;
          uiMessages.push({ role: 'assistant', content: problemsText });
          modelMessages.push({ role: 'user', content: problemsText });
          modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
          chatState.messages = uiMessages;
          postChatState();
          continue;
        }
      }
      setAgentContinuation(null);
      uiMessages.push({ role: 'assistant', content: cleanedBody || assistantText });
      chatState.messages = uiMessages;
      return;
    }
    const todoSignature = parsed.todo ? JSON.stringify(normalizeTodoList(parsed.todo)) : null;
    if (todoSignature && todoSignature === lastBareTodoSignature) {
      bareTodoRepeatCount += 1;
    } else {
      bareTodoRepeatCount = 0;
      lastBareTodoSignature = todoSignature;
    }
    if (bareTodoRepeatCount >= 1) {
      modelMessages.push({
        role: 'user',
        content: 'You are repeating the TODO list without acting. Use tools to complete the next item now. Do not return only TODO JSON.'
      });
      modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
    }
    const stillPending = getPendingTodos(chatState.todos).length > 0;
    if (!stillPending) {
      if (mutationSinceProblems) {
        const problems = collectWorkspaceProblems(50);
        if (problems.length) {
          const problemsText = formatToolResultForUi(
            'problems',
            `Workspace problems (${problems.length}):\n` + problems.join('\n')
          );
          mutationSinceProblems = false;
          uiMessages.push({ role: 'assistant', content: problemsText });
          modelMessages.push({ role: 'user', content: problemsText });
          modelMessages = trimChatMessagesForModel(modelMessages, historyLimit);
          chatState.messages = uiMessages;
          postChatState();
          continue;
        }
      }
      setAgentContinuation(null);
      uiMessages.push({ role: 'assistant', content: 'All TODO items completed.' });
      chatState.messages = uiMessages;
      return;
    }
    // Keep looping to execute the next pending TODO.
    continue;
  }

  setAgentContinuation(modelMessages);
  uiMessages.push({ role: 'assistant', content: 'Agent stopped: too many tool steps.' });
  chatState.messages = uiMessages;
}

async function runToolCall(call) {
  try {
    return await getToolRunner().runToolCall(call);
  } catch (err) {
    return `Tool failed: ${String(err && err.message ? err.message : err)}`;
  }
}

async function callModelForChat({ messages, mode, context }) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const baseUrl = (cfg.get('ollamaBaseUrl', 'http://127.0.0.1:11434/v1') || '').replace(/\/+$/, '');
  const model = getActiveChatModel();

  const system = mode === 'agent' ? buildAgentSystemPrompt(context) : buildChatSystemPrompt(context);
  const allMessages = [{ role: 'system', content: system }, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: 0.2
  };

  if (isDebugEnabled()) {
    const out = getOutputChannel();
    out.appendLine('--- CodeCritic chat request: start ---');
    out.appendLine(`Endpoint: ${baseUrl}/chat/completions`);
    out.appendLine(`Model: ${model}`);
    out.appendLine(`Temperature: ${body.temperature}`);
    out.appendLine('Messages (exact order):');
    allMessages.forEach((msg, idx) => {
      const role = msg && msg.role ? msg.role : 'unknown';
      const content = msg && typeof msg.content === 'string' ? msg.content : String(msg && msg.content);
      out.appendLine(`[${idx}] [${role}] ${content}`);
    });
    out.appendLine('--- CodeCritic chat request: raw payload ---');
    try {
      out.appendLine(JSON.stringify(body, null, 2));
    } catch (err) {
      out.appendLine(`(Failed to serialize body: ${String(err && err.message ? err.message : err)})`);
    }
    out.appendLine('--- CodeCritic chat request: end ---');
    out.show(true);
  }

  const totalChars = allMessages.reduce((sum, msg) => sum + String(msg.content || '').length, 0);
  updateTokenEstimate(totalChars);

  activeAbortController = new AbortController();
  try {
    const json = await postChatCompletions(`${baseUrl}/chat/completions`, body, { signal: activeAbortController.signal });
    return extractAssistantText(json);
  } finally {
    activeAbortController = null;
  }
}

function getChatHtml(webview) {
  const scriptUri = extensionContext
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.js'))
    : '';
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --panel: var(--vscode-editorWidget-background);
      --border: var(--vscode-editorWidget-border);
      --accent: var(--vscode-button-background);
      --accent-fg: var(--vscode-button-foreground);
      --muted: var(--vscode-descriptionForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      color: var(--fg);
      background: linear-gradient(160deg, rgba(120, 130, 150, 0.12), rgba(30, 40, 60, 0.12)), var(--bg);
      font-family: 'Space Grotesk', 'Avenir Next', 'Segoe UI', sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    select, button {
      font: inherit;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--fg);
      padding: 6px 10px;
    }
    select.thread-select {
      min-width: 160px;
      max-width: 240px;
    }
    select.model-select {
      min-width: 160px;
      max-width: 240px;
    }
    button.icon {
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
    }
    button.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }
    button:disabled {
      opacity: 0.6;
    }
    .tabs {
      display: flex;
      gap: 6px;
      padding: 8px 16px 0;
      border-bottom: 1px solid var(--border);
    }
    .tab-button {
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 8px 12px;
      font-size: 12px;
      background: transparent;
      color: var(--muted);
    }
    .tab-button.active {
      color: var(--fg);
      border-bottom-color: var(--accent);
    }
    .tab-panel {
      display: none;
      flex: 1;
      min-height: 0;
      flex-direction: column;
    }
    .tab-panel.active {
      display: flex;
    }
    .context-bar {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .context-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .context-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--fg);
      font-size: 12px;
    }
    .chip-label {
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip button {
      border: none;
      background: transparent;
      color: var(--muted);
      padding: 0;
      cursor: pointer;
    }
    .context-toolbar {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .context-count {
      font-size: 12px;
      color: var(--muted);
    }
    .context-list {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .context-card {
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--panel);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .context-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--fg);
    }
    .context-meta {
      font-size: 11px;
      color: var(--muted);
    }
    .context-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .context-editor {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .context-preview {
      margin: 0;
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.2);
      font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow: auto;
    }
    .context-editor input,
    .context-editor textarea {
      font: inherit;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.12);
      color: var(--fg);
      padding: 6px 10px;
    }
    .context-empty {
      padding: 24px;
      text-align: center;
      font-size: 12px;
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 12px;
    }
    .context-bar .context-empty {
      padding: 0;
      border: none;
      text-align: left;
    }
    .approvals {
      padding: 12px 16px 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .approval-card {
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }
    .approval-title {
      font-weight: 600;
      color: var(--fg);
    }
    .approval-details {
      color: var(--muted);
      white-space: pre-wrap;
    }
    .approval-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .todos {
      padding: 12px 16px 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .todo-card {
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.18);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
    }
    .todo-title {
      font-weight: 600;
      color: var(--fg);
    }
    .todo-item {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
    }
    .todo-item.done {
      color: rgba(180, 255, 200, 0.9);
      text-decoration: line-through;
    }
    .todo-pill {
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 2px 8px;
      font-size: 10px;
      color: var(--fg);
      background: rgba(0, 0, 0, 0.2);
    }
    .context-form {
      border-top: 1px solid var(--border);
      padding: 12px 16px 16px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
    }
    .context-form textarea {
      resize: vertical;
      min-height: 80px;
      max-height: 200px;
    }
    .hint {
      font-size: 11px;
      color: var(--muted);
      text-align: center;
    }
    .chat {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg {
      max-width: 90%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--panel);
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .msg.user {
      align-self: flex-end;
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }
    .msg.assistant {
      align-self: flex-start;
    }
    .msg.assistant h1,
    .msg.assistant h2,
    .msg.assistant h3 {
      margin: 0 0 8px;
      font-weight: 600;
    }
    .msg.assistant h1 { font-size: 16px; }
    .msg.assistant h2 { font-size: 15px; }
    .msg.assistant h3 { font-size: 14px; }
    .msg.assistant p {
      margin: 0 0 8px;
    }
    .msg.assistant p:last-child {
      margin-bottom: 0;
    }
    .msg.assistant ul,
    .msg.assistant ol {
      margin: 0 0 8px 18px;
      padding: 0;
    }
    .msg.assistant code {
      font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 12px;
      background: rgba(0, 0, 0, 0.18);
      padding: 2px 4px;
      border-radius: 6px;
    }
    .msg.assistant pre {
      margin: 0 0 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.25);
      overflow-x: auto;
    }
    .msg.assistant pre code {
      background: transparent;
      padding: 0;
      border-radius: 0;
      font-size: 12px;
    }
    .msg.assistant pre code.code-block {
      counter-reset: line;
      display: block;
    }
    .msg.assistant pre code.code-block .code-line {
      display: block;
      position: relative;
      padding-left: 36px;
      white-space: pre;
    }
    .msg.assistant pre code.code-block .code-line::before {
      counter-increment: line;
      content: counter(line);
      position: absolute;
      left: 0;
      width: 28px;
      text-align: right;
      color: var(--muted);
      opacity: 0.7;
    }
    .msg.assistant pre code.code-block .line-text {
      display: inline-block;
      min-width: 0;
    }
    .msg.assistant pre code .token.keyword { color: #7fd6ff; }
    .msg.assistant pre code .token.string { color: #ffd28c; }
    .msg.assistant pre code .token.number { color: #b4f1a2; }
    .msg.assistant pre code .token.comment { color: #8b96a8; font-style: italic; }
    .diff-block {
      margin: 0 0 8px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.28);
      overflow-x: auto;
    }
    .diff-line {
      display: block;
      white-space: pre;
    }
    .diff-add {
      background: rgba(66, 185, 131, 0.18);
      color: #a8f0c6;
    }
    .diff-del {
      background: rgba(235, 87, 87, 0.18);
      color: #ffb3b3;
    }
    .diff-hunk {
      color: #9bbcff;
    }
    .msg.assistant a {
      color: var(--accent);
      text-decoration: none;
    }
    .msg.assistant a:hover {
      text-decoration: underline;
    }
    .composer {
      border-top: 1px solid var(--border);
      padding: 12px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .composer-frame {
      position: relative;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      padding: 10px 12px 44px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rich-input {
      min-height: 72px;
      max-height: 240px;
      width: 100%;
      border: none;
      background: transparent;
      color: var(--fg);
      font: inherit;
      padding: 0;
      outline: none;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-y: auto;
    }
    .rich-input:empty::before {
      content: attr(data-placeholder);
      color: var(--muted);
    }
    .rich-input .token-command {
      color: #7fd6ff;
      font-weight: 600;
    }
    .command-menu {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 56px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 6px;
      display: none;
      flex-direction: column;
      gap: 4px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 5;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
    }
    .command-menu.is-open {
      display: flex;
    }
    .command-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 8px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
      color: var(--fg);
    }
    .command-item:hover,
    .command-item.is-active {
      background: rgba(127, 214, 255, 0.16);
    }
    .command-name {
      font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
      color: #7fd6ff;
    }
    .command-desc {
      color: var(--muted);
      font-size: 11px;
    }
    textarea {
      resize: vertical;
      min-height: 72px;
      max-height: 240px;
      width: 100%;
      border: none;
      background: transparent;
      color: var(--fg);
      font: inherit;
      padding: 0;
      outline: none;
    }
    .mode-picker {
      position: absolute;
      left: 12px;
      bottom: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .mode-pill {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
      font-size: 11px;
      color: var(--fg);
    }
    .debug-toggle {
      margin-left: 6px;
      width: 26px;
      height: 26px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.2);
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .debug-toggle.is-active {
      color: var(--accent-fg);
      border-color: var(--accent);
      background: rgba(255, 255, 255, 0.08);
    }
    .debug-toggle svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    .mode-select {
      appearance: none;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 0 10px 0 2px;
      margin: 0;
      line-height: 1.4;
      cursor: pointer;
    }
    .mode-select.model-select {
      max-width: 180px;
    }
    .mode-select:focus {
      outline: none;
    }
    .mode-chevron {
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--muted);
      margin-left: -6px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }
    .primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .primary:disabled {
      opacity: 0.9;
      cursor: default;
    }
    .send-thinking {
      display: none;
    }
    .primary.is-thinking .send-label {
      display: none;
    }
    .primary.is-thinking .send-thinking {
      display: inline-flex;
    }
    .ai-thinking-grid {
      --size: 18px;
      --gap: 2px;
      --dot: 4px;
      --c: var(--accent-fg);
      width: var(--size);
      height: var(--size);
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--gap);
    }
    .ai-thinking-grid > span {
      width: var(--dot);
      height: var(--dot);
      place-self: center;
      background: var(--c);
      border-radius: 2px;
      opacity: 0.35;
      transform: scale(0.85);
      animation: aiGridPulse 1.1s infinite ease-in-out;
    }
    .ai-thinking-grid > span:nth-child(1){animation-delay: 0ms;}
    .ai-thinking-grid > span:nth-child(2){animation-delay: 90ms;}
    .ai-thinking-grid > span:nth-child(3){animation-delay: 180ms;}
    .ai-thinking-grid > span:nth-child(4){animation-delay: 90ms;}
    .ai-thinking-grid > span:nth-child(5){animation-delay: 180ms;}
    .ai-thinking-grid > span:nth-child(6){animation-delay: 270ms;}
    .ai-thinking-grid > span:nth-child(7){animation-delay: 180ms;}
    .ai-thinking-grid > span:nth-child(8){animation-delay: 270ms;}
    .ai-thinking-grid > span:nth-child(9){animation-delay: 360ms;}
    @keyframes aiGridPulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1.1); }
    }
    .composer-controls {
      position: absolute;
      right: 10px;
      bottom: 8px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .send-button {
      min-width: 72px;
    }
    .stop-button {
      display: none;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.08);
      color: var(--fg);
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 999px;
    }
    .stop-button.is-visible {
      display: inline-flex;
    }
    .status {
      font-size: 11px;
      color: var(--muted);
      text-align: center;
    }
    .tool-block {
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.18);
      padding: 8px 10px;
    }
    .tool-block summary {
      cursor: pointer;
      color: var(--fg);
      font-weight: 600;
      font-size: 12px;
      list-style: none;
    }
    .tool-block summary::-webkit-details-marker {
      display: none;
    }
    .tool-block summary::before {
      content: '▸';
      display: inline-block;
      margin-right: 6px;
      color: var(--muted);
    }
    .tool-block[open] summary::before {
      content: '▾';
    }
    .tool-body {
      margin-top: 8px;
      font-size: 12px;
      color: var(--muted);
      background: var(--vscode-editor-background);
      padding: 8px 10px;
      border-radius: 8px;
    }
    .tool-actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8px;
    }
    .tool-revert {
      border: none;
      background: transparent;
      color: var(--accent-fg);
      font-size: 11px;
      cursor: pointer;
      text-decoration: underline;
      padding: 0;
    }
    .tool-revert:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <header>
    <div class="controls">
      <label for="threadSelect">Chat</label>
      <select id="threadSelect" class="thread-select"></select>
      <button id="newChat" class="icon" title="New chat">+</button>
    </div>
  </header>
  <div class="tabs">
    <button class="tab-button active" data-tab="chat">Chat</button>
    <button class="tab-button" data-tab="context">Context</button>
  </div>
  <section id="tabChat" class="tab-panel active">
    <div id="todos" class="todos"></div>
    <div id="approvals" class="approvals"></div>
    <div id="chat" class="chat"></div>
    <div class="composer">
      <div class="composer-frame">
        <div id="input" class="rich-input" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Ask a question or describe a task..."></div>
        <div id="commandMenu" class="command-menu" aria-hidden="true"></div>
        <div class="mode-picker">
          <label for="mode" class="sr-only">Mode</label>
          <div class="mode-pill">
            <select id="mode" class="mode-select">
              <option value="chat">Chat</option>
              <option value="agent">Agent</option>
            </select>
            <span class="mode-chevron" aria-hidden="true"></span>
          </div>
          <label for="modelSelect" class="sr-only">Model</label>
          <div class="mode-pill">
            <select id="modelSelect" class="mode-select model-select"></select>
            <span class="mode-chevron" aria-hidden="true"></span>
          </div>
          <button id="debugListen" class="debug-toggle" type="button" title="Toggle debug snapshot listening" aria-pressed="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 9h8M9 3l1 2M15 3l-1 2M4 13h4m8 0h4M6 19h12M10 9v10M14 9v10M8 5h8a4 4 0 0 1 4 4v4a6 6 0 0 1-6 6h0a6 6 0 0 1-6-6V9a4 4 0 0 1 4-4z"/>
            </svg>
          </button>
        </div>
        <div class="composer-controls">
          <button id="stop" class="stop-button" type="button">Stop</button>
          <button id="send" class="primary send-button">
            <span class="send-label">Send</span>
            <span class="send-thinking" aria-hidden="true">
              <span class="ai-thinking-grid" aria-label="AI thinking" role="img">
                <span></span><span></span><span></span>
                <span></span><span></span><span></span>
                <span></span><span></span><span></span>
              </span>
            </span>
          </button>
        </div>
      </div>
      <div id="status" class="status">Loading chat...</div>
    </div>
  </section>
  <section id="tabContext" class="tab-panel">
    <div class="context-toolbar">
      <button id="addContextFromSelectionDetail" title="Add selection as context">Add selection</button>
      <button id="clearContextAll" title="Clear all contexts">Clear all</button>
      <span id="contextCountDetail" class="context-count"></span>
    </div>
    <div id="contextList" class="context-list"></div>
    <div class="context-form">
      <textarea id="contextNote" placeholder="Add a note or summary to keep in context..."></textarea>
      <div class="composer-actions">
        <button id="addContextNote" class="primary">Add note</button>
        <div class="hint">Notes become part of chat context.</div>
      </div>
    </div>
  </section>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

function ensureSqliteAvailable() {
  if (chatDbUnavailable) return false;
  if (!sqlite3) {
    chatDbUnavailable = true;
    vscode.window.showErrorMessage('CodeCritic: sqlite3 dependency not available. Run npm install in the extension folder.');
    return false;
  }
  return true;
}

async function ensureChatDbReady() {
  if (!ensureSqliteAvailable()) return false;
  if (!extensionContext) return false;
  if (!chatDbReady) {
    chatDbReady = initChatDb(extensionContext);
  }
  try {
    await chatDbReady;
    return true;
  } catch (err) {
    const out = getOutputChannel();
    out.appendLine(`CodeCritic chat DB init failed: ${String(err && err.message ? err.message : err)}`);
    out.show(true);
    return false;
  }
}

async function initChatDb(context) {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const dbPath = path.join(context.globalStorageUri.fsPath, 'chat.db');
  chatDb = new sqlite3.Database(dbPath);
  await dbRun('PRAGMA foreign_keys = ON');
  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun(
    'CREATE TABLE IF NOT EXISTS chat_threads (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'title TEXT NOT NULL,' +
      'context_json TEXT,' +
      'todo_json TEXT,' +
      'created_at TEXT NOT NULL,' +
      'updated_at TEXT NOT NULL' +
    ')'
  );
  await dbRun(
    'CREATE TABLE IF NOT EXISTS chat_messages (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      'thread_id INTEGER NOT NULL,' +
      'role TEXT NOT NULL,' +
      'content TEXT NOT NULL,' +
      'created_at TEXT NOT NULL,' +
      'FOREIGN KEY(thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE' +
    ')'
  );
  await dbRun('CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)');

  try {
    const columns = await dbAll("PRAGMA table_info('chat_threads')");
    const hasTodo = columns.some((col) => col && col.name === 'todo_json');
    if (!hasTodo) {
      await dbRun('ALTER TABLE chat_threads ADD COLUMN todo_json TEXT');
    }
  } catch {
    // ignore migration errors
  }

  const storedId = context.globalState.get('codeCritic.activeChatThreadId');
  if (storedId) {
    activeChatThreadId = String(storedId);
  }
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!chatDb) return reject(new Error('Chat DB not initialized.'));
    chatDb.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!chatDb) return reject(new Error('Chat DB not initialized.'));
    chatDb.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!chatDb) return reject(new Error('Chat DB not initialized.'));
    chatDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function defaultChatTitle() {
  const iso = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  return `Chat ${iso}`;
}

function normalizeThreadId(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return String(Math.floor(num));
}

async function ensureChatReady() {
  const ok = await ensureChatDbReady();
  if (!ok) return;

  await refreshChatThreads();
  if (!activeChatThreadId || !chatThreads.find((t) => t.id === activeChatThreadId)) {
    const first = chatThreads[0];
    activeChatThreadId = first ? first.id : null;
  }
  if (!activeChatThreadId) {
    activeChatThreadId = await createChatThread({ title: defaultChatTitle(), context: null, todos: [] });
  }
  if (activeChatThreadId) {
    await loadChatThread(activeChatThreadId);
    await persistActiveChatThreadId();
  }
}

async function persistActiveChatThreadId() {
  if (!extensionContext) return;
  await extensionContext.globalState.update('codeCritic.activeChatThreadId', activeChatThreadId);
}

async function refreshChatThreads() {
  if (!chatDb) return;
  const rows = await dbAll(
    'SELECT id, title, updated_at FROM chat_threads ORDER BY datetime(updated_at) DESC, id DESC'
  );
  chatThreads = rows.map((row) => ({
    id: String(row.id),
    title: row.title || defaultChatTitle(),
    updatedAt: String(row.updated_at || '')
  }));
}

async function createChatThread({ title, context, todos }) {
  if (!chatDb) return null;
  const now = new Date().toISOString();
  const safeTitle = String(title || defaultChatTitle()).trim() || defaultChatTitle();
  const ctxJson = context ? JSON.stringify(context) : null;
  const todoJson = todos && todos.length ? JSON.stringify(todos) : null;
  const info = await dbRun(
    'INSERT INTO chat_threads (title, context_json, todo_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [safeTitle, ctxJson, todoJson, now, now]
  );
  const id = info && info.lastID ? String(info.lastID) : null;
  if (id) {
    activeChatThreadId = id;
    await persistActiveChatThreadId();
  }
  await refreshChatThreads();
  return id;
}

async function loadChatThread(threadId) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const row = await dbGet('SELECT id, title, context_json, todo_json FROM chat_threads WHERE id = ?', [normId]);
  if (!row) return;
  const rows = await dbAll(
    'SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id ASC',
    [normId]
  );
  chatState.messages = rows.map((msg) => ({
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: String(msg.content || '')
  }));
  const parsed = row.context_json ? safeJsonParse(row.context_json) : null;
  chatState.contexts = normalizeContextList(parsed);
  const todoParsed = row.todo_json ? safeJsonParse(row.todo_json) : null;
  chatState.todos = normalizeTodoList(todoParsed || []);
  chatState.approvals = [];
}

async function selectChatThread(threadId) {
  await ensureChatReady();
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  activeChatThreadId = normId;
  await persistActiveChatThreadId();
  await loadChatThread(normId);
  postChatState();
}

async function clearChatMessages(threadId) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  await dbRun('DELETE FROM chat_messages WHERE thread_id = ?', [normId]);
}

async function updateChatThreadContext(threadId, context) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const ctxJson = context ? JSON.stringify(context) : null;
  await dbRun('UPDATE chat_threads SET context_json = ? WHERE id = ?', [ctxJson, normId]);
}

async function updateChatThreadTodos(threadId, todos) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const todoJson = todos && todos.length ? JSON.stringify(todos) : null;
  await dbRun('UPDATE chat_threads SET todo_json = ? WHERE id = ?', [todoJson, normId]);
}

async function touchChatThread(threadId) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const now = new Date().toISOString();
  await dbRun('UPDATE chat_threads SET updated_at = ? WHERE id = ?', [now, normId]);
}

async function addChatMessage(threadId, role, content) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const now = new Date().toISOString();
  await dbRun(
    'INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    [normId, role, String(content || ''), now]
  );
}

async function maybeUpdateThreadTitleFromMessage(threadId, message) {
  if (!chatDb) return;
  const normId = normalizeThreadId(threadId);
  if (!normId) return;
  const row = await dbGet('SELECT title FROM chat_threads WHERE id = ?', [normId]);
  if (!row || !row.title) return;
  if (!isDefaultChatTitle(row.title)) return;
  const candidate = String(message || '').trim();
  if (!candidate) return;
  const title = candidate.length > 60 ? `${candidate.slice(0, 57)}...` : candidate;
  await dbRun('UPDATE chat_threads SET title = ? WHERE id = ?', [title, normId]);
}

function isDefaultChatTitle(title) {
  const trimmed = String(title || '').trim();
  return trimmed === 'Chat' || trimmed.startsWith('Chat ');
}

function trimChatMessagesForModel(messages, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (!Array.isArray(messages) || !messages.length) return [];
  if (limit === 0) {
    return [messages[messages.length - 1]];
  }

  const out = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = String(msg && msg.content ? msg.content : '');
    if (i === messages.length - 1 && content.length > limit) {
      out.push({ ...msg, content: content.slice(-limit) });
      total = limit;
      break;
    }
    if (total + content.length > limit) continue;
    out.push(msg);
    total += content.length;
    if (total >= limit) break;
  }
  return out.reverse();
}

module.exports = {
  registerChatFeature
};
