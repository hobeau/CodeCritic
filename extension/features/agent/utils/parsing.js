/**
 * Parsing utilities for agent responses
 * Extracts tool calls and structured data from LLM responses
 */

const { safeJsonParse, extractFirstJsonPayload } = require('../../../helpers/llm');
const { normalizePlanList } = require('./planUtils');

/**
 * Extract multi-line content from lines following an **Action**: line.
 * Handles both fenced code blocks (```...```) and raw text after the action line.
 * Used for write_file and edit_file where the LLM puts file content on subsequent lines.
 *
 * @param {string} fullText - The complete LLM response text
 * @param {string} actionLine - The matched action line to find in fullText
 * @returns {string|null} Extracted content, or null if no content found
 */
function extractContentAfterActionLine(fullText, actionLine) {
  const lines = String(fullText || '').split(/\r?\n/);
  const actionIdx = lines.findIndex(line => line === actionLine);
  if (actionIdx < 0 || actionIdx >= lines.length - 1) return null;

  const remaining = lines.slice(actionIdx + 1);
  if (!remaining.length) return null;

  // Check for fenced code block (```...```)
  const firstNonEmpty = remaining.findIndex(l => l.trim().length > 0);
  if (firstNonEmpty < 0) return null;

  const firstLine = remaining[firstNonEmpty].trim();
  if (firstLine.startsWith('```')) {
    // Extract content inside the code fence
    const fenceStart = firstNonEmpty;
    let fenceEnd = -1;
    for (let i = fenceStart + 1; i < remaining.length; i++) {
      if (remaining[i].trim().startsWith('```')) {
        fenceEnd = i;
        break;
      }
    }
    if (fenceEnd > fenceStart + 1) {
      const content = remaining.slice(fenceStart + 1, fenceEnd).join('\n');
      if (content.trim().length > 0) return content;
    }
    // Fence with no closing — take everything after the opening fence
    if (fenceEnd === -1) {
      const content = remaining.slice(fenceStart + 1).join('\n');
      if (content.trim().length > 0) return content;
    }
  }

  // No code fence — take all remaining non-empty lines as content
  // Stop at known markers like **Observation**: or another **Action**:
  // Also stop at system-injected observation text (Write succeeded, diffs, revert tokens, etc.)
  const stopPatterns = [
    /^\s*\*\*Observation\*\*/i,
    /^\s*\*\*Action\*\*/i,
    /^\s*Observation\s*:/i,
    /^\s*Action\s*:/i,
    /^Write succeeded:/i,
    /^Write failed:/i,
    /^Edit applied:/i,
    /^Edit failed:/i,
    /^\[\[revert:/i,
    /^```diff\b/i,
    /^\*\*Validation Evidence\*\*/i,
    /^\*\*Completion Status\*\*/i,
    /^\*\*Next steps\*\*/i,
    /^[✗✓]/,
  ];
  const contentLines = [];
  for (const line of remaining) {
    if (stopPatterns.some(p => p.test(line))) break;
    contentLines.push(line);
  }
  const content = contentLines.join('\n').trim();
  return content.length > 0 ? contentLines.join('\n') : null;
}

/**
 * Parse space-separated named tokens for edit_file from the "rest" portion of an action line.
 * Handles patterns like:
 *   `src/App.jsx startLine 5 endLine 54 newText "import Foo from './Foo';"
 *   `src/App.jsx newText "import Foo;" lines 4-4`
 *   `src/App.jsx lines 4-4`
 * Returns parsed args object or null if the pattern doesn't match.
 *
 * @param {string} rest - The text after the tool name
 * @returns {object|null} Parsed args with path, startLine, endLine, and optionally newText
 */
function parseEditFileNamedTokens(rest) {
  if (!rest || typeof rest !== 'string') return null;

  // Try "startLine N endLine N" format first
  const startLineIdx = rest.search(/\bstartLine\b/i);
  // Try "lines N-N" format as fallback
  const linesIdx = rest.search(/\blines?\s+\d+\s*-\s*\d+\b/i);

  if (startLineIdx < 0 && linesIdx < 0) return null;

  // Determine which format is used
  let path, afterPath;
  if (startLineIdx >= 0) {
    // "startLine N endLine N" format
    path = rest.slice(0, startLineIdx).trim();
    afterPath = rest.slice(startLineIdx);
  } else {
    // "lines N-N" format
    path = rest.slice(0, linesIdx).trim();
    afterPath = rest.slice(linesIdx);
  }

  // Strip newText "..." from path if it's embedded there
  // e.g. path = 'src/App.jsx newText "import StockPrice..."'
  const newTextInPathMatch = /\s+newText\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|.+)$/i.exec(path);
  if (newTextInPathMatch) {
    path = path.slice(0, newTextInPathMatch.index).trim();
  }

  if (!path) return null;

  const args = { path };

  // Extract startLine/endLine from whichever format matched
  if (startLineIdx >= 0) {
    const slMatch = /\bstartLine\s+(\d+)\b/i.exec(afterPath);
    const elMatch = /\bendLine\s+(\d+)\b/i.exec(afterPath);
    if (!slMatch || !elMatch) return null;
    args.startLine = Number(slMatch[1]);
    args.endLine = Number(elMatch[1]);
  } else {
    const linesMatch = /\blines?\s+(\d+)\s*-\s*(\d+)\b/i.exec(afterPath);
    if (!linesMatch) return null;
    args.startLine = Number(linesMatch[1]);
    args.endLine = Number(linesMatch[2]);
  }

  // Extract newText from either the afterPath section or the newTextInPathMatch
  const ntSource = newTextInPathMatch ? newTextInPathMatch[0] : afterPath;
  const ntQuotedMatch = /\bnewText\s+"((?:[^"\\]|\\.)*)"/i.exec(ntSource) ||
                         /\bnewText\s+'((?:[^'\\]|\\.)*)'/i.exec(ntSource);
  if (ntQuotedMatch) {
    args.newText = ntQuotedMatch[1].replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  } else {
    // Match newText followed by unquoted value (everything up to "lines" keyword or end)
    const ntUnquotedMatch = /\bnewText\s+(.+?)(?:\s+lines?\s+\d|$)/i.exec(ntSource);
    if (ntUnquotedMatch) {
      args.newText = ntUnquotedMatch[1].trim();
    }
  }

  return args;
}

