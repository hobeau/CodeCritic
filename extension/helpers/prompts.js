const { buildChatContextBlock } = require('./context');

// ─── Tool Definitions ───────────────────────────────────────────────
// Each tool has: description, parameters (with type, description, required flag).
// These are the single source of truth for all tool schemas shown to the LLM.
// The format function serializes them into compact text for the system prompt.

const ALL_TOOLS = {
  // ── Search & Discovery ──────────────────────────────────────────
  search: {
    description: 'Full-text search across workspace files. Returns matching lines with context.',
    parameters: {
      query:      { type: 'string',  description: 'Search text or regex pattern', required: true },
      include:    { type: 'string',  description: 'Glob pattern for files to include (default: "**/*")' },
      exclude:    { type: 'string',  description: 'Glob pattern for files to exclude (default: "**/node_modules/**")' },
      maxResults: { type: 'number',  description: 'Max results to return (default: 20)' }
    }
  },
  locate_file: {
    description: 'Find files by name or partial path. Use this instead of search when looking for a specific file.',
    parameters: {
      query:      { type: 'string',  description: 'Filename or partial path to search for (e.g. "App.jsx")', required: true },
      include:    { type: 'string',  description: 'Glob pattern to narrow search' },
      exclude:    { type: 'string',  description: 'Glob pattern to exclude' },
      maxResults: { type: 'number',  description: 'Max files to return (default: 20)' }
    }
  },
  search_symbols: {
    description: 'Search for symbol names (functions, classes, variables) across all workspace files.',
    parameters: {
      query:      { type: 'string',  description: 'Symbol name or partial name to search for', required: true },
      maxResults: { type: 'number',  description: 'Max results (default: 20)' }
    }
  },
  workspace_symbols: {
    description: 'Query workspace-level symbols by name. Similar to search_symbols but uses the language server index.',
    parameters: {
      query:      { type: 'string',  description: 'Symbol name to search for', required: true },
      maxResults: { type: 'number',  description: 'Max results (default: 20)' }
    }
  },

  // ── Code Intelligence ───────────────────────────────────────────
  document_symbols: {
    description: 'List all symbols (functions, classes, variables) defined in a specific file.',
    parameters: {
      uri: { type: 'string', description: 'Relative file path (e.g. "src/App.jsx")', required: true }
    }
  },
  definition: {
    description: 'Go to the definition of a symbol at a specific location in a file.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  type_definition: {
    description: 'Go to the type definition of a symbol at a specific location.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  implementation: {
    description: 'Find implementations of an interface or abstract method.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  references: {
    description: 'Find all references to a symbol at a specific location.',
    parameters: {
      uri:                { type: 'string',  description: 'Relative file path', required: true },
      line:               { type: 'number',  description: '1-based line number', required: true },
      character:          { type: 'number',  description: '0-based column position', required: true },
      includeDeclaration: { type: 'boolean', description: 'Include the declaration itself (default: true)' }
    }
  },
  hover: {
    description: 'Get hover information (type info, docs) for a symbol at a specific location.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  signature_help: {
    description: 'Get function signature and parameter info at a call site.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  call_hierarchy_prepare: {
    description: 'Prepare call hierarchy for a function/method. Returns an itemId for use with incoming/outgoing calls.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  call_hierarchy_incoming: {
    description: 'Get functions that call a given function. Requires itemId from call_hierarchy_prepare.',
    parameters: {
      itemId: { type: 'string', description: 'Item ID from call_hierarchy_prepare result', required: true }
    }
  },
  call_hierarchy_outgoing: {
    description: 'Get functions called by a given function. Requires itemId from call_hierarchy_prepare.',
    parameters: {
      itemId: { type: 'string', description: 'Item ID from call_hierarchy_prepare result', required: true }
    }
  },
  rename_prepare: {
    description: 'Check if a symbol at a location can be renamed. Returns the current name and valid range.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true }
    }
  },
  rename_apply: {
    description: 'Rename a symbol across all files. Use rename_prepare first to verify.',
    parameters: {
      uri:       { type: 'string', description: 'Relative file path', required: true },
      line:      { type: 'number', description: '1-based line number', required: true },
      character: { type: 'number', description: '0-based column position', required: true },
      newName:   { type: 'string', description: 'New name for the symbol', required: true }
    }
  },
  semantic_tokens: {
    description: 'Get semantic token information (token types, modifiers) for a range in a file.',
    parameters: {
      uri:   { type: 'string', description: 'Relative file path', required: true },
      range: { type: 'object', description: '{"startLine":1,"startCharacter":0,"endLine":50,"endCharacter":0}', required: true }
    }
  },

  // ── File Reading ────────────────────────────────────────────────
  read_file: {
    description: 'Read contents of a file with line numbers. Always provide the path argument.',
    parameters: {
      path:      { type: 'string', description: 'Relative file path (e.g. "src/App.jsx")', required: true },
      startLine: { type: 'number', description: '1-based start line (default: 1)' },
      endLine:   { type: 'number', description: '1-based end line (default: 200)' }
    }
  },
  read_files: {
    description: 'Read multiple files in a single call. More efficient than multiple read_file calls.',
    parameters: {
      paths:  { type: 'string[]', description: 'Array of relative file paths', required: true },
      ranges: { type: 'object[]', description: 'Array of {startLine, endLine} per file (optional)' }
    }
  },
  read_file_range_by_symbols: {
    description: 'Read specific symbol definitions (functions, classes) from a file without needing line numbers.',
    parameters: {
      path:     { type: 'string',   description: 'Relative file path', required: true },
      symbols:  { type: 'string[]', description: 'Symbol names to extract (e.g. ["App","handleClick"])', required: true },
      maxChars: { type: 'number',   description: 'Max characters to return (default: 12000)' }
    }
  },

  // ── File System ─────────────────────────────────────────────────
  list_files: {
    description: 'List files in workspace matching a glob pattern.',
    parameters: {
      include:    { type: 'string', description: 'Glob pattern to match (default: "**/*")' },
      exclude:    { type: 'string', description: 'Glob pattern to exclude (default: "**/node_modules/**")' },
      maxResults: { type: 'number', description: 'Max files to return (default: 200)' }
    }
  },
  file_stat: {
    description: 'Get file metadata (exists, type, size, modification time). Always provide the path.',
    parameters: {
      path: { type: 'string', description: 'Relative file path to check', required: true }
    }
  },
  read_dir: {
    description: 'List directory contents as a tree structure.',
    parameters: {
      path:       { type: 'string', description: 'Relative directory path', required: true },
      maxDepth:   { type: 'number', description: 'Max directory depth (default: 3)' },
      maxEntries: { type: 'number', description: 'Max entries to return (default: 400)' }
    }
  },
  read_output: {
    description: 'Read the output of the last run_command. Use after running a command to see its output.',
    parameters: {
      maxChars: { type: 'number',  description: 'Max characters to return (default: 12000)' },
      tail:     { type: 'boolean', description: 'Read from the end instead of the start (default: true)' }
    }
  },

  // ── File Editing (agent mode only) ──────────────────────────────
  edit_file: {
    description: 'Replace a range of lines in a file. Set newText to ONLY the replacement lines (no surrounding context).',
    parameters: {
      path:      { type: 'string', description: 'Relative file path', required: true },
      startLine: { type: 'number', description: '1-based start line of range to replace', required: true },
      endLine:   { type: 'number', description: '1-based end line of range to replace', required: true },
      newText:   { type: 'string', description: 'Replacement text (only the new lines, no context)', required: true }
    }
  },
  insert_text: {
    description: 'Insert text at a specific position in a file without replacing existing content.',
    parameters: {
      path:     { type: 'string', description: 'Relative file path', required: true },
      position: { type: 'object', description: '{"line":10,"character":0} — 1-based line, 0-based column', required: true },
      text:     { type: 'string', description: 'Text to insert', required: true }
    }
  },
  replace_range: {
    description: 'Replace a character-level range in a file. More precise than edit_file.',
    parameters: {
      path:  { type: 'string', description: 'Relative file path', required: true },
      range: { type: 'object', description: '{"startLine":10,"startChar":0,"endLine":12,"endChar":1}', required: true },
      text:  { type: 'string', description: 'Replacement text', required: true }
    }
  },
  write_file: {
    description: 'Create a new file or overwrite an existing one. Fails if file exists unless overwrite=true.',
    parameters: {
      path:      { type: 'string',  description: 'Relative file path', required: true },
      content:   { type: 'string',  description: 'File content to write', required: true },
      overwrite: { type: 'boolean', description: 'Overwrite if file exists (default: false)' },
      append:    { type: 'boolean', description: 'Append to file instead of replacing (default: false)' }
    }
  },
  copy_file: {
    description: 'Copy a file from one location to another.',
    parameters: {
      from:      { type: 'string',  description: 'Source relative file path', required: true },
      to:        { type: 'string',  description: 'Destination relative file path', required: true },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it exists (default: false)' }
    }
  },
  move_file: {
    description: 'Move or rename a file.',
    parameters: {
      from:      { type: 'string',  description: 'Source relative file path', required: true },
      to:        { type: 'string',  description: 'Destination relative file path', required: true },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it exists (default: false)' }
    }
  },
  delete_file: {
    description: 'Delete a file or directory.',
    parameters: {
      path:      { type: 'string',  description: 'Relative path to delete', required: true },
      recursive: { type: 'boolean', description: 'Delete directories recursively (default: false)' }
    }
  },
  create_dir: {
    description: 'Create a directory (and parent directories if needed).',
    parameters: {
      path: { type: 'string', description: 'Relative directory path to create', required: true }
    }
  },
  apply_patch: {
    description: 'Apply a unified diff patch to the workspace.',
    parameters: {
      patch: { type: 'string', description: 'Unified diff content', required: true },
      cwd:   { type: 'string', description: 'Working directory for the patch (default: ".")' }
    }
  },
  apply_patch_preview: {
    description: 'Preview a patch without applying it. Shows what would change.',
    parameters: {
      patch: { type: 'string', description: 'Unified diff content', required: true },
      cwd:   { type: 'string', description: 'Working directory (default: ".")' }
    }
  },

  // ── Command Execution (agent mode only) ─────────────────────────
  run_command: {
    description: 'Run a shell command in the workspace. Use non-interactive flags (--yes, -y). Output may be truncated; use read_output to get full output.',
    parameters: {
      command:   { type: 'string', description: 'Shell command to execute', required: true },
      cwd:       { type: 'string', description: 'Working directory (default: workspace root)' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default: 60000)' }
    }
  }
};

