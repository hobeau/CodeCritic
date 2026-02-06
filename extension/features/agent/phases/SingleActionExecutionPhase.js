/**
 * SingleActionExecutionPhase (Phase D) - Execute tool call(s) per iteration
 * 
 * Executes one or more tool calls sequentially. Stops early on first failure.
 * During exploration, ActionPolicyPhase limits to a single call.
 * During execution, multiple calls are allowed for batching related fixes.
 */

const { PhaseResult } = require('../PhaseResult');
const {
  normalizeToolCall,
  describeToolCall,
  summarizeToolArgs,
  isDuplicateEdit,
  recordEdit,
  isDuplicateRead,
  recordRead,
  clearReadCache,
  buildSearchSignature,
  formatToolResultForUi,
  limitToolOutput,
  isToolResultSuccess,
  isSearchResultMiss,
  checkRepeatedFailure,
  recordFailure,
  TOOL_READ,
  TOOL_WRITE,
  TOOL_SEARCH
} = require('../utils/toolUtils');
const { addProgressLogEntry } = require('../utils/MarkdownPlanManager');

function clampText(value, maxLen = 400) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, Math.max(0, maxLen - 3)) + '...';
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

/**
 * Validate that required args are present for a tool call.
 * Returns an error message string if validation fails, or null if OK.
 */
function validateRequiredToolArgs(tool, args) {
  const TOOLS_REQUIRING_PATH = new Set([
    'read_file', 'edit_file', 'write_file', 'delete_file', 'insert_text',
    'replace_range', 'file_stat', 'read_dir', 'copy_file'
  ]);
  if (TOOLS_REQUIRING_PATH.has(tool)) {
    const pathArg = tool === 'copy_file' ? 'from' : 'path';
    const pathVal = String(args[pathArg] || '').trim();
    if (!pathVal) {
      return `${tool} requires a "${pathArg}" argument. Provide the file path, e.g.: {"tool":"${tool}","args":{"${pathArg}":"src/example.js"}}`;
    }
  }
  // write_file MUST have content – without it, an empty file gets created.
  if (tool === 'write_file') {
    const contentVal = args.content;
    if (contentVal === undefined || contentVal === null || String(contentVal).trim() === '') {
      return 'write_file requires both "path" and "content" arguments. The content argument must contain the full file text. Respond with JSON: {"tool":"write_file","args":{"path":"src/example.js","content":"// file content here..."}}';
    }
  }
  // edit_file MUST have startLine and endLine as numbers.
  if (tool === 'edit_file') {
    const sl = Number(args.startLine);
    const el = Number(args.endLine);
    if (!Number.isFinite(sl) || !Number.isFinite(el)) {
      return 'edit_file requires "startLine" and "endLine" as numbers, plus "newText". Respond with JSON: {"tool":"edit_file","args":{"path":"src/App.jsx","startLine":5,"endLine":5,"newText":"import Foo from \\"./Foo\\";\\n"}}';
    }
  }
  if (tool === 'move_file') {
    if (!String(args.from || '').trim()) {
      return 'move_file requires a "from" argument with the source path.';
    }
    if (!String(args.to || '').trim()) {
      return 'move_file requires a "to" argument with the destination path.';
    }
  }
  if (tool === 'run_command') {
    if (!String(args.command || '').trim()) {
      return 'run_command requires a "command" argument.';
    }
  }
  if ((tool === 'search' || tool === 'locate_file' || tool === 'search_symbols' || tool === 'workspace_symbols') && !String(args.query || '').trim()) {
    return `${tool} requires a "query" argument.`;
  }
  return null;
}

