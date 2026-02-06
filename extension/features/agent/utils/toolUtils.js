/**
 * Tool utilities for agent tool call management
 * Handles tool normalization, deduplication, formatting, and caching
 */

const { safeJsonParse, extractFirstJsonPayload } = require('../../../helpers/llm');

// Tool category constants
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

// Deduplication state - stored in module scope for testing isolation
let recentEdits = new Map();
const EDIT_COOLDOWN_MS = 5000;

// Duplicate attempt tracking - track how many times same edit attempted
let duplicateAttempts = new Map();
const DUPLICATE_ATTEMPT_LIMIT = 3;

// Read deduplication state - prevents repeated reads of identical ranges
let recentReads = new Map();
const READ_COOLDOWN_MS = 5000;

// Failure tracking state - prevents repeated failures
let failedOperations = new Map();
const FAILURE_LIMIT = 3;
const FAILURE_COOLDOWN_MS = 30000; // 30 seconds

/**
 * Check if query looks like a file path/name (no spaces, has extension or path separator)
 * @param {string} query - Search query
 * @returns {boolean} True if query looks like a file reference
 */
function isLikelyFileQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  if (/\s/.test(raw)) return false;
  if (raw.includes('/') || raw.includes('\\')) return true;
  return /\.([a-z0-9]{1,6})$/i.test(raw);
}

/**
 * Normalize a tool call by mapping container tools and converting search to locate_file when appropriate
 * @param {object} call - Raw tool call with tool and args
 * @returns {object} Normalized tool call
 */
function normalizeToolCall(call) {
  if (!call || typeof call.tool !== 'string') return call;
  const args = call.args && typeof call.args === 'object' ? { ...call.args } : {};
  const toolName = String(call.tool || '');
  
  if (toolName.startsWith('container.')) {
    const mapped = normalizeContainerToolCall(toolName, args);
    if (mapped) return mapped;
  }
  
  if (call.tool === 'search') {
    const query = String(args.query || '').trim();
    if (isLikelyFileQuery(query)) {
      return { tool: 'locate_file', args: { ...args, query } };
    }
  }

  // Sanitize path args: strip stray "lines X-Y" suffixes that the LLM may append.
  // Also extract startLine/endLine from the path when they are not already set.
  const TOOLS_WITH_PATH = new Set([
    'read_file', 'edit_file', 'write_file', 'insert_text', 'replace_range',
    'delete_file', 'file_stat', 'read_dir'
  ]);
  if (TOOLS_WITH_PATH.has(call.tool) && typeof args.path === 'string') {
    const linesMatch = /\s+lines?\s+(\d+)\s*-\s*(\d+)\b/i.exec(args.path);
    if (linesMatch) {
      // Extract line numbers if not already set
      if (!Number.isFinite(Number(args.startLine))) {
        args.startLine = Number(linesMatch[1]);
      }
      if (!Number.isFinite(Number(args.endLine))) {
        args.endLine = Number(linesMatch[2]);
      }
      // Strip the "lines X-Y" part(s) from the path
      args.path = args.path.replace(/\s+lines?\s+\d+\s*-\s*\d+\b/gi, '').trim();
    }
  }
  
  return { tool: call.tool, args };
}

/**
 * Map container.* tool calls to standard tools (primarily run_command)
 * @param {string} toolName - Tool name starting with 'container.'
 * @param {object} args - Tool arguments
 * @returns {object|null} Mapped tool call, or null if not mappable
 */
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
    'search', 'read_file', 'read_files', 'read_file_range_by_symbols', 'edit_file',
    'insert_text', 'replace_range', 'search_symbols', 'workspace_symbols', 'document_symbols',
    'definition', 'type_definition', 'implementation', 'references', 'hover', 'signature_help',
    'call_hierarchy_prepare', 'call_hierarchy_incoming', 'call_hierarchy_outgoing',
    'rename_prepare', 'rename_apply', 'semantic_tokens', 'locate_file', 'list_files',
    'file_stat', 'write_file', 'create_dir', 'delete_file', 'move_file', 'read_dir',
    'read_output', 'apply_patch_preview', 'copy_file', 'apply_patch', 'run_command'
  ]);
  
  if (passthrough.has(suffix)) {
    return { tool: suffix, args };
  }
  
  return null;
}