/**
 * Parse a structured agent response from text
 * @param {string} text - Raw text from LLM
 * @returns {object|null} Parsed response with final/toolCalls/plan fields, or null if invalid
 */
function parseAgentResponse(text) {
  const parsed = safeJsonParse(text) || safeJsonParse(extractFirstJsonPayload(text));
  if (!parsed || typeof parsed !== 'object') return null;

  const hasPlan = Array.isArray(parsed.plan);
  const normalizedPlan = hasPlan ? normalizePlanList(parsed.plan) : null;
  const parsedText = typeof parsed.text === 'string' ? parsed.text : '';
  const readyForPlan = parsed.readyForPlan === true;
  const planUpdate = parsed.planUpdate && typeof parsed.planUpdate === 'object' ? parsed.planUpdate : null;
  const attachMeta = (out) => {
    if (readyForPlan) out.readyForPlan = true;
    if (planUpdate) out.planUpdate = planUpdate;
    return out;
  };

  if (typeof parsed.final === 'string') {
    const out = attachMeta({ final: parsed.final });
    if (hasPlan) out.plan = normalizedPlan;
    return out;
  }

  if (typeof parsed.reply === 'string') {
    const out = attachMeta({ final: parsed.reply });
    if (hasPlan) out.plan = normalizedPlan;
    return out;
  }

  if (Array.isArray(parsed.toolCalls)) {
    const out = attachMeta({ toolCalls: parsed.toolCalls, text: parsedText });
    if (hasPlan) out.plan = normalizedPlan;
    return out;
  }

  if (parsed.tool && typeof parsed.tool === 'string') {
    const out = attachMeta({ toolCalls: [{ tool: parsed.tool, args: parsed.args || {} }], text: parsedText });
    if (hasPlan) out.plan = normalizedPlan;
    return out;
  }

  if ((normalizedPlan && normalizedPlan.length) || hasPlan) {
    const out = attachMeta({ text: parsedText });
    if (hasPlan) out.plan = normalizedPlan;
    return out;
  }
  
  return null;
}