function formatActionForModel(call) {
  if (!call || typeof call.tool !== 'string') return '(invalid tool call)';
  const tool = call.tool;
  const args = call.args && typeof call.args === 'object' ? call.args : {};

  const toolWithArg = (argText) => {
    const suffix = String(argText || '').trim();
    return suffix ? `${tool} ${suffix}` : tool;
  };

  if (tool === 'read_file') {
    const path = String(args.path || '').trim();
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : null;
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : null;
    const range = start != null && end != null ? `lines ${start}-${end}` : '';
    return toolWithArg([path, range].filter(Boolean).join(' '));
  }

  if (tool === 'read_files') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    return toolWithArg(`${paths.length} file(s)`);
  }

  if (tool === 'search' || tool === 'locate_file' || tool === 'search_symbols' || tool === 'workspace_symbols') {
    const query = String(args.query || '').trim();
    return toolWithArg(query ? `query="${clampText(query, 160)}"` : '');
  }

  if (tool === 'run_command') {
    const cmd = String(args.command || '').trim();
    const cwd = String(args.cwd || '').trim();
    const cmdText = cmd ? `command="${clampText(cmd, 200)}"` : '';
    const cwdText = cwd ? `cwd="${clampText(cwd, 120)}"` : '';
    return toolWithArg([cmdText, cwdText].filter(Boolean).join(' '));
  }

  if (tool === 'edit_file') {
    const path = String(args.path || '').trim();
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : null;
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : null;
    const range = start != null && end != null ? `lines ${start}-${end}` : '';
    return toolWithArg([path, range].filter(Boolean).join(' '));
  }

  if (tool === 'insert_text') {
    const path = String(args.path || '').trim();
    const pos = args.position && typeof args.position === 'object' ? args.position : {};
    const line = Number.isFinite(Number(pos.line)) ? Number(pos.line) : null;
    const character = Number.isFinite(Number(pos.character)) ? Number(pos.character) : null;
    const at = line != null ? `at ${line}:${character != null ? character : 1}` : '';
    return toolWithArg([path, at].filter(Boolean).join(' '));
  }

  if (tool === 'replace_range') {
    const path = String(args.path || '').trim();
    const range = args.range && typeof args.range === 'object' ? args.range : {};
    const startLine = Number.isFinite(Number(range.startLine)) ? Number(range.startLine) : null;
    const endLine = Number.isFinite(Number(range.endLine)) ? Number(range.endLine) : null;
    const rangeText = startLine != null && endLine != null ? `range ${startLine}-${endLine}` : '';
    return toolWithArg([path, rangeText].filter(Boolean).join(' '));
  }

  if (tool === 'write_file') {
    const path = String(args.path || '').trim();
    const flags = [];
    if (args.overwrite === true) flags.push('overwrite');
    if (args.append === true) flags.push('append');
    const flagText = flags.length ? `(${flags.join(', ')})` : '';
    return toolWithArg([path, flagText].filter(Boolean).join(' '));
  }

  if (tool === 'apply_patch' || tool === 'apply_patch_preview') {
    const path = extractFirstPatchPath(args.patch);
    const cwd = String(args.cwd || '').trim();
    const cwdText = cwd ? `cwd="${clampText(cwd, 120)}"` : '';
    return toolWithArg([path, cwdText].filter(Boolean).join(' '));
  }

  // Generic fallback: include a compact args summary but avoid large payloads.
  const compact = summarizeToolArgs(tool, args);
  return toolWithArg(clampText(compact, 200));
}