/**
 * Create a human-readable description of a tool call for logging/display
 * @param {object} call - Tool call with tool and args
 * @returns {string} Human-readable description
 */
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
  
  if (call.tool === 'edit_file') {
    const pathText = String(args.path || '').trim();
    const start = Number.isFinite(Number(args.startLine)) ? Number(args.startLine) : '';
    const end = Number.isFinite(Number(args.endLine)) ? Number(args.endLine) : '';
    const range = start && end ? ` lines ${start}-${end}` : '';
    return `Tool call: edit_file ${pathText}${range}`;
  }
  
  if (call.tool === 'run_command') {
    const cmd = String(args.command || '').trim();
    const cwd = String(args.cwd || '').trim();
    const lines = ['Tool call: run_command'];
    lines.push(`- command: \`${cmd || '(empty)'}\``);
    if (cwd) lines.push(`- cwd: \`${cwd}\``);
    return lines.join('\n');
  }
  
  // Add more specific tool descriptions as needed
  return `Tool call: ${call.tool}`;
}

/**
 * Create a compact summary of tool arguments for short display
 * @param {string} tool - Tool name
 * @param {object} args - Tool arguments
 * @returns {string} Compact argument summary
 */
function summarizeToolArgs(tool, args) {
  const safe = args && typeof args === 'object' ? args : {};
  
  if (tool === 'search') return String(safe.query || '').trim();
  if (tool === 'locate_file') return String(safe.query || safe.name || '').trim();
  
  if (tool === 'read_file') {
    const pathText = String(safe.path || '').trim();
    const start = Number.isFinite(Number(safe.startLine)) ? Number(safe.startLine) : '';
    const end = Number.isFinite(Number(safe.endLine)) ? Number(safe.endLine) : '';
    const range = start && end ? ` lines ${start}-${end}` : '';
    return `${pathText}${range}`.trim();
  }
  
  if (tool === 'run_command') {
    const cmd = String(safe.command || '').trim();
    const cwd = String(safe.cwd || '').trim();
    return cwd ? `${cmd} (cwd: ${cwd})` : cmd;
  }
  
  // Fallback: JSON stringify with length limit
  const raw = Object.keys(safe).length ? JSON.stringify(safe) : '';
  if (!raw) return '';
  return raw.length > 160 ? `${raw.slice(0, 160)}...` : raw;
}

/**
 * Check if an edit operation is a duplicate (same edit within cooldown period)
 * @param {object} normalizedCall - Normalized tool call
 * @returns {boolean|string} True if duplicate, or string message if repeated too many times
 */
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
    // Track duplicate attempts
    const attemptCount = (duplicateAttempts.get(key) || 0) + 1;
    duplicateAttempts.set(key, attemptCount);
    
    // Clean up old entries
    if (duplicateAttempts.size > 50) {
      const oldestKey = duplicateAttempts.keys().next().value;
      duplicateAttempts.delete(oldestKey);
    }
    
    // If attempted too many times, return a special message
    if (attemptCount >= DUPLICATE_ATTEMPT_LIMIT) {
      return `BLOCKED: This exact edit has been attempted ${attemptCount} times and is now permanently blocked. You MUST try a completely different approach or move on to the next task. Use read_file to verify the current state of ${normalizedCall.args?.path || 'the file'} first.`;
    }
    
    return true;
  }
  
  // Reset attempt counter if enough time has passed
  duplicateAttempts.delete(key);
  
  return false;
}

/**
 * Record an edit operation for deduplication tracking
 * @param {object} normalizedCall - Normalized tool call
 */
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

/**
 * Check if a read_file operation is a duplicate (same path/range within cooldown).
 * @param {object} normalizedCall - Normalized tool call
 * @returns {boolean}
 */
function isDuplicateRead(normalizedCall) {
  if (!normalizedCall || normalizedCall.tool !== 'read_file') return false;
  const key = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path,
    startLine: normalizedCall.args?.startLine,
    endLine: normalizedCall.args?.endLine
  });
  const lastRead = recentReads.get(key);
  if (lastRead && (Date.now() - lastRead) < READ_COOLDOWN_MS) {
    return true;
  }
  return false;
}