/**
 * Parse tool calls from [TOOL_CALLS]...[ARGS] format
 * @param {string} text - Raw text with tagged tool calls
 * @returns {object|null} Object with toolCalls array and remaining text, or null if none found
 */
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

/**
 * Extract tool calls from JSON objects embedded in text
 * @param {string} text - Raw text containing JSON with toolCalls array
 * @returns {object|null} Object with toolCalls array and remaining text, or null if none found
 */
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
      } else if (ch === '\\') {
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
  
  // Detect readyForPlan signals in remaining text
  const hasReadyForPlan = /\breadyForPlan\b|\bready[_\s-]?for[_\s-]?plan\b|"readyForPlan"\s*:\s*true/i.test(src);
  const result = { toolCalls, text: textOut };
  if (hasReadyForPlan) result.readyForPlan = true;
  
  return result;
}

/**
 * Fallback extraction for malformed tool call JSON
 * Looks for "tool": "..." and "args": {...} patterns
 * @param {string} text - Raw text with loose tool call syntax
 * @returns {object|null} Object with toolCalls array, or null if none found
 */
function extractLooseToolCalls(text) {
  const src = String(text || '');
  const toolCalls = [];
  let cursor = 0;

  while (cursor < src.length) {
    const toolIdx = src.indexOf('"tool"', cursor);
    if (toolIdx === -1) break;

    const colonIdx = src.indexOf(':', toolIdx + 6);
    if (colonIdx === -1) {
      cursor = toolIdx + 6;
      continue;
    }
    const quoteStart = src.indexOf('"', colonIdx + 1);
    if (quoteStart === -1) {
      cursor = colonIdx + 1;
      continue;
    }
    let quoteEnd = quoteStart + 1;
    while (quoteEnd < src.length) {
      if (src[quoteEnd] === '"' && src[quoteEnd - 1] !== '\\') break;
      quoteEnd += 1;
    }
    if (quoteEnd >= src.length) {
      cursor = quoteStart + 1;
      continue;
    }
    const toolName = src.slice(quoteStart + 1, quoteEnd).trim();
    if (!toolName) {
      cursor = quoteEnd + 1;
      continue;
    }

    const argsKeyIdx = src.indexOf('"args"', quoteEnd);
    if (argsKeyIdx === -1) {
      cursor = quoteEnd + 1;
      continue;
    }
    const argsColonIdx = src.indexOf(':', argsKeyIdx + 6);
    if (argsColonIdx === -1) {
      cursor = argsKeyIdx + 6;
      continue;
    }
    const braceStart = src.indexOf('{', argsColonIdx);
    if (braceStart === -1) {
      cursor = argsColonIdx + 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    let braceEnd = -1;
    for (let i = braceStart; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
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
        depth += 1;
        continue;
      }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          braceEnd = i;
          break;
        }
      }
    }
    if (braceEnd === -1) {
      cursor = braceStart + 1;
      continue;
    }

    const argsText = src.slice(braceStart, braceEnd + 1);
    const args = safeJsonParse(argsText) || safeJsonParse(extractFirstJsonPayload(argsText)) || {};
    toolCalls.push({ tool: toolName, args });
    cursor = braceEnd + 1;
  }

  if (!toolCalls.length) return null;

  // Detect readyForPlan signals in text
  const hasReadyForPlan = /\breadyForPlan\b|\bready[_\s-]?for[_\s-]?plan\b|"readyForPlan"\s*:\s*true/i.test(src);
  const result = { toolCalls, text: '' };
  if (hasReadyForPlan) result.readyForPlan = true;
  return result;
}

/**
 * Set of all known tool names for fuzzy extraction from garbled LLM output.
 * Used when the LLM concatenates tool names with JSON args or task descriptions.
 */