class SingleActionExecutionPhase {
  /**
   * Execute tool call(s)
   * - Execute all tool calls sequentially
   * - Stop early on first failure
   * - Update progress log with evidence
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue result with observation
   */
  async execute(context) {
    const { parsed, displayText } = context.data || {};
    
    if (!parsed || !parsed.toolCalls || !parsed.toolCalls.length) {
      return PhaseResult.continue();
    }

    context.setCurrentPhase('D');
    
    // Add display text if present
    if (displayText && displayText.trim()) {
      context.addUiMessage({ role: 'assistant', content: clampText(displayText, 400) });
    }
    
    const allObservations = [];
    let anyMutation = false;
    let anySucceeded = false;
    let lastActionTaken = null;

    for (let i = 0; i < parsed.toolCalls.length; i++) {
      const rawCall = parsed.toolCalls[i];
      const normalizedCall = normalizeToolCall(rawCall);
      
      // Describe the action
      const description = describeToolCall(normalizedCall);
      context.addUiMessage({ role: 'assistant', content: description });

      // Record Action for the model-visible ReAct trajectory
      context.addModelMessage({
        role: 'assistant',
        content: `**Action**: ${clampText(formatActionForModel(normalizedCall), 500)}`
      });
      
      // Execute the action
      const result = await this.executeToolCall(normalizedCall, context);
      
      // Record execution
      if (context.recordToolExecution) {
        context.recordToolExecution(normalizedCall, result);
      }
      
      // Observe: Collect and format results
      const observation = this.observeResults(normalizedCall, result, context);
      allObservations.push(observation);
      
      const toolSucceeded = this.isToolCallSuccessful(result);
      if (toolSucceeded && typeof context.incrementActionSeq === 'function') {
        context.incrementActionSeq();
        this.recordReadWriteTracking(context, normalizedCall);
      }
      if (toolSucceeded) anySucceeded = true;
      lastActionTaken = normalizedCall.tool;

      // Track if this was a successful mutation
      const isMutation = toolSucceeded && this.isMutatingAction(normalizedCall);
      if (isMutation) {
        anyMutation = true;
        context.markMutation();
        clearReadCache();
        context.markEvidenceStale();
        this.recordActionInProgressLog(context, normalizedCall, observation);
      }
      
      // Add observation to model context
      context.addModelMessage({
        role: 'user',
        content: `**Observation**: ${observation}`
      });

      // Stop executing remaining calls on failure
      if (!toolSucceeded) {
        const remaining = parsed.toolCalls.length - i - 1;
        if (remaining > 0) {
          context.addModelMessage({
            role: 'user',
            content: `${remaining} remaining tool call(s) skipped due to the failure above.`
          });
        }
        break;
      }
    }
    
    const combinedObservation = allObservations.join('\n\n');
    
    return PhaseResult.continue({
      observation: combinedObservation,
      actionTaken: lastActionTaken,
      isMutation: anyMutation,
      singleActionComplete: true,
      toolSucceeded: anySucceeded
    });
  }

  /**
   * Track successful reads/writes for read-before-write gating.
   * @private
   */
  recordReadWriteTracking(context, normalizedCall) {
    const tool = normalizedCall && typeof normalizedCall.tool === 'string' ? normalizedCall.tool : '';
    const args = normalizedCall && normalizedCall.args && typeof normalizedCall.args === 'object' ? normalizedCall.args : {};

    // Reads
    if (TOOL_READ.has(tool)) {
      if (tool === 'read_files') {
        const paths = Array.isArray(args.paths) ? args.paths : (args.paths ? [args.paths] : []);
        for (const path of paths) {
          if (typeof context.recordFileRead === 'function' && path) {
            context.recordFileRead(path);
          }
        }
        return;
      }
      const readPath = args.path || args.uri;
      if (typeof context.recordFileRead === 'function' && readPath) {
        context.recordFileRead(readPath);
      }
      return;
    }

    // Writes
    if (TOOL_WRITE.has(tool) || tool === 'rename_apply') {
      let writePath = args.path || args.file || args.to;
      if (!writePath && (tool === 'apply_patch' || tool === 'apply_patch_preview')) {
        writePath = extractFirstPatchPath(args.patch);
      }
      if (typeof context.recordFileWrite === 'function' && writePath) {
        context.recordFileWrite(writePath);
      }
    }
  }