const CHAT_TOOL_NAMES = [
    'search', 'locate_file', 'search_symbols', 'workspace_symbols',
    'document_symbols', 'definition', 'type_definition', 'implementation',
    'references', 'hover', 'signature_help', 'call_hierarchy_prepare',
    'call_hierarchy_incoming', 'call_hierarchy_outgoing', 'semantic_tokens',
    'read_file', 'read_files', 'read_file_range_by_symbols', 'list_files',
    'file_stat', 'read_dir', 'read_output'
];

const AGENT_TOOL_NAMES = [
    ...CHAT_TOOL_NAMES,
    'edit_file', 'insert_text', 'replace_range', 'copy_file',
    'apply_patch_preview', 'apply_patch', 'write_file', 'create_dir',
    'delete_file', 'move_file', 'run_command',
    'rename_prepare', 'rename_apply'
];

/**
 * Serialize tool definitions into compact, LLM-friendly text blocks.
 * Format per tool:
 *   tool: <name> — <description>
 *   args: <param> (<type>, required) — <desc>
 *         <param> (<type>) — <desc>
 *   example: {"toolCalls":[{"tool":"<name>","args":{...}}]}
 */
function formatToolSchema(name, def) {
    const lines = [`tool: ${name} — ${def.description}`];
    const params = Object.entries(def.parameters);
    if (params.length) {
        params.forEach(([pName, p], i) => {
            const req = p.required ? ', required' : '';
            const prefix = i === 0 ? 'args: ' : '      ';
            lines.push(`${prefix}${pName} (${p.type}${req}) — ${p.description}`);
        });
    }
    // Build a compact example with required-only args
    const exArgs = {};
    for (const [pName, p] of params) {
        if (p.required) {
            const placeholders = {
                string: pName === 'path' ? 'src/file.js' : pName === 'query' ? 'searchTerm' : pName === 'command' ? 'npm test' : '...',
                number: pName === 'line' ? 10 : pName === 'character' ? 5 : pName === 'startLine' ? 1 : pName === 'endLine' ? 50 : 1,
                boolean: true,
                'string[]': ['example'],
                'object[]': [{}],
                object: {}
            };
            exArgs[pName] = placeholders[p.type] ?? '...';
        }
    }
    lines.push(`example: {"toolCalls":[{"tool":"${name}","args":${JSON.stringify(exArgs)}}]}`);
    return lines.join('\n');
}

