/**
 * ActionPolicyPhase - Enforce read-before-write and tool policies
 *
 * This phase runs after ParsingPhase and can:
 * - Enforce single tool call during exploration (read/search only)
 * - Allow multiple tool calls during execution stage
 * - Block/redirect disallowed tools during pre-plan exploration (read/search only)
 * - Enforce read-before-write gating during execute stage (auto-redirect to read_file)
 */

const { PhaseResult } = require('../PhaseResult');
const { TOOL_READ, TOOL_SEARCH, TOOL_WRITE } = require('../utils/toolUtils');

function normalizePath(raw) {
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
      pendingOld = normalizePath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const nextPath = normalizePath(line.slice(4));
      return nextPath || pendingOld;
    }
  }
  return pendingOld;
}

function clampText(text, maxLen = 400) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, Math.max(0, maxLen - 3)) + '...';
}

class ActionPolicyPhase {
  async execute(context) {
    const { parsed } = context.data || {};
    if (!parsed) return PhaseResult.continue();

    const stage = String(context.stage || '').trim() || 'execute';
    const baseData = context.data && typeof context.data === 'object' ? context.data : {};

    // Enforce that "readyForPlan" short-circuits exploration tool calls.
    if (stage === 'explore' && parsed.readyForPlan === true) {
      if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length) {
        parsed.toolCalls = [];
      }
      return PhaseResult.continue({ ...baseData, readyForPlan: true });
    }