  /**
   * Execute a single tool call
   * @private
   */
  async executeToolCall(normalizedCall, context) {
    const { tool, args } = normalizedCall;
    
    try {
      // Check for repeated failures FIRST — this catches tools that keep failing
      // regardless of duplicate status, preventing infinite retry loops
      const blockedMessage = checkRepeatedFailure(normalizedCall);
      if (blockedMessage) {
        return {
          success: false,
          error: blockedMessage,
          isBlocked: true
        };
      }

      // Check for duplicate edits
      if (TOOL_WRITE.has(tool)) {
        const dupResult = isDuplicateEdit(normalizedCall);
        if (dupResult) {
          // isDuplicateEdit returns true for simple dups, or a detailed string after threshold
          const errorMsg = typeof dupResult === 'string'
            ? dupResult
            : 'Duplicate edit detected - this exact edit was already performed. STOP retrying this edit. Use read_file to verify the current file state, then move on.';
          // Also record as a failure so checkRepeatedFailure can escalate
          recordFailure(normalizedCall, errorMsg);
          return { 
            success: false, 
            error: errorMsg,
            isDuplicate: true
          };
        }
        recordEdit(normalizedCall);
      }
      
      // Check for duplicate commands
      if (tool === 'run_command') {
        const signature = JSON.stringify(args);
        if (context.isDuplicateCommand(signature)) {
          return {
            success: false,
            error: 'Duplicate command detected - no mutations occurred since last run',
            isDuplicate: true
          };
        }
        context.trackCommandSignature(signature);
      }
      
      // Check for duplicate searches
      if (TOOL_SEARCH.has(tool)) {
        const signature = buildSearchSignature(tool, args);
        if (context.isDuplicateSearch(signature)) {
          return {
            success: false,
            error: 'Duplicate search detected - no mutations occurred since last search miss',
            isDuplicate: true
          };
        }
      }

      if (tool === 'read_file' && isDuplicateRead(normalizedCall)) {
        return {
          success: false,
          error: 'Duplicate read detected - file already read without changes. Proceed to edit or choose a different action.',
          isDuplicate: true
        };
      }

      // Validate required args before execution
      const missingArgMsg = validateRequiredToolArgs(tool, args);
      if (missingArgMsg) {
        return {
          success: false,
          error: missingArgMsg
        };
      }
      
      // Execute the tool
      const result = await context.deps.runToolCall({ tool, args });
      
      // Track search misses
      if (TOOL_SEARCH.has(tool)) {
        const signature = buildSearchSignature(tool, args);
        const wasMiss = isSearchResultMiss(result);
        context.trackSearchSignature(signature, wasMiss);
      }

      if (tool === 'read_file') {
        const resultText = result && typeof result === 'object' && result.result !== undefined
          ? result.result
          : result;
        if (isToolResultSuccess(resultText)) {
          recordRead(normalizedCall);
        }
      }
      
      return result;
    } catch (error) {
      return {
        success: false,
        error: String(error.message || error)
      };
    }
  }

  /**
   * Observe and format results
   * @private
   */
  observeResults(normalizedCall, result, context) {
    const { tool, args } = normalizedCall;
    
    // Extract actual result string (handle both string and object formats)
    let resultText = result;
    if (result && typeof result === 'object') {
      // Handle error object format: { success: false, error: "..." }
      if (result.success === false) {
        recordFailure(normalizedCall, result.error || 'Unknown error');
        return `**Failed**: ${tool} - ${result.error || 'Unknown error'}`;
      }
      // Handle success object format: { success: true, result: "..." } or just { result: "..." }
      if (result.result !== undefined) {
        resultText = result.result;
      } else {
        // Fallback: convert object to string
        resultText = JSON.stringify(result, null, 2);
      }
    }
    
    // Check for failures in string format
    const success = isToolResultSuccess(resultText);
    if (!success) {
      recordFailure(normalizedCall, resultText);
      return `**Failed**: ${tool} - ${resultText}`;
    }
    
    // Format result for display
    const formatted = formatToolResultForUi(tool, resultText);
    const limited = limitToolOutput(formatted);
    
    // Add to UI
    context.addUiMessage({ role: 'assistant', content: limited });
    
    return limited;
  }

  /**
   * Determine if a tool call succeeded
   * @private
   */
  isToolCallSuccessful(result) {
    if (result && typeof result === 'object') {
      return result.success !== false;
    }
    return isToolResultSuccess(result);
  }

  /**
   * Check if action is a mutation
   * @private
   */
  isMutatingAction(normalizedCall) {
    const mutatingTools = new Set([...TOOL_WRITE, 'rename_apply', 'run_command']);
    return mutatingTools.has(normalizedCall.tool);
  }

  /**
   * Record action in progress log
   * @private
   */
  recordActionInProgressLog(context, normalizedCall, observation) {
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan) return;
    
    const { tool, args } = normalizedCall;
    const actionDesc = `${tool} on ${args.path || args.file || args.command || 'workspace'}`;
    const entry = `${actionDesc} → ${observation.substring(0, 100)}`;
    
    const { plan: updatedPlan, evidenceId } = addProgressLogEntry(parsedPlan, entry);
    context.updateParsedPlan(updatedPlan);
    
    return evidenceId;
  }

}

module.exports = { SingleActionExecutionPhase };
