const vscode = require('vscode');
const path = require('path');

const {
  isDebugEnabled,
  getMethodReviewConfig,
  getChatHistoryCharLimit,
  getAgentMaxSteps,
  getAgentPrePlanMaxSteps,
  getChatMaxSteps,
  isAgentMemoryEnabled,
  getAgentMemoryCharLimit,
  getDebugLoopMaxIterations,
  shouldSkipFeatureMapping
} = require('../helpers/config');
const { getOutputChannel, updateTokenEstimate } = require('../helpers/output');
const { buildMethodDependencyContext, updateSelectionContextsForEdit, buildChatContextBlock, normalizeContextList, normalizeContextEntry, buildContextId } = require('../helpers/context');
const { getWorkspaceRoot, resolveWorkspacePathForTool, toWorkspaceRelativePath } = require('../helpers/workspace');
const { safeJsonParse, extractFirstJsonPayload, extractAssistantText, postChatCompletions } = require('../helpers/llm');
const { createToolRunner, limitToolOutput } = require('../tools/agentTools');
const { updateAiSugarState } = require('./aiSugar');
const { buildSystemPrompt, CHAT_TOOL_NAMES, AGENT_TOOL_NAMES } = require('../helpers/prompts');
const { ChatDatabase } = require('../helpers/chatDb');

// Import agent utilities (parsing, tool utils, plan utils, ReAct utilities)
const {
  parseAgentResponse,
  parseTaggedToolCalls,
  extractToolCallsFromText,
  extractLooseToolCalls
} = require('./agent/utils/parsing');
const {
  normalizeToolCall,
  formatToolResultForUi
} = require('./agent/utils/toolUtils');
const {
  mergePlanLists
} = require('./agent/utils/planUtils');
// ReAct + Evidence Ladder utilities
const { discoverTestCommand, parseTestOutput } = require('./agent/utils/testUtils');
const { discoverBuildCommand, parseBuildOutput } = require('./agent/utils/buildUtils');


/** @type {vscode.ExtensionContext | undefined} */
let extensionContext;
/** @type {vscode.WebviewView | undefined} */
let chatView;
let chatViewInitialized = false;
/** @type {vscode.WebviewPanel | undefined} */
let htmlPreviewPanel;
/** @type {{ mode: 'chat'|'planner'|'agent', contexts: any[], messages: Array<{ role: 'user'|'assistant', content: string }>, modelMessages?: Array<{ role: 'user'|'assistant', content: string }>, plan: any[], approvals: any[], model?: string, markdownPlan?: string, awaitingHumanInput?: boolean, pendingQuestion?: string }} */
let chatState = { mode: 'chat', contexts: [], messages: [], modelMessages: [], plan: [], approvals: [], model: '' };
let chatBusy = false;
const chatDatabase = new ChatDatabase();
/** @type {Array<{ id: string, title: string, updatedAt: string }>} */
let chatThreads = [];
/** @type {string} */
let chatThreadFilter = '';
/** @type {Array<{ id: string, title: string, updatedAt: string }> | null} */
let chatThreadResults = null;
/** @type {string | null} */
let activeChatThreadId = null;
let chatWebviewReady = false;
let toolRunner;
const pendingApprovals = new Map();
const approvalQueue = [];
let stopRequested = false;
let activeAbortController = null;
let agentContinuationMessages = null;
let lastDebugStackItem = null;
let lastDebugSession = null;
let debugListenEnabled = false;
const DEBUG_CONTEXT_ID = 'debug_snapshot_live';
const recentEdits = new Map();
const EDIT_COOLDOWN_MS = 5000;
const AGENT_MEMORY_CONTEXT_ID = 'agent_memory_summary';
const AGENT_MEMORY_TITLE = 'Agent Memory';
let chatModelOptions = [];
const TOOL_MESSAGE_MAX = 40;
const TOOL_READ = new Set([
  'read_file',
  'read_files',
  'read_file_range_by_symbols',
  'read_dir',
  'read_output',
  'file_stat',
  'definition',
  'type_definition',
  'implementation',
  'references',
  'hover',
  'signature_help',
  'call_hierarchy_prepare',
  'call_hierarchy_incoming',
  'call_hierarchy_outgoing',
  'semantic_tokens'
]);
const TOOL_WRITE = new Set([
  'edit_file',
  'insert_text',
  'replace_range',
  'write_file',
  'create_dir',
  'delete_file',
  'move_file',
  'copy_file',
  'apply_patch',
  'apply_patch_preview'
]);
const TOOL_SEARCH = new Set([
  'search',
  'locate_file',
  'search_symbols',
  'workspace_symbols',
  'document_symbols',
  'list_files'
]);
const TOOL_RUN = new Set(['run_command']);

function truncateText(value, maxLen) {
  const raw = String(value || '');
  const limit = Math.max(0, Number(maxLen || TOOL_MESSAGE_MAX));
  if (!raw || raw.length <= limit) return raw;
  if (limit <= 3) return raw.slice(0, limit);
  return raw.slice(0, limit - 3) + '...';
}

function basenameFromPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function normalizePatchPath(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed === '/dev/null') return '';
  const unquoted = trimmed.replace(/^"+|"+$/g, '');
  return unquoted.replace(/^[ab]\//, '');
}

function extractFirstPatchPath(patch) {
  const lines = String(patch || '').split(/\r?\n/);
  let pendingOld = '';
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      pendingOld = normalizePatchPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const nextPath = normalizePatchPath(line.slice(4));
      return nextPath || pendingOld;
    }
  }
  return pendingOld;
}