const KNOWN_TOOLS = new Set([
  'read_file', 'read_files', 'read_file_range_by_symbols', 'edit_file', 'write_file',
  'insert_text', 'replace_range', 'delete_file', 'copy_file', 'move_file',
  'create_dir', 'file_stat', 'read_dir', 'read_output',
  'search', 'locate_file', 'search_symbols', 'workspace_symbols', 'document_symbols',
  'definition', 'type_definition', 'implementation', 'references', 'hover',
  'signature_help', 'call_hierarchy_prepare', 'call_hierarchy_incoming', 'call_hierarchy_outgoing',
  'semantic_tokens', 'run_command', 'apply_patch', 'apply_patch_preview',
  'rename_prepare', 'rename_apply', 'list_files'
]);

/**
 * Try to extract a known tool name and its arguments from garbled text.
 * Handles patterns like:
 *   "write_file{\"path\":\"src/app.js\",\"content\":\"//\"}"  (tool glued to JSON)
 *   "T1: Create StockTracker Componentwrite_file src/app.js"  (task text before tool)
 *   "write_file"  (bare tool name)
 * 
 * @param {string} actionText - The text after "**Action**:" 
 * @returns {object|null} { tool, rest } where rest is everything after the tool name, or null
 */
function extractToolFromGarbled(actionText) {
  const text = String(actionText || '').trim();
  if (!text) return null;

  // 1) Check for tool_name{ (tool glued directly to JSON with no space)
  //    e.g. write_file{"path":"src/app.js","content":"//"}
  const gluedMatch = /^([a-z_]+)\{/i.exec(text);
  if (gluedMatch && KNOWN_TOOLS.has(gluedMatch[1])) {
    return { tool: gluedMatch[1], rest: text.slice(gluedMatch[1].length).trim() };
  }

  // 2) Standard split: first whitespace-delimited token is the tool name
  const parts = text.split(/\s+/).filter(Boolean);
  const firstToken = parts[0];
  if (firstToken && KNOWN_TOOLS.has(firstToken)) {
    return { tool: firstToken, rest: text.slice(firstToken.length).trim() };
  }

  // 3) Check if first token has tool name glued to JSON  (e.g. "write_file{...}")
  if (firstToken) {
    const gluedToken = /^([a-z_]+)\{/i.exec(firstToken);
    if (gluedToken && KNOWN_TOOLS.has(gluedToken[1])) {
      return { tool: gluedToken[1], rest: text.slice(gluedToken[1].length).trim() };
    }
  }

  // 4) Search for a known tool name embedded anywhere in the text
  //    e.g. "T1: Create StockTracker Componentwrite_file src/app.js"
  //    Try longest match first to avoid false positives (e.g. 'read_file' inside 'read_file_range_by_symbols')
  const sortedTools = Array.from(KNOWN_TOOLS).sort((a, b) => b.length - a.length);
  for (const knownTool of sortedTools) {
    const idx = text.indexOf(knownTool);
    if (idx !== -1) {
      const afterTool = text.slice(idx + knownTool.length).trim();
      return { tool: knownTool, rest: afterTool };
    }
  }

  return null;
}

/**
 * Extract a single tool call from common "Action:" style lines.
 * This is a pragmatic fallback for models that ignore JSON-only instructions
 * and instead emit ReAct-style text like:
 *   **Action**: locate_file query="app.jsx"
 *   Action: read_file src/App.jsx
 *   **Action**: search query="StockTracker"
 *   **Action**: write_file{"path":"src/app.js","content":"//"}
 *   **Action**: T1: Create StockTracker Componentwrite_file src/app.js
 *
 * @param {string} text - Raw assistant text
 * @returns {object|null} Object with toolCalls array (length 1) and text, or null if not detected
 */
function extractActionLineToolCall(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);

  // Detect readyForPlan signals in text (case-insensitive, multiple formats)
  const readyForPlanSignals = [
    /\breadyForPlan\b/i,
    /\bready[_\s-]?for[_\s-]?plan\b/i,
    /"readyForPlan"\s*:\s*true/i
  ];
  const hasReadyForPlanSignal = readyForPlanSignals.some(pattern => pattern.test(src));

  const actionLine = lines.find((line) => /^\s*(?:\*\*Action\*\*|Action)\s*:/i.test(line));
  if (!actionLine) {
    // If no action line but has readyForPlan signal, return it
    if (hasReadyForPlanSignal) {
      return { readyForPlan: true, toolCalls: [], text: src.trim() };
    }
    return null;
  }

  const match = /^\s*(?:\*\*Action\*\*|Action)\s*:\s*(.+)\s*$/i.exec(actionLine);
  if (!match) return null;

  let action = String(match[1] || '').trim();
  // Strip garbage appended after the action (e.g. **Observation**: ... concatenated on same line)
  action = action.replace(/\*\*Observation\*\*.*/i, '').trim();
  if (!action) return null;

  // Check if the action itself is a readyForPlan signal
  if (/^(?:readyForPlan|ready[_\s-]?for[_\s-]?plan)$/i.test(action)) {
    return { readyForPlan: true, toolCalls: [], text: '' };
  }

  // Use extractToolFromGarbled to handle concatenated tool names (e.g. write_file{...} or T1: Descriptionwrite_file)
  const extracted = extractToolFromGarbled(action);
  if (!extracted) return null;

  const tool = extracted.tool;
  const rest = extracted.rest;

  // Try args as JSON payload after tool name.
  const jsonArgs = safeJsonParse(rest) || safeJsonParse(extractFirstJsonPayload(rest));
  if (jsonArgs && typeof jsonArgs === 'object' && !Array.isArray(jsonArgs)) {
    return { toolCalls: [{ tool, args: jsonArgs }], text: '' };
  }

  // Parse key=value pairs (with quoted values supported).
  const args = {};
  const kvRe = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s]+))/g;
  let m;
  while ((m = kvRe.exec(rest)) !== null) {
    const key = m[1];
    const value = m[2] != null ? m[2]
      : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
    args[key] = value;
  }

  // Positional fallbacks for common tools.
  if (Object.keys(args).length === 0) {
    // For edit_file, try space-separated named tokens first (e.g. "src/App.jsx startLine 5 endLine 54 newText ...")
    if (tool === 'edit_file') {
      const namedArgs = parseEditFileNamedTokens(rest);
      if (namedArgs) {
        Object.assign(args, namedArgs);
      }
    }

    // Only use dumb positional fallback if named tokens didn't match
    if (Object.keys(args).length === 0) {
      const positional = rest.trim();
      if (positional) {
        if (tool === 'read_file') args.path = positional;
        else if (tool === 'edit_file') args.path = positional;
        else if (tool === 'write_file') args.path = positional;
        else if (tool === 'insert_text') args.path = positional;
        else if (tool === 'replace_range') args.path = positional;
        else if (tool === 'delete_file') args.path = positional;
        else if (tool === 'locate_file') args.query = positional;
        else if (tool === 'search') args.query = positional;
        else if (tool === 'read_dir') args.path = positional;
        else if (tool === 'file_stat') args.path = positional;
        else if (tool === 'run_command') args.command = positional;
      }
    }
  }

  // For write_file/edit_file: if we have path but no content, extract from subsequent lines
  if ((tool === 'write_file' || tool === 'edit_file') && args.path && !args.content && !args.newText) {
    const extracted_content = extractContentAfterActionLine(src, actionLine);
    if (extracted_content) {
      if (tool === 'write_file') args.content = extracted_content;
      else if (tool === 'edit_file') args.newText = extracted_content;
    }
  }

  // Normalize a few common parameter names.
  if (tool === 'read_file' && !args.path && typeof args.uri === 'string') {
    args.path = args.uri;
    delete args.uri;
  }
  if (tool === 'locate_file' && !args.query && typeof args.path === 'string') {
    args.query = args.path;
    delete args.path;
  }

  // Parse "lines X-Y" for tools that accept line ranges.
  const TOOLS_WITH_LINE_RANGE = new Set(['read_file', 'edit_file', 'insert_text', 'replace_range']);
  if (TOOLS_WITH_LINE_RANGE.has(tool)) {
    const linesMatch = /\blines?\s+(\d+)\s*-\s*(\d+)\b/i.exec(rest);
    if (linesMatch) {
      args.startLine = Number(linesMatch[1]);
      args.endLine = Number(linesMatch[2]);
    }
    if (typeof args.path === 'string') {
      args.path = args.path.replace(/\s+lines?\s+\d+\s*-\s*\d+\b/gi, '').trim();
      // Also strip embedded newText "..." from path if present
      // e.g. path = 'src/App.jsx newText "import StockPrice..."' → 'src/App.jsx'
      const embeddedNewText = /\s+newText\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|.+)$/i.exec(args.path);
      if (embeddedNewText) {
        // Extract newText value before stripping from path
        if (!args.newText) {
          const ntq = /\bnewText\s+"((?:[^"\\]|\\.)*)"/i.exec(embeddedNewText[0]) ||
                      /\bnewText\s+'((?:[^'\\]|\\.)*)'/i.exec(embeddedNewText[0]);
          if (ntq) {
            args.newText = ntq[1].replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
          }
        }
        args.path = args.path.slice(0, embeddedNewText.index).trim();
      }
    }
    if (tool === 'read_file') {
      if (!Number.isFinite(Number(args.startLine))) args.startLine = 1;
      if (!Number.isFinite(Number(args.endLine))) args.endLine = 200;
    }
  }

  // Coerce common numeric params.
  if (tool === 'search' || tool === 'locate_file' || tool === 'read_dir') {
    if (args.maxResults != null && Number.isFinite(Number(args.maxResults))) {
      args.maxResults = Number(args.maxResults);
    }
  }

  // Basic sanity: ensure tool has at least one arg for tools that require it.
  const requiresQuery = new Set(['search', 'locate_file', 'search_symbols', 'workspace_symbols']);
  if (requiresQuery.has(tool) && typeof args.query !== 'string' && typeof args.query !== 'number' && typeof args.query !== 'boolean') {
    if (typeof args.query !== 'string' && typeof args.query !== 'number' && typeof args.query !== 'boolean') {
      // If locate_file uses query but we captured as path above, normalize.
      if (tool === 'locate_file' && typeof args.query !== 'string' && typeof args.query !== 'number') {
        // no-op; handled above
      }
    }
  }

  // Detect readyForPlan signals in text
  const hasReadyForPlan = /\breadyForPlan\b|\bready[_\s-]?for[_\s-]?plan\b|"readyForPlan"\s*:\s*true/i.test(src);
  const result = { toolCalls: [{ tool, args }], text: '' };
  if (hasReadyForPlan) result.readyForPlan = true;

  return result;
}