/**
 * Record a successful read_file operation for deduplication tracking.
 * @param {object} normalizedCall - Normalized tool call
 */
function recordRead(normalizedCall) {
  if (!normalizedCall || normalizedCall.tool !== 'read_file') return;
  const key = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path,
    startLine: normalizedCall.args?.startLine,
    endLine: normalizedCall.args?.endLine
  });
  recentReads.set(key, Date.now());
  if (recentReads.size > 50) {
    const oldestKey = recentReads.keys().next().value;
    recentReads.delete(oldestKey);
  }
}

/**
 * Clear recent read cache (use after mutations).
 */
function clearReadCache() {
  recentReads.clear();
}

/**
 * Check if an operation has failed repeatedly and should be blocked.
 * Uses both a specific key ({tool, path}) and a tool-only key to catch
 * failures that alternate between missing-path and with-path variants.
 * @param {object} normalizedCall - Normalized tool call
 * @returns {string|null} Error message if blocked, null otherwise
 */
function checkRepeatedFailure(normalizedCall) {
  const specificKey = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path
  });
  const toolOnlyKey = `tool-only:${normalizedCall.tool}`;
  
  const now = Date.now();
  const isRecent = (f) => (now - f.timestamp) < FAILURE_COOLDOWN_MS;

  // Check specific key
  const specificFailures = failedOperations.get(specificKey);
  if (specificFailures) {
    const recentSpecific = specificFailures.filter(isRecent);
    if (recentSpecific.length !== specificFailures.length) {
      if (recentSpecific.length === 0) failedOperations.delete(specificKey);
      else failedOperations.set(specificKey, recentSpecific);
    }
    if (recentSpecific.length >= FAILURE_LIMIT) {
      const lastError = recentSpecific[recentSpecific.length - 1].error;
      return `Skipped: This operation has failed ${recentSpecific.length} times. Last error: "${lastError}". Try a completely different approach.`;
    }
  }

  // Check tool-only key (aggregates all paths for the same tool)
  const toolFailures = failedOperations.get(toolOnlyKey);
  if (toolFailures) {
    const recentTool = toolFailures.filter(isRecent);
    if (recentTool.length !== toolFailures.length) {
      if (recentTool.length === 0) failedOperations.delete(toolOnlyKey);
      else failedOperations.set(toolOnlyKey, recentTool);
    }
    // Use a higher threshold for tool-only aggregation
    const toolLimit = FAILURE_LIMIT * 2;
    if (recentTool.length >= toolLimit) {
      const lastError = recentTool[recentTool.length - 1].error;
      return `Skipped: "${normalizedCall.tool}" has failed ${recentTool.length} times across different arguments. Last error: "${lastError}". Stop using this tool and try a completely different approach (e.g. use edit_file instead of write_file, or use a different strategy).`;
    }
  }
  
  return null;
}

/**
 * Record a failed operation for repeated failure detection.
 * Records under both a specific key ({tool, path}) and a tool-only key.
 * @param {object} normalizedCall - Normalized tool call
 * @param {string} errorMessage - Error message from tool
 */
function recordFailure(normalizedCall, errorMessage) {
  const specificKey = JSON.stringify({
    tool: normalizedCall.tool,
    path: normalizedCall.args?.path
  });
  const toolOnlyKey = `tool-only:${normalizedCall.tool}`;
  const entry = {
    timestamp: Date.now(),
    error: String(errorMessage).slice(0, 200) // Limit error message length
  };
  
  // Record under specific key
  const specificFailures = failedOperations.get(specificKey) || [];
  specificFailures.push(entry);
  failedOperations.set(specificKey, specificFailures);
  
  // Record under tool-only key
  const toolFailures = failedOperations.get(toolOnlyKey) || [];
  toolFailures.push({ ...entry });
  failedOperations.set(toolOnlyKey, toolFailures);
  
  // Clean up old entries
  if (failedOperations.size > 100) {
    const oldestKey = failedOperations.keys().next().value;
    failedOperations.delete(oldestKey);
  }
}

/**
 * Create a signature string for search deduplication.
 * Supports both buildSearchSignature(args) and buildSearchSignature(tool, args).
 * @param {string|object} toolOrArgs - Tool name or args object
 * @param {object} [maybeArgs] - Args object (when tool name provided)
 * @returns {string} JSON signature of search parameters
 */