function getToolFileLabel(tool, args) {
  const safe = args && typeof args === 'object' ? args : {};
  if (tool === 'read_files') {
    const paths = Array.isArray(safe.paths) ? safe.paths.filter(Boolean) : [safe.paths].filter(Boolean);
    const first = paths[0];
    const suffix = paths.length > 1 ? ` (+${paths.length - 1})` : '';
    const base = basenameFromPath(first);
    return base ? `${base}${suffix}` : '';
  }
  if (tool === 'copy_file' || tool === 'move_file') {
    return basenameFromPath(safe.to || safe.from);
  }
  if (tool === 'apply_patch' || tool === 'apply_patch_preview') {
    return basenameFromPath(extractFirstPatchPath(safe.patch));
  }
  if (tool === 'read_output') {
    return 'output';
  }
  const pathValue = safe.path || safe.uri;
  return basenameFromPath(pathValue);
}

function buildToolSugarState(tool, args) {
  if (!tool || typeof tool !== 'string') return null;
  if (TOOL_RUN.has(tool)) {
    const rawCommand = String(args && args.command ? args.command : '').replace(/\s+/g, ' ').trim();
    const prefix = 'Running: ';
    const maxCmd = Math.max(0, TOOL_MESSAGE_MAX - prefix.length);
    const commandText = truncateText(rawCommand || 'command', maxCmd);
    return { message: truncateText(prefix + commandText, TOOL_MESSAGE_MAX), attractorStrength: 2 };
  }
  if (TOOL_WRITE.has(tool)) {
    const fileLabel = getToolFileLabel(tool, args);
    const label = fileLabel ? `Writing file: ${fileLabel}` : 'Writing file';
    return { message: truncateText(label, TOOL_MESSAGE_MAX), attractorStrength: 3 };
  }
  if (TOOL_READ.has(tool)) {
    const fileLabel = getToolFileLabel(tool, args);
    const label = fileLabel ? `Reading file: ${fileLabel}` : 'Reading file';
    return { message: truncateText(label, TOOL_MESSAGE_MAX), attractorStrength: 1 };
  }
  if (TOOL_SEARCH.has(tool)) {
    return { message: 'Searching', attractorStrength: 0 };
  }
  return null;
}

async function runToolWithSugar(tool, args, runner) {
  const sugar = buildToolSugarState(tool, args);
  if (sugar) {
    const next = { attractorStrength: sugar.attractorStrength };
    if (sugar.message) next.toolMessage = sugar.message;
    updateAiSugarState(next);
  }
  try {
    return await runner();
  } finally {
    if (sugar && sugar.attractorStrength) {
      updateAiSugarState({ attractorStrength: 0 });
    }
  }
}

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