    // Auto-readyForPlan heuristic: if agent has read all diagnostic locations, signal readiness
    if (stage === 'explore' && context.prePlanHasSuccessfulAction) {
      const diagnosticLocations = this._extractDiagnosticLocations(context);
      if (diagnosticLocations.length > 0) {
        const allRead = diagnosticLocations.every(loc => 
          this._hasReadLocation(context, loc.path, loc.line)
        );
        if (allRead) {
          // All diagnostic locations have been read - auto-signal readyForPlan
          parsed.readyForPlan = true;
          if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length) {
            parsed.toolCalls = [];
          }
          return PhaseResult.continue({ ...baseData, readyForPlan: true, autoReadyForPlan: true });
        }
      }
    }

    if (!Array.isArray(parsed.toolCalls) || parsed.toolCalls.length === 0) {
      return PhaseResult.continue();
    }

    // Enforce single-action discipline during exploration only
    if (stage === 'explore' && parsed.toolCalls.length > 1) {
      parsed.toolCalls = [parsed.toolCalls[0]];
      context.addModelMessage({
        role: 'user',
        content: 'Reminder: during exploration, output exactly ONE tool call per response.'
      });
    }

    const call = parsed.toolCalls[0] || {};
    const tool = typeof call.tool === 'string' ? call.tool : '';
    const args = call.args && typeof call.args === 'object' ? call.args : {};

    if (stage === 'explore') {
      // Exploration is read/search only.
      const isAllowed = TOOL_READ.has(tool) || TOOL_SEARCH.has(tool);
      if (isAllowed) {
        // Duplicate-read detection: if agent is re-reading a file+range
        // already covered, force readyForPlan instead of wasting an iteration
        if (tool === 'read_file' && context.prePlanHasSuccessfulAction && args.path) {
          const targetPath = String(args.path);
          const reqStart = Number(args.startLine) || 1;
          const reqEnd = Number(args.endLine) || 200;
          const executions = Array.isArray(context.executedTools) ? context.executedTools : [];
          const alreadyCovered = executions.some(e => {
            if (e.tool !== 'read_file' || !e.args) return false;
            const ePath = String(e.args.path || '');
            if (ePath !== targetPath) return false;
            const eStart = Number(e.args.startLine) || 1;
            const eEnd = Number(e.args.endLine) || 200;
            return reqStart >= eStart && reqEnd <= eEnd;
          });
          if (alreadyCovered) {
            parsed.readyForPlan = true;
            parsed.toolCalls = [];
            return PhaseResult.continue({ ...baseData, readyForPlan: true, autoReadyForPlan: true, duplicateReadDetected: true });
          }
        }
        return PhaseResult.continue();
      }

      // Redirect file mutations to read_file when possible
      const isMutation = TOOL_WRITE.has(tool) || tool === 'rename_apply' || tool === 'run_command';
      if (isMutation) {
        const path = args.path
          ? String(args.path)
          : ((tool === 'apply_patch' || tool === 'apply_patch_preview') ? extractFirstPatchPath(args.patch) : '');
        if (path) {
          parsed.toolCalls = [{
            tool: 'read_file',
            args: { path, startLine: 1, endLine: 200 }
          }];
          context.addUiMessage({
            role: 'assistant',
            content: `Redirecting to read_file for ${path} (exploration is read-only).`
          });
          return PhaseResult.continue({ ...baseData, redirected: true });
        }
      }

      // Otherwise: retry with strict instructions
      context.addModelMessage({
        role: 'user',
        content:
`Error: During exploration you may ONLY use read/search tools and must output JSON only.

Return either:
- {"text":"...","toolCalls":[{"tool":"read_file","args":{"path":"...","startLine":1,"endLine":200}}]}
- {"text":"...","readyForPlan":true}

Disallowed tool: ${tool || '(missing tool)'}`
      });
      return PhaseResult.retry('Exploration action policy violation');
    }

    // Execute stage: reject unknown/invalid tool names immediately
    const ALL_KNOWN_TOOLS = new Set([
      ...TOOL_READ, ...TOOL_SEARCH, ...TOOL_WRITE,
      'run_command', 'rename_apply', 'rename_prepare'
    ]);
    if (!ALL_KNOWN_TOOLS.has(tool)) {
      context.addModelMessage({
        role: 'user',
        content: `Error: "${clampText(tool, 80)}" is not a valid tool name. Respond with valid JSON only.\n` +
          `Example: {"text":"Creating file","toolCalls":[{"tool":"write_file","args":{"path":"src/example.js","content":"// code"}}]}\n` +
          `Do NOT concatenate tool names with JSON. The tool name must be a standalone string in the "tool" field.`
      });
      return PhaseResult.retry(`Unknown tool: ${tool}`);
    }

    // Execute stage: enforce read-before-write gating for file mutations
    const isWriteFile = tool === 'write_file';
    const isMutatingWriteFile = isWriteFile && (args.overwrite === true || args.append === true);
    const isAlwaysMutating = new Set(['edit_file', 'insert_text', 'replace_range', 'apply_patch', 'apply_patch_preview']).has(tool);
    const isMutation = isAlwaysMutating || isMutatingWriteFile;

    if (!isMutation) {
      return PhaseResult.continue();
    }

    // Exemption: creating a brand new file is allowed without read
    const isNewFileCreate = isWriteFile && args.overwrite !== true && args.append !== true;
    if (isNewFileCreate) {
      return PhaseResult.continue();
    }

    const targetPath = args.path
      ? String(args.path)
      : ((tool === 'apply_patch' || tool === 'apply_patch_preview') ? extractFirstPatchPath(args.patch) : '');

    if (!targetPath) {
      context.addModelMessage({
        role: 'user',
        content: 'Error: Mutation tool call missing a target file path. Include args.path, or use read_file first to determine the correct target.'
      });
      return PhaseResult.retry('Missing mutation target path');
    }

    const hasRead = typeof context.hasReadSinceLastWrite === 'function'
      ? context.hasReadSinceLastWrite(targetPath)
      : false;

    if (hasRead) {
      return PhaseResult.continue();
    }

    // Auto-redirect to read_file.
    // Pre-record the read so the LLM's next edit proposal passes the
    // hasReadSinceLastWrite gate (fixes infinite read→edit→redirect loop).
    parsed.toolCalls = [{
      tool: 'read_file',
      args: { path: targetPath, startLine: 1, endLine: 200 }
    }];

    if (typeof context.incrementActionSeq === 'function') {
      context.incrementActionSeq();
    }
    if (typeof context.recordFileRead === 'function') {
      context.recordFileRead(targetPath);
    }

    context.addUiMessage({
      role: 'assistant',
      content: `Redirecting to read_file for ${targetPath} (read-before-write).`
    });

    context.addModelMessage({
      role: 'user',
      content:
`Read-before-write policy: you attempted to modify ${targetPath} without reading it since the last edit.
The file will now be read. After reviewing the content, propose the minimal edit.`
    });

    return PhaseResult.continue({ ...baseData, redirected: true });
  }

  /**
   * Extract diagnostic file locations from model messages.
   * Format: path:line:col [type] (code) - message
   * @private
   */
  _extractDiagnosticLocations(context) {
    const locations = [];
    const messages = context.modelMessages || [];
    
    for (const msg of messages) {
      const content = msg.content || '';
      if (!content.includes('Workspace Errors')) continue;
      
      // Match pattern: src/App.jsx:67:21 [ts] (1005) - message
      const regex = /([^:\s]+):(\d+):(\d+)\s+\[[^\]]+\]\s+\(\d+\)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        locations.push({
          path: match[1],
          line: parseInt(match[2], 10),
          col: parseInt(match[3], 10)
        });
      }
    }
    
    return locations;
  }

  /**
   * Check if a file location has been read since exploration started.
   * @private
   */
  _hasReadLocation(context, targetPath, targetLine) {
    if (!context.readActions) return false;
    
    // Check if the file has been read
    const readSeq = context.readActions[targetPath];
    if (!readSeq) return false;
    
    // Check if we have detailed read information from executed tools
    if (!context.executedTools || !Array.isArray(context.executedTools)) return true;
    
    // Look for read_file calls that covered this line
    for (const toolExec of context.executedTools) {
      if (toolExec.tool === 'read_file' && toolExec.args && toolExec.args.path === targetPath) {
        const startLine = toolExec.args.startLine || 1;
        const endLine = toolExec.args.endLine || Infinity;
        if (targetLine >= startLine && targetLine <= endLine) {
          return true;
        }
      }
    }
    
    // If we have a read action but no specific line info, assume the file was read
    return true;
  }
}

module.exports = { ActionPolicyPhase };