function buildSearchSignature(toolOrArgs, maybeArgs) {
  const hasTool = typeof toolOrArgs === 'string' && maybeArgs && typeof maybeArgs === 'object';
  const tool = hasTool ? String(toolOrArgs || '').trim() : '';
  const args = hasTool ? maybeArgs : toolOrArgs;
  const safe = args && typeof args === 'object' ? args : {};
  const query = String(safe.query || '').trim();
  const include = String(safe.include || '**/*').trim() || '**/*';
  const exclude = String(safe.exclude || '**/node_modules/**').trim() || '**/node_modules/**';
  const maxResults = Number.isFinite(Number(safe.maxResults)) ? Number(safe.maxResults) : 20;
  return JSON.stringify({ tool, query, include, exclude, maxResults });
}

/**
 * Format tool result for UI display with appropriate code fencing
 * @param {string} tool - Tool name
 * @param {string} resultText - Tool result text
 * @returns {string} Formatted result for display
 */
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

/**
 * Truncate tool output to prevent message overflow
 * @param {string} text - Tool output
 * @param {number} maxChars - Maximum characters
 * @returns {string} Truncated text
 */
function limitToolOutput(text, maxChars) {
  const limit = Math.max(200, Number(maxChars || 12000));
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit) + '\n...[truncated]';
}

/**
 * Check if a tool result indicates success (no error prefix)
 * @param {string} resultText - Tool result text
 * @returns {boolean} True if result indicates success
 */
function isToolResultSuccess(resultText) {
  const raw = String(resultText || '').trim().toLowerCase();
  if (!raw) return true;
  
  const failurePrefixes = [
    'tool failed:', 'unknown tool:', 'invalid tool call', 'run failed:', 'command failed',
    'command canceled', 'copy canceled', 'copy failed:', 'move failed:', 'delete failed:',
    'write failed:', 'create dir failed:', 'edit failed:', 'insert text failed:',
    'replace range failed:', 'read failed:', 'read files failed:', 'read by symbols failed:',
    'list failed:', 'file stat failed:', 'read dir failed:', 'read output failed:',
    'apply patch failed:', 'apply patch preview failed:', 'patch check: failed',
    'git apply failed:', 'patch failed:', 'search failed:', 'search symbols failed:',
    'document symbols failed:', 'definition failed:', 'type definition failed:',
    'implementation failed:', 'references failed:', 'hover failed:', 'signature help failed:',
    'call hierarchy prepare failed:', 'call hierarchy incoming failed:',
    'call hierarchy outgoing failed:', 'rename prepare failed:', 'rename apply failed:',
    'semantic tokens failed:', 'locate file failed:', 'revert failed:'
  ];
  
  for (const prefix of failurePrefixes) {
    if (raw.startsWith(prefix)) return false;
  }
  
  return true;
}

/**
 * Check if search result indicates no matches found
 * @param {string} resultText - Search result text
 * @returns {boolean} True if search found nothing
 */
function isSearchResultMiss(resultText) {
  const raw = String(resultText || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw.startsWith('search failed:')) return true;
  if (raw.startsWith('search results: no matches')) return true;
  if (raw.startsWith('search redirected to locate_file') && raw.includes('locate file: no matches')) return true;
  return false;
}

/**
 * Reset the module-level edit deduplication map (for testing)
 */
function resetEditTracking() {
  recentEdits = new Map();
}

module.exports = {
  // Constants
  TOOL_READ,
  TOOL_WRITE,
  TOOL_SEARCH,
  TOOL_RUN,
  
  // Core functions
  isLikelyFileQuery,
  normalizeToolCall,
  normalizeContainerToolCall,
  describeToolCall,
  summarizeToolArgs,
  isDuplicateEdit,
  recordEdit,
  isDuplicateRead,
  recordRead,
  clearReadCache,
  checkRepeatedFailure,
  recordFailure,
  buildSearchSignature,
  formatToolResultForUi,
  limitToolOutput,
  isToolResultSuccess,
  isSearchResultMiss,
  // Testing utilities
  resetEditTracking
};