function requestChatApproval({ title, details, approveLabel, cancelLabel, messageIndex }) {
  return new Promise((resolve) => {
    // Skip approvals in agent mode - agent should proceed automatically
    if (chatState.mode === 'agent') {
      resolve(true);
      return;
    }
    
    const id = `approve_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    pendingApprovals.set(id, { resolve });
    // Default to the last message index if not specified
    const actualIndex = typeof messageIndex === 'number' ? messageIndex : Math.max(0, chatState.messages.length - 1);
    const payload = {
      type: 'approval',
      id,
      title: String(title || 'Approve action'),
      details,
      approveLabel: approveLabel || 'Approve',
      cancelLabel: cancelLabel || 'Cancel',
      messageIndex: actualIndex
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

  // Initialize database
  chatDatabase.initialize(context).then((storedId) => {
    if (storedId) {
      activeChatThreadId = storedId;
    }
  }).catch((err) => {
    vscode.window.showErrorMessage(`CodeCritic: Failed to initialize chat database. ${String(err.message || err)}`);
  });

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
        async resolveWebviewView(view) {
          chatView = view;
          chatViewInitialized = true;

          const localRoots = extensionContext
            ? [vscode.Uri.joinPath(extensionContext.extensionUri, 'media')]
            : [];
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: localRoots
          };
          view.webview.html = await getChatHtml(view.webview);

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
      chatDatabase.dispose();
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
  const viewThreads = chatThreadFilter ? (chatThreadResults || []) : chatThreads;
  return {
    mode: chatState.mode,
    contexts: chatState.contexts,
    plan: chatState.plan,
    approvals: chatState.approvals,
    messages: chatState.messages,
    busy: chatBusy,
    threads: viewThreads,
    threadsFiltered: Boolean(chatThreadFilter),
    threadsTotal: chatThreads.length,
    threadFilter: chatThreadFilter,
    activeThreadId: activeChatThreadId,
    activeThreadTitle: chatDatabase.getActiveThreadTitle(activeChatThreadId, chatThreads, chatThreadResults),
    debugListenEnabled,
    models: getChatModelOptions(),
    activeModel: getActiveChatModel(),
    awaitingHumanInput: chatState.awaitingHumanInput || false,
    pendingQuestion: chatState.pendingQuestion || null,
    markdownPlan: chatState.markdownPlan || null
  };
}

async function ensureChatReady() {
  await chatDatabase.ensureReady();
  
  chatThreads = await chatDatabase.refreshThreads();
  
  if (!activeChatThreadId || !chatThreads.find((t) => t.id === activeChatThreadId)) {
    const first = chatThreads[0];
    activeChatThreadId = first ? first.id : null;
  }
  
  if (!activeChatThreadId) {
    const title = chatDatabase.defaultChatTitle();
    activeChatThreadId = await chatDatabase.createThread({ title, context: null, plan: [] });
  }
  
  if (activeChatThreadId) {
    const threadData = await chatDatabase.loadThread(activeChatThreadId);
    if (threadData) {
      chatState.messages = threadData.messages;
      chatState.contexts = threadData.contexts;
      chatState.plan = threadData.plan;
      chatState.approvals = [];
    }
    await chatDatabase.persistActiveThreadId(extensionContext, activeChatThreadId);
  }
}

async function refreshChatThreads() {
  chatThreads = await chatDatabase.refreshThreads();
  
  if (chatThreadFilter) {
    try {
      chatThreadResults = await chatDatabase.queryThreadsByFilter(chatThreadFilter);
    } catch (err) {
      const out = getOutputChannel();
      out.appendLine(`CodeCritic thread filter refresh failed: ${String(err && err.message ? err.message : err)}`);
      out.show(true);
      chatThreadResults = [];
    }
  } else {
    chatThreadResults = null;
  }
}

async function createChatThread({ title, context, plan }) {
  const id = await chatDatabase.createThread({ title, context, plan });
  if (id) {
    activeChatThreadId = id;
    await chatDatabase.persistActiveThreadId(extensionContext, activeChatThreadId);
  }
  await refreshChatThreads();
  return id;
}

async function loadChatThread(threadId) {
  const threadData = await chatDatabase.loadThread(threadId);
  if (!threadData) return;
  
  chatState.messages = threadData.messages;
  chatState.contexts = threadData.contexts;
  chatState.plan = threadData.plan;
  chatState.approvals = [];
}

async function selectChatThread(threadId) {
  await ensureChatReady();
  const normId = chatDatabase.normalizeThreadId(threadId);
  if (!normId) return;
  
  activeChatThreadId = normId;
  await chatDatabase.persistActiveThreadId(extensionContext, activeChatThreadId);
  await loadChatThread(normId);
  postChatState();
}

async function deleteChatThread(threadId) {
  await chatDatabase.deleteThread(threadId);
  
  const normId = chatDatabase.normalizeThreadId(threadId);
  if (activeChatThreadId === normId) {
    activeChatThreadId = null;
  }
  
  await refreshChatThreads();
  
  if (!activeChatThreadId || !chatThreads.find((t) => t.id === activeChatThreadId)) {
    const first = chatThreads[0];
    activeChatThreadId = first ? first.id : null;
  }
  
  if (!activeChatThreadId) {
    const title = chatDatabase.defaultChatTitle();
    activeChatThreadId = await createChatThread({ title, context: null, plan: [] });
  }
  
  if (activeChatThreadId) {
    await loadChatThread(activeChatThreadId);
    await chatDatabase.persistActiveThreadId(extensionContext, activeChatThreadId);
  }
}

async function clearChatMessages(threadId) {
  await chatDatabase.clearMessages(threadId);
}

async function updateChatThreadContext(threadId, context) {
  await chatDatabase.updateThreadContext(threadId, context);
}

async function updateChatThreadPlan(threadId, plan) {
  await chatDatabase.updateThreadPlan(threadId, plan);
}

async function touchChatThread(threadId) {
  await chatDatabase.touchThread(threadId);
}

async function addChatMessage(threadId, role, content) {
  await chatDatabase.addMessage(threadId, role, content);
}

async function maybeUpdateThreadTitleFromMessage(threadId, message) {
  await chatDatabase.maybeUpdateThreadTitle(threadId, message);
}

async function applyThreadFilter(query) {
  chatThreadFilter = String(query || '').trim();
  if (!chatThreadFilter) {
    chatThreadResults = null;
    return;
  }
  try {
    chatThreadResults = await chatDatabase.queryThreadsByFilter(chatThreadFilter);
  } catch (err) {
    const out = getOutputChannel();
    out.appendLine(`CodeCritic thread filter failed: ${String(err && err.message ? err.message : err)}`);
    out.show(true);
    chatThreadResults = [];
  }
}

async function persistActiveChatThreadId() {
  if (!extensionContext) return;
  await chatDatabase.persistActiveThreadId(extensionContext, activeChatThreadId);
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
    if (msg.mode === 'chat' || msg.mode === 'planner' || msg.mode === 'agent') {
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

  if (msg.type === 'clearTodos') {
    chatState.plan = [];
    chatState.markdownPlan = null;
    if (activeChatThreadId) {
      await updateChatThreadPlan(activeChatThreadId, []);
      await touchChatThread(activeChatThreadId);
    }
    postChatState();
    return;
  }

  if (msg.type === 'togglePlanItemStatus') {
    const itemId = String(msg.itemId || '');
    if (itemId && chatState.mode === 'planner') {
      chatState.plan = chatState.plan.map(item => {
        if (item.id === itemId) {
          return { ...item, status: item.status === 'done' ? 'pending' : 'done' };
        }
        return item;
      });
      if (activeChatThreadId) {
        await updateChatThreadPlan(activeChatThreadId, chatState.plan);
        await touchChatThread(activeChatThreadId);
      }
      postChatState();
    }
    return;
  }

  if (msg.type === 'updatePlanItem') {
    const itemId = String(msg.itemId || '');
    const newText = String(msg.text || '').trim();
    if (itemId && newText && chatState.mode === 'planner') {
      chatState.plan = chatState.plan.map(item => {
        if (item.id === itemId) {
          return { ...item, text: newText };
        }
        return item;
      });
      if (activeChatThreadId) {
        await updateChatThreadPlan(activeChatThreadId, chatState.plan);
        await touchChatThread(activeChatThreadId);
      }
      postChatState();
    }
    return;
  }

  if (msg.type === 'deletePlanItem') {
    const itemId = String(msg.itemId || '');
    if (itemId && chatState.mode === 'planner') {
      chatState.plan = chatState.plan.filter(item => item.id !== itemId);
      if (activeChatThreadId) {
        await updateChatThreadPlan(activeChatThreadId, chatState.plan);
        await touchChatThread(activeChatThreadId);
      }
      postChatState();
    }
    return;
  }

  if (msg.type === 'addPlanItem') {
    const text = String(msg.text || '').trim();
    if (text && chatState.mode === 'planner') {
      const maxId = chatState.plan.reduce((max, item) => {
        const num = parseInt(item.id.replace(/\D/g, ''), 10);
        return !isNaN(num) && num > max ? num : max;
      }, 0);
      const newItem = {
        id: `plan_${maxId + 1}`,
        text,
        status: 'pending'
      };
      chatState.plan = [...chatState.plan, newItem];
      if (activeChatThreadId) {
        await updateChatThreadPlan(activeChatThreadId, chatState.plan);
        await touchChatThread(activeChatThreadId);
      }
      postChatState();
    }
    return;
  }

  if (msg.type === 'newThread') {
    await ensureChatReady();
    setAgentContinuation(null);
    const title = chatDatabase.defaultChatTitle();
    const newId = await createChatThread({ title, context: null, plan: [] });
    if (newId) {
      await loadChatThread(newId);
    }
    if (debugListenEnabled) {
      await refreshDebugSnapshot();
    }
    postChatState();
    return;
  }

  if (msg.type === 'confirmDeleteThread') {
    const threadTitle = msg.threadTitle || 'this chat';
    const result = await vscode.window.showWarningMessage(
      `Delete "${threadTitle}"?`,
      { modal: true },
      'Delete'
    );
    if (result === 'Delete') {
      await ensureChatReady();
      await deleteChatThread(msg.threadId);
      if (debugListenEnabled) {
        await refreshDebugSnapshot();
      }
      postChatState();
    }
    return;
  }

  if (msg.type === 'deleteThread') {
    await ensureChatReady();
    await deleteChatThread(msg.threadId);
    if (debugListenEnabled) {
      await refreshDebugSnapshot();
    }
    postChatState();
    return;
  }

  if (msg.type === 'filterThreads') {
    await ensureChatReady();
    await applyThreadFilter(msg.query);
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

  if (msg.type === 'previewHtml') {
    const raw = String(msg.code || '');
    const trimmed = raw.trim();
    const isFullDoc = /^\s*<!doctype/i.test(trimmed) || /^\s*<html/i.test(trimmed);
    const targetColumn = vscode.ViewColumn.Beside;
    if (!htmlPreviewPanel) {
      htmlPreviewPanel = vscode.window.createWebviewPanel(
        'htmlPreview',
        'HTML Preview',
        targetColumn,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      htmlPreviewPanel.onDidDispose(() => {
        htmlPreviewPanel = undefined;
      });
    } else {
      htmlPreviewPanel.reveal(targetColumn, true);
    }
    htmlPreviewPanel.webview.html = isFullDoc ? raw : `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTML Preview</title>
    <style>
        body {
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
    </style>
</head>
<body>
    ${raw}
</body>
</html>`;
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
    
    // Check if agent is awaiting human input
    const isRespondingToAgent = chatState.awaitingHumanInput && agentContinuationMessages;
    
    const isContinuation = isContinuationRequest(text) || isRespondingToAgent;
    const continuationMessages = isContinuation ? agentContinuationMessages : null;
    if (!isContinuation) {
      setAgentContinuation(null);
    }
    
    // Clear awaiting human input state when user responds
    if (isRespondingToAgent) {
      chatState.awaitingHumanInput = false;
      chatState.pendingQuestion = null;
    }
    
    stopRequested = false;
    await ensureChatReady();
    if (!activeChatThreadId) {
      const title = chatDatabase.defaultChatTitle();
      activeChatThreadId = await createChatThread({
        title,
        context: chatState.contexts,
        plan: chatState.plan
      });
    }
    chatBusy = true;
    let sugarOutcome = 'success';
    const markSugarFailure = () => { sugarOutcome = 'failure'; };
    const markSugarStopped = () => { sugarOutcome = null; };
    updateAiSugarState({ thinking: true, outcome: null });
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
        const problemsCmd = !debugCmd && !searchCmd && !symbolsCmd ? parseProblemsCommand(text) : null;
        const commandType = debugCmd ? 'debugger' : (searchCmd ? 'search' : (symbolsCmd ? 'symbols' : (problemsCmd ? 'problems' : '')));
        const commandQuery = debugCmd
          ? debugCmd.query
          : (searchCmd ? searchCmd.query : (symbolsCmd ? symbolsCmd.query : (problemsCmd ? problemsCmd.query : '')));

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
        } else if (problemsCmd) {
          const problemsPayload = await buildProblemsContextMessage();
          commandMessages.push({ role: 'assistant', content: problemsPayload });
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
            : (commandType === 'symbols' ? 'Use the symbol search results above.' : (commandType === 'problems' ? 'Analyze and help fix these errors.' : '')));
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
        const agentStatus = await runAgentTurn(baseWithTools, modelMessages);
        if (agentStatus === 'failure') {
          markSugarFailure();
        } else if (agentStatus === 'stopped') {
          markSugarStopped();
        }
        const newMessages = chatState.messages.slice(beforeCount);
        if (threadId) {
          for (const newMsg of newMessages) {
            await addChatMessage(threadId, newMsg.role, newMsg.content);
          }
          await touchChatThread(threadId);
          await refreshChatThreads();
        }
      } else {
        // Chat or Planner mode - use strategy pattern
        const beforeCount = baseMessages.length;
        let status;
        
        if (chatState.mode === 'chat') {
          status = await runChatTurn(baseMessages, text, threadId);
        } else if (chatState.mode === 'planner') {
          status = await runPlannerTurn(baseMessages, text, threadId);
        }
        
        if (status === 'failure') {
          markSugarFailure();
        } else if (status === 'stopped') {
          markSugarStopped();
        }
        
        // Persist new messages to thread
        const newMessages = chatState.messages.slice(beforeCount);
        if (threadId) {
          for (const newMsg of newMessages) {
            await addChatMessage(threadId, newMsg.role, newMsg.content);
          }
          await touchChatThread(threadId);
          await refreshChatThreads();
        }
      }
    } catch (err) {
      if (stopRequested || (err && err.name === 'AbortError')) {
        stopRequested = false;
        chatBusy = false;
        markSugarStopped();
        postChatState();
        return;
      }
      markSugarFailure();
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
      updateAiSugarState({ thinking: false, outcome: sugarOutcome });
      postChatState();
    }
  }

  if (msg.type === 'stop') {
    stopRequested = true;
    setAgentContinuation(null);
    updateAiSugarState({ thinking: false, outcome: null });
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

function parseProblemsCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.toLowerCase().startsWith('/problems')) return null;
  const rest = raw.slice('/problems'.length).trim();
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
  const searchArgs = {
    query: text,
    include: '**/*',
    exclude: '**/node_modules/**',
    maxResults: 20
  };
  const result = await runToolWithSugar('search', searchArgs, () => getToolRunner().toolSearch(searchArgs));
  return formatToolResultForUi('search', result);
}

async function buildSymbolsContextMessage(query) {
  const text = String(query || '').trim();
  const symbolsArgs = { query: text, maxResults: 20 };
  const result = await runToolWithSugar('search_symbols', symbolsArgs, () => getToolRunner().toolSearchSymbols(symbolsArgs));
  return formatToolResultForUi('search_symbols', result);
}

async function buildProblemsContextMessage() {
  const diagnostics = vscode.languages.getDiagnostics();
  const errors = [];
  for (const [uri, diags] of diagnostics) {
    if (!diags || !diags.length) continue;
    const rel = toWorkspaceRelativePath(uri.fsPath);
    for (const diag of diags) {
      // Only include errors, not warnings or info
      if (diag.severity !== vscode.DiagnosticSeverity.Error) continue;
      if (errors.length >= 100) break;
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const source = diag.source ? ` [${diag.source}]` : '';
      const code = diag.code ? ` (${diag.code})` : '';
      errors.push(`${rel}:${line}:${col}${source}${code} - ${diag.message}`);
    }
    if (errors.length >= 100) break;
  }
  
  if (!errors.length) {
    return formatToolResultForUi('problems', 'No errors found in workspace.');
  }
  
  const output = `Workspace Errors (${errors.length}):\n` + errors.join('\n');
  return formatToolResultForUi('problems', output);
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

function isTrivialAgentFinal(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'stopped.') return true;
  if (raw.startsWith('error:')) return true;
  return false;
}

function trimAgentMemoryText(text) {
  const limit = getAgentMemoryCharLimit();
  if (!limit) return '';
  const raw = String(text || '');
  if (!raw.trim()) return '';
  if (raw.length <= limit) return raw.trim();
  const tail = raw.slice(raw.length - limit);
  return tail.replace(/^\s+/, '').trimEnd();
}

function formatAgentOutcomeMemory(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || isTrivialAgentFinal(trimmed)) return '';
  const compact = trimmed.replace(/\s+/g, ' ').trim();
  const limit = 600;
  const excerpt = compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
  const stamp = new Date().toISOString();
  return `Outcome @ ${stamp}\n${excerpt}`;
}

async function appendAgentMemory(entryText) {
  if (!isAgentMemoryEnabled()) return;
  const limit = getAgentMemoryCharLimit();
  if (!limit) return;
  const entry = String(entryText || '').trim();
  if (!entry) return;
  
  try {
    await chatDatabase.ensureReady();
  } catch {
    return;
  }
  
  if (!activeChatThreadId) return;
  
  const existing = chatState.contexts.find((ctx) => String(ctx.id) === AGENT_MEMORY_CONTEXT_ID);
  const existingContent = existing && existing.content ? String(existing.content) : '';
  if (existingContent && existingContent.trim().endsWith(entry)) {
    return;
  }
  const merged = existingContent ? `${existingContent}\n\n${entry}` : entry;
  const content = trimAgentMemoryText(merged);
  const nextEntry = {
    ...(existing || {}),
    id: AGENT_MEMORY_CONTEXT_ID,
    kind: existing && existing.kind ? existing.kind : 'note',
    title: existing && existing.title ? existing.title : AGENT_MEMORY_TITLE,
    content
  };
  chatState.contexts = existing
    ? chatState.contexts.map((ctx) => (String(ctx.id) === AGENT_MEMORY_CONTEXT_ID ? nextEntry : ctx))
    : [...chatState.contexts, nextEntry];
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

async function applyPlanUpdate(plan) {
  const merged = mergePlanLists(chatState.plan, plan);
  chatState.plan = merged;
  if (activeChatThreadId) {
    await updateChatThreadPlan(activeChatThreadId, chatState.plan);
  }
  postChatState();
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
      const searchArgs = { query: term, include: '**/*', exclude: '**/node_modules/**', maxResults: 20 };
      const textResults = await runToolWithSugar('search', searchArgs, () => getToolRunner().toolSearch(searchArgs));
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


function isToolResultSuccess(resultText) {
  const raw = String(resultText || '').trim().toLowerCase();
  if (!raw) return true;
  const failurePrefixes = [
    'tool failed:',
    'unknown tool:',
    'invalid tool call',
    'run failed:',
    'command failed',
    'command canceled',
    'copy canceled',
    'copy failed:',
    'move failed:',
    'delete failed:',
    'write failed:',
    'create dir failed:',
    'edit failed:',
    'insert text failed:',
    'replace range failed:',
    'read failed:',
    'read files failed:',
    'read by symbols failed:',
    'list failed:',
    'file stat failed:',
    'read dir failed:',
    'read output failed:',
    'apply patch failed:',
    'apply patch preview failed:',
    'patch check: failed',
    'git apply failed:',
    'patch failed:',
    'search failed:',
    'search symbols failed:',
    'document symbols failed:',
    'definition failed:',
    'type definition failed:',
    'implementation failed:',
    'references failed:',
    'hover failed:',
    'signature help failed:',
    'call hierarchy prepare failed:',
    'call hierarchy incoming failed:',
    'call hierarchy outgoing failed:',
    'rename prepare failed:',
    'rename apply failed:',
    'semantic tokens failed:',
    'locate file failed:',
    'revert failed:'
  ];
  for (const prefix of failurePrefixes) {
    if (raw.startsWith(prefix)) return false;
  }
  return true;
}

function isSearchResultMiss(resultText) {
  const raw = String(resultText || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw.startsWith('search failed:')) return true;
  if (raw.startsWith('search results: no matches')) return true;
  if (raw.startsWith('search redirected to locate_file') && raw.includes('locate file: no matches')) return true;
  return false;
}

function buildSearchSignature(args) {
  const safe = args && typeof args === 'object' ? args : {};
  const query = String(safe.query || '').trim();
  const include = String(safe.include || '**/*').trim() || '**/*';
  const exclude = String(safe.exclude || '**/node_modules/**').trim() || '**/node_modules/**';
  const maxResults = Number.isFinite(Number(safe.maxResults)) ? Number(safe.maxResults) : 20;
  return JSON.stringify({ query, include, exclude, maxResults });
}

function isLikelyFileQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return true;
  return /\\.([a-z0-9]{1,6})$/i.test(raw);
}

function normalizeContainerToolCall(toolName, args) {
  const raw = String(toolName || '');
  const suffix = raw.startsWith('container.') ? raw.slice('container.'.length) : raw;
  if (suffix === 'exec' || suffix === 'exe' || suffix === 'run') {
    const cmd = args.cmd != null ? args.cmd : args.command;
    let command = '';
    if (Array.isArray(cmd)) {
      if (cmd.length >= 3 && cmd[0] === 'bash' && cmd[1] === '-lc') {
        command = cmd.slice(2).join(' ').trim();
      } else {
        command = cmd.join(' ').trim();
      }
    } else if (typeof cmd === 'string') {
      command = cmd.trim();
    }
    const cwd = typeof args.cwd === 'string' ? args.cwd : (typeof args.workdir === 'string' ? args.workdir : '');
    return { tool: 'run_command', args: { command, cwd } };
  }

  const passthrough = new Set([
    'search',
    'read_file',
    'read_files',
    'read_file_range_by_symbols',
    'edit_file',
    'insert_text',
    'replace_range',
    'search_symbols',
    'workspace_symbols',
    'document_symbols',
    'definition',
    'type_definition',
    'implementation',
    'references',
    'hover',
    'signature_help',
    'call_hierarchy_prepare',
    'call_hierarchy_incoming',
    'call_hierarchy_outgoing',
    'rename_prepare',
    'rename_apply',
    'semantic_tokens',
    'locate_file',
    'list_files',
    'file_stat',
    'write_file',
    'create_dir',
    'delete_file',
    'move_file',
    'read_dir',
    'read_output',
    'apply_patch_preview',
    'copy_file',
    'apply_patch',
    'run_command'
  ]);
  if (passthrough.has(suffix)) {
    return { tool: suffix, args };
  }
  return null;
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

function isDuplicateEdit(normalizedCall) {
  if (!TOOL_WRITE.has(normalizedCall.tool)) return false;
  
  const key = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path,
    startLine: normalizedCall.args?.startLine,
    endLine: normalizedCall.args?.endLine,
    newText: normalizedCall.args?.newText || normalizedCall.args?.text || normalizedCall.args?.content
  });
  
  const lastEdit = recentEdits.get(key);
  if (lastEdit && (Date.now() - lastEdit) < EDIT_COOLDOWN_MS) {
    return true;
  }
  
  return false;
}

function recordEdit(normalizedCall) {
  const key = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path,
    startLine: normalizedCall.args?.startLine,
    endLine: normalizedCall.args?.endLine,
    newText: normalizedCall.args?.newText || normalizedCall.args?.text || normalizedCall.args?.content
  });
  
  recentEdits.set(key, Date.now());
  
  // Clean up old entries
  if (recentEdits.size > 50) {
    const oldestKey = recentEdits.keys().next().value;
    recentEdits.delete(oldestKey);
  }
}

const { AgentStrategy, AgentContext, ChatStrategy, ChatContext, PlannerStrategy, PlannerContext } = require('./agent');

async function runAgentTurn(baseMessages, modelMessagesSeed) {
  const workspaceRoot = getWorkspaceRoot();
  
  // Create agent context with dependency injection
  const context = new AgentContext({
    baseMessages,
    modelMessages: modelMessagesSeed,
    deps: {
      // Configuration
      getAgentMaxSteps,
      getAgentPrePlanMaxSteps,
      getChatHistoryCharLimit,
      getDebugLoopMaxIterations,
      shouldSkipFeatureMapping,
      
      // State access
      chatState,
      stopRequested: () => stopRequested,
      clearStopFlag: () => { stopRequested = false; chatBusy = false; },
      
      // LLM interaction (callModelForChat is the main one, callLLM is an alias for ReAct phases)
      callModelForChat,
      callLLM: async (messages, optionsOrMode = {}) => {
        // Wrapper for ReAct phases that expect different signatures:
        // 1. callLLM(messages, { temperature, max_tokens })
        // 2. callLLM(messages, mode)
        // -> callModelForChat({ messages, mode, context })
        
        // Handle both object options and string mode
        const mode = typeof optionsOrMode === 'string' ? optionsOrMode : 'agent';
        
        return await callModelForChat({
          messages: Array.isArray(messages) ? messages : [],
          mode: mode,
          context: chatState.contexts || []
        });
      },
      trimChatMessagesForModel,
      
      // Streaming helpers
      streamMarkdown: async (markdown) => {
        // Add markdown content to chat UI messages
        // Ensure messages array exists
        if (!chatState.messages) {
          chatState.messages = [];
        }
        chatState.messages.push({
          role: 'assistant',
          content: markdown
        });
        postChatState();
      },
      
      // Tool execution
      runToolCall,
      getToolRunner,
      
      // Plan management
      applyPlanUpdate,
      
      // State updates
      postChatState,
      setAgentContinuation,
      
      // Memory and diagnostics
      isAgentMemoryEnabled,
      appendAgentMemory,
      formatAgentOutcome: (messages, finalText) => {
        // Format outcome for memory storage
        return `Agent completed task: ${finalText.slice(0, 200)}`;
      },
      collectWorkspaceProblems,
      
      // ReAct + Evidence Ladder
      getWorkspaceRoot: () => workspaceRoot,
      discoverTestCommand: async () => {
        try {
          return await discoverTestCommand(workspaceRoot, async (filePath) => {
            const uri = vscode.Uri.file(filePath);
            const bytes = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(bytes).toString('utf8');
          });
        } catch (err) {
          return null;
        }
      },
      discoverBuildCommand: async () => {
        try {
          return await discoverBuildCommand(
            workspaceRoot,
            async (filePath) => {
              const uri = vscode.Uri.file(filePath);
              const bytes = await vscode.workspace.fs.readFile(uri);
              return Buffer.from(bytes).toString('utf8');
            },
            async (filePath) => {
              try {
                const uri = vscode.Uri.file(filePath);
                await vscode.workspace.fs.stat(uri);
                return true;
              } catch {
                return false;
              }
            }
          );
        } catch (err) {
          return null;
        }
      },
      parseTestOutput: (output, runner, exitCode) => {
        try {
          return parseTestOutput(output, runner, exitCode);
        } catch (err) {
          return { passed: exitCode === 0, error: String(err.message || err) };
        }
      },
      parseBuildOutput: (output, tool, exitCode) => {
        try {
          return parseBuildOutput(output, tool, exitCode);
        } catch (err) {
          return { success: exitCode === 0, error: String(err.message || err) };
        }
      }
    }
  });
  
  // Create and run strategy
  const strategy = new AgentStrategy();
  const result = await strategy.run(context);
  
  return result;
}

async function runChatTurn(baseMessages, userText, threadId) {
  const context = new ChatContext({
    baseMessages,
    modelMessages: baseMessages,
    deps: {
      // Configuration
      getChatMaxSteps,
      getChatHistoryCharLimit,
      
      // State access
      chatState,
      stopRequested: () => stopRequested,
      clearStopFlag: () => { stopRequested = false; chatBusy = false; },
      
      // LLM interaction
      callModelForChat,
      trimChatMessagesForModel,
      
      // Tool execution
      runToolCall,
      getToolRunner,
      describeToolCall,
      
      // Plan management
      applyPlanUpdate,
      
      // State updates
      postChatState,
      setAgentContinuation,
      
      // Thread persistence
      threadId,
      addChatMessage,
      touchChatThread,
      refreshChatThreads,
      
      // Command context
      buildDebuggerContextMessage,
      buildSearchContextMessage,
      buildSymbolsContextMessage,
      buildProblemsContextMessage,
      
      // Smart search
      searchWorkspaceSymbols,
      PREFERRED_SYMBOL_KINDS,
      isNoiseSymbol,
      formatSymbolResultMarkdown,
      runToolWithSugar,
      formatToolResultForUi
    }
  });
  
  const strategy = new ChatStrategy(userText);
  const result = await strategy.run(context);
  
  return result;
}

async function runPlannerTurn(baseMessages, userText, threadId) {
  const context = new PlannerContext({
    baseMessages,
    modelMessages: baseMessages,
    deps: {
      // Configuration
      getChatMaxSteps,
      getChatHistoryCharLimit,
      
      // State access
      chatState,
      stopRequested: () => stopRequested,
      clearStopFlag: () => { stopRequested = false; chatBusy = false; },
      
      // LLM interaction
      callModelForChat,
      trimChatMessagesForModel,
      
      // Tool execution
      runToolCall,
      getToolRunner,
      describeToolCall,
      
      // Plan management
      applyPlanUpdate,
      
      // State updates
      postChatState,
      setAgentContinuation,
      
      // Thread persistence
      threadId,
      addChatMessage,
      touchChatThread,
      refreshChatThreads,
      
      // Command context
      buildDebuggerContextMessage,
      buildSearchContextMessage,
      buildSymbolsContextMessage,
      buildProblemsContextMessage,
      
      // Smart search
      searchWorkspaceSymbols,
      PREFERRED_SYMBOL_KINDS,
      isNoiseSymbol,
      formatSymbolResultMarkdown,
      runToolWithSugar,
      formatToolResultForUi
    }
  });
  
  const strategy = new PlannerStrategy(userText);
  const result = await strategy.run(context);
  
  return result;
}

async function runToolCall(call) {
  const tool = call && typeof call.tool === 'string' ? call.tool : '';
  const args = call && typeof call.args === 'object' ? call.args : {};
  return await runToolWithSugar(tool, args, async () => {
    try {
      return await getToolRunner().runToolCall(call);
    } catch (err) {
      return `Tool failed: ${String(err && err.message ? err.message : err)}`;
    }
  });
}

async function callModelForChat({ messages, mode, context }) {
  const cfg = vscode.workspace.getConfiguration('codeCritic');
  const baseUrl = (cfg.get('ollamaBaseUrl', 'http://127.0.0.1:11434/v1') || '').replace(/\/+$/, '');
  const model = getActiveChatModel();

  const system = buildSystemPrompt(mode, context);
  const allMessages = [{ role: 'system', content: system }, ...messages];

  const body = {
    model,
    messages: allMessages,
    temperature: 0.2,
    tool_choice: 'auto'
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

async function getChatHtml(webview) {
  const scriptUri = extensionContext
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chat.js'))
    : '';
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}`;
  const chatViewPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'views', 'chatView.html');
  const bytes = await vscode.workspace.fs.readFile(chatViewPath);
  let html = Buffer.from(bytes).toString('utf8');
  html = html.replace('${csp}', csp).replace('${scriptUri}', String(scriptUri));
  return html;
}

function trimChatMessagesForModel(messages, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (!Array.isArray(messages) || !messages.length) return [];
  if (limit === 0) {
    return [messages[messages.length - 1]];
  }

  // Smart trimming: preserve critical messages, aggressively trim tool results
  const critical = [];
  const optional = [];
  const recent = [];
  
  const recentThreshold = Math.max(0, messages.length - 5);
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = String(msg && msg.content ? msg.content : '');
    
    // Always keep recent messages
    if (i >= recentThreshold) {
      recent.push(msg);
      continue;
    }
    
    // Preserve critical message types
    if (msg.role === 'user' ||
        content.includes('Execution Plan') ||
        content.includes('Workspace problems') ||
        content.startsWith('Outcome @') ||
        (content.startsWith('Tool result (problems)')) ||
        (i === 0)) {
      critical.push(msg);
    } else if (content.startsWith('Tool result') || content.startsWith('Tool call:')) {
      // Tool results are optional, can be trimmed first
      // Compress long tool results
      if (content.length > 1000) {
        const lines = content.split('\n');
        const header = lines[0];
        const truncated = lines.slice(1, 6).join('\n');
        optional.push({ ...msg, content: `${header}\n${truncated}\n...[trimmed ${content.length} chars]` });
      } else {
        optional.push(msg);
      }
    } else {
      critical.push(msg);
    }
  }
  
  // Calculate sizes
  let criticalSize = critical.reduce((sum, m) => sum + String(m.content || '').length, 0);
  const recentSize = recent.reduce((sum, m) => sum + String(m.content || '').length, 0);
  const remaining = limit - criticalSize - recentSize;
  
  // Include as many optional messages as fit
  const included = [];
  let optionalSize = 0;
  for (const msg of optional.reverse()) {
    const size = String(msg.content || '').length;
    if (optionalSize + size <= remaining) {
      included.unshift(msg);
      optionalSize += size;
    }
  }
  
  const result = [...critical, ...included, ...recent];
  
  // Final size check - if still too large, trim from optional
  const totalSize = result.reduce((sum, m) => sum + String(m.content || '').length, 0);
  if (totalSize > limit) {
    const out = [];
    let total = 0;
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      const content = String(msg && msg.content ? msg.content : '');
      if (i === result.length - 1 && content.length > limit) {
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
  
  return result;
}

module.exports = {
  registerChatFeature
};