function getToolSchemas(toolNames) {
    return toolNames
        .filter(name => ALL_TOOLS[name])
        .map(name => formatToolSchema(name, ALL_TOOLS[name]));
}

function buildSystemPrompt(mode, context) {
    // Ensure mode is valid, default to 'agent' if not
    const validMode = ['chat', 'planner', 'agent', 'agent_plan'].includes(mode) ? mode : 'agent';
    
    const persona = {
        chat: [
            'You are a helpful coding assistant.',
            'Answer the user clearly and directly.',
            'Use the provided context when relevant.',
            'Do not perform a code review unless the user explicitly asks.'
        ],
        planner: [
            'You are a helpful coding assistant.',
            'Answer the user clearly and directly.',
            'Use the provided context when relevant.',
            'Do not perform a code review unless the user explicitly asks.',
            '',
            'You are in PLANNER mode. Build or refine an execution plan before any work is done.',
            'The plan must be provided as a JSON array in the "plan" field.',
            'Each plan item must include at least: {"id":"1","text":"..."}.',
            'Optionally include "assumptions" and "questions" arrays of strings.'
        ],
        agent: [
            'You are a coding agent.',
            'Provide brief reasoning in the "text" field and one concrete next action via a single tool call.',
            'If you propose code changes, keep them minimal and scoped.',
            'Ask a clarifying question if required.',
            'Do not perform a code review unless the user explicitly asks.'
        ],
        agent_plan: [
            'You are a planning assistant.',
            'Generate a markdown execution plan that follows the requested structure.',
            'Do not include JSON or tool calls.',
            'Do not perform a code review unless the user explicitly asks.'
        ]
    };

    const instructions = {
        chat: [
            'You can use tools to inspect but not modify the workspace. Respond with JSON only.',
            'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
            'Do not use any tools that are not listed below. Only the tools listed below are available to you.',
        ],
        planner: [
            'You can use tools to inspect but not modify the workspace. Respond with JSON only.',
            'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
            'Do not use any tools that are not listed below. Only the tools listed below are available to you.',
        ],
        agent: [
            'You can use tools to inspect and modify the workspace. Respond with JSON only.',
            'Your entire response must be a single JSON object parseable by JSON.parse (no markdown, no "Action:" lines).',
            'When taking an action, include a brief "text" (1-3 sentences) and your tool call(s) in "toolCalls".',
            'You may include "readyForPlan": true during exploration when you have enough context to plan.',
            'During exploration, if you respond with "readyForPlan": true, do NOT include any toolCalls.',
            'You may include a "planUpdate" object to update the markdown execution plan contract.',
            'planUpdate schema: {"acceptanceChecks":[{"text":"...","checked":true|false}],"tasks":[{"id":"T1","checked":true|false}],"findings":{"entryPoints?":"...","dataFlow?":"...","invariants?":"...","assumptions?":"...","openQuestions?":"..."},"progressLogEntry":"..."}',
            'Do not output markdown execution plans in agent mode; only JSON.',
            'Prefer non-interactive commands (use flags like --yes). Keep commands scoped to the workspace.',
            'After making changes, verify the workspace state (a tree and file list may be provided) before returning the final response.',
            'If workspace problems are provided, attempt to resolve them before finishing when possible.',
            'When using edit_file or replace_range, set newText to ONLY the replacement lines for the specified range.',
            'Do not include unchanged context lines before/after the range, and do not re-emit entire functions/files for small edits.',
            'When multiple diagnostics cluster in the same region, use ONE edit_file call with a wide enough startLine-endLine range to cover all related errors. Fixing one line at a time often creates new syntax errors.',
            'Avoid duplicate imports or JSX blocks; when adding an import, insert only the new line.',
            'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
            'If write_file fails with "already exists", use edit_file to modify the file OR set overwrite=true if you want to replace it entirely.',
            'If a tool operation fails repeatedly, try a different approach rather than retrying the same operation.',
            'Do not use any tools that are not listed below. Only the tools listed below are available to you.',
            '',
            '=== COMPLETION VERIFICATION (ReAct) ===',
            'When starting a task, identify what evidence will prove completion (tests passing, build succeeding, diagnostics clean).',
            'After making changes, verify your work by running tests or checking diagnostics.',
            'Use run_command to execute test suites (npm test, jest, pytest, etc.) and build commands (npm run build, tsc, etc.).',
            'Do not claim completion without evidence. Continue iterating until tests pass and diagnostics are clean.',
            'If tests fail, analyze the failure output carefully and adjust your approach.',
            'When you see "Evidence Report" in messages, review it to determine if more work is needed.',
            'Task completion requires strong evidence: tests pass AND diagnostics are clean (or improved from baseline).'
        ],
        agent_plan: [
            'Respond with markdown only. Do not wrap your response in JSON.',
            'Do not include tool calls or code changes.',
            'Follow the exact plan structure requested.'
        ]
    };

    const responseFormat = {
        chat: [
            'When done, respond with {"final":"..."} and no other text.',
            'If no tool is needed, respond with {"final":"..."}.'
        ],
        planner: [
            'When done, respond with {"final":"...","plan":[...],"assumptions":[...],"questions":[...]} and no other text.',
            'If no tool is needed, respond with {"final":"...","plan":[]}.'
        ],
        agent: [
            'When taking an action, respond with {"text":"...","toolCalls":[{...},...]} and no other text.',
            'During exploration you may respond with {"text":"...","readyForPlan":true} and no other text (omit toolCalls when readyForPlan=true).',
            'To update the markdown plan, include "planUpdate": {"acceptanceChecks":[...],"tasks":[...],"findings":{...},"progressLogEntry":"..."} in the JSON.',
            'When done, respond with {"final":"..."} and no other text.'
        ],
        agent_plan: [
            'When done, respond with the markdown plan only (no JSON wrapper).'
        ]
    };

    const toolNames = validMode === 'agent'
        ? AGENT_TOOL_NAMES
        : (validMode === 'agent_plan' ? [] : CHAT_TOOL_NAMES);
    const toolSchemas = getToolSchemas(toolNames);

    const prompt = [
        ...persona[validMode],
        '',
        ...instructions[validMode]
    ];
    if (toolSchemas.length) {
        prompt.push('', '=== AVAILABLE TOOLS ===', '', toolSchemas.join('\n\n'));
    }
    prompt.push(...responseFormat[validMode]);

    const ctx = buildChatContextBlock(context);
    if (ctx) {
        prompt.push('', 'CONTEXT:', ctx);
    }

    return prompt.join('\n');
}


module.exports = {
    ALL_TOOLS,
    buildSystemPrompt,
    CHAT_TOOL_NAMES,
    AGENT_TOOL_NAMES,
    getToolSchemas
};