/**
 * Normalize assistant responses from markdown **Action**: format to JSON.
 * Models like devstral ignore JSON-only instructions and emit:
 *   **Action**: locate_file query="app.jsx"
 * This function converts them to:
 *   {"text":"","toolCalls":[{"tool":"locate_file","args":{"query":"app.jsx"}}]}
 *
 * @param {string} text - Raw assistant response
 * @returns {string} Normalized JSON string, or original text if no conversion needed
 */
function normalizeAssistantResponse(text) {
  const src = String(text || '').trim();
  if (!src) return src;

  // Skip if already valid JSON
  const parsed = safeJsonParse(src);
  if (parsed && typeof parsed === 'object') return src;

  // Detect **Action**: pattern
  const actionMatch = /^\s*(?:\*\*Action\*\*|Action)\s*:\s*(.+?)\s*$/im.exec(src);
  if (!actionMatch) return src;

  let actionText = actionMatch[1].trim();

  // Strip garbage appended after the action (e.g. **Observation**: ... concatenated on same line)
  actionText = actionText.replace(/\*\*Observation\*\*.*/i, '').trim();
  
  // Check for readyForPlan signal
  if (/^(?:readyForPlan|ready[_\s-]?for[_\s-]?plan)$/i.test(actionText)) {
    return JSON.stringify({ readyForPlan: true, text: 'Ready to proceed with planning' });
  }

  // Parse tool call — use extractToolFromGarbled to handle concatenated patterns
  const extracted = extractToolFromGarbled(actionText);
  if (!extracted) return src;

  const tool = extracted.tool;
  const rest = extracted.rest;

  // Try JSON args first
  const jsonArgs = safeJsonParse(rest) || safeJsonParse(extractFirstJsonPayload(rest));
  if (jsonArgs && typeof jsonArgs === 'object' && !Array.isArray(jsonArgs)) {
    return JSON.stringify({
      text: `Using ${tool}`,
      toolCalls: [{ tool, args: jsonArgs }]
    });
  }

  // Parse key=value pairs
  const args = {};
  const kvRe = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s]+))/g;
  let m;
  while ((m = kvRe.exec(rest)) !== null) {
    const key = m[1];
    const value = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
    args[key] = value;
  }

  // Positional fallbacks (keep in sync with extractActionLineToolCall)
  if (Object.keys(args).length === 0 && rest) {
    // For edit_file, try space-separated named tokens first (e.g. "src/App.jsx startLine 5 endLine 54 newText ...")
    if (tool === 'edit_file') {
      const namedArgs = parseEditFileNamedTokens(rest);
      if (namedArgs) {
        Object.assign(args, namedArgs);
      }
    }

    // Only use dumb positional fallback if named tokens didn't match
    if (Object.keys(args).length === 0) {
      if (tool === 'read_file') args.path = rest;
      else if (tool === 'edit_file') args.path = rest;
      else if (tool === 'write_file') args.path = rest;
      else if (tool === 'insert_text') args.path = rest;
      else if (tool === 'replace_range') args.path = rest;
      else if (tool === 'delete_file') args.path = rest;
      else if (tool === 'locate_file') args.query = rest;
      else if (tool === 'search') args.query = rest;
      else if (tool === 'read_dir') args.path = rest;
      else if (tool === 'file_stat') args.path = rest;
      else if (tool === 'run_command') args.command = rest;
      else if (tool === 'move_file') args.from = rest;
      else if (tool === 'copy_file') args.from = rest;
      else if (tool === 'document_symbols') args.uri = rest;
      else if (tool === 'search_symbols') args.query = rest;
      else if (tool === 'workspace_symbols') args.query = rest;
    }
  }

  // For write_file/edit_file: if we have path but no content, extract from subsequent lines
  if ((tool === 'write_file' || tool === 'edit_file') && args.path && !args.content && !args.newText) {
    // Find the actual action line text in the original source for line matching
    const actionLineText = actionMatch[0];
    const extracted_content = extractContentAfterActionLine(src, actionLineText.trim());
    if (extracted_content) {
      if (tool === 'write_file') args.content = extracted_content;
      else if (tool === 'edit_file') args.newText = extracted_content;
    }
  }

  // Parse "lines X-Y" for tools that accept line ranges
  const TOOLS_WITH_LINE_RANGE = new Set(['read_file', 'edit_file', 'insert_text', 'replace_range']);
  if (TOOLS_WITH_LINE_RANGE.has(tool)) {
    const linesMatch = /\blines?\s+(\d+)\s*-\s*(\d+)\b/i.exec(rest);
    if (linesMatch) {
      args.startLine = Number(linesMatch[1]);
      args.endLine = Number(linesMatch[2]);
      if (args.path) {
        args.path = args.path.replace(/\s+lines?\s+\d+\s*-\s*\d+\b/gi, '').trim();
      }
    }
    if (tool === 'read_file') {
      if (!args.startLine) args.startLine = 1;
      if (!args.endLine) args.endLine = 200;
    }
  }

  return JSON.stringify({
    text: `Using ${tool}`,
    toolCalls: [{ tool, args }]
  });
}

module.exports = {
  parseAgentResponse,
  parseTaggedToolCalls,
  extractToolCallsFromText,
  extractLooseToolCalls,
  extractActionLineToolCall,
  normalizeAssistantResponse,
  extractToolFromGarbled,
  extractContentAfterActionLine,
  parseEditFileNamedTokens,
  KNOWN_TOOLS
};
