const { buildChatContextBlock } = require('./context');

const ALL_TOOLS = {
  search: '{"toolCalls":[{"tool":"search","args":{"query":"text","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
  locate_file: '{"toolCalls":[{"tool":"locate_file","args":{"query":"about.md","include":"**/*","exclude":"**/node_modules/**","maxResults":20}}]}',
  search_symbols: '{"toolCalls":[{"tool":"search_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
  workspace_symbols: '{"toolCalls":[{"tool":"workspace_symbols","args":{"query":"SymbolName","maxResults":20}}]}',
  document_symbols: '{"toolCalls":[{"tool":"document_symbols","args":{"uri":"src/App.jsx"}}]}',
  definition: '{"toolCalls":[{"tool":"definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  type_definition: '{"toolCalls":[{"tool":"type_definition","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  implementation: '{"toolCalls":[{"tool":"implementation","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  references: '{"toolCalls":[{"tool":"references","args":{"uri":"src/App.jsx","line":10,"character":5,"includeDeclaration":true}}]}',
  hover: '{"toolCalls":[{"tool":"hover","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  signature_help: '{"toolCalls":[{"tool":"signature_help","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  call_hierarchy_prepare: '{"toolCalls":[{"tool":"call_hierarchy_prepare","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  call_hierarchy_incoming: '{"toolCalls":[{"tool":"call_hierarchy_incoming","args":{"itemId":"chi_123"}}]}',
  call_hierarchy_outgoing: '{"toolCalls":[{"tool":"call_hierarchy_outgoing","args":{"itemId":"chi_123"}}]}',
  rename_prepare: '{"toolCalls":[{"tool":"rename_prepare","args":{"uri":"src/App.jsx","line":10,"character":5}}]}',
  rename_apply: '{"toolCalls":[{"tool":"rename_apply","args":{"uri":"src/App.jsx","line":10,"character":5,"newName":"newSymbolName"}}]}',
  semantic_tokens: '{"toolCalls":[{"tool":"semantic_tokens","args":{"uri":"src/App.jsx","range":{"startLine":1,"startCharacter":1,"endLine":50,"endCharacter":1}}}]}',
  read_file: '{"toolCalls":[{"tool":"read_file","args":{"path":"relative/path","startLine":1,"endLine":200}}]}',
  read_files: '{"toolCalls":[{"tool":"read_files","args":{"paths":["src/App.jsx","src/main.jsx"],"ranges":[{"startLine":1,"endLine":200},{"startLine":1,"endLine":200}]}}]}',
  read_file_range_by_symbols: '{"toolCalls":[{"tool":"read_file_range_by_symbols","args":{"path":"relative/path","symbols":["Foo","Bar"],"maxChars":12000}}]}',
  edit_file: '{"toolCalls":[{"tool":"edit_file","args":{"path":"relative/path","startLine":1,"endLine":5,"newText":"replacement text"}}]}',
  insert_text: '{"toolCalls":[{"tool":"insert_text","args":{"path":"relative/path","position":{"line":10,"character":5},"text":"text to insert"}}]}',
  replace_range: '{"toolCalls":[{"tool":"replace_range","args":{"path":"relative/path","range":{"startLine":10,"startChar":1,"endLine":12,"endChar":1},"text":"replacement text"}}]}',
  copy_file: '{"toolCalls":[{"tool":"copy_file","args":{"from":"relative/path","to":"relative/path","overwrite":false}}]}',
  apply_patch_preview: '{"toolCalls":[{"tool":"apply_patch_preview","args":{"patch":"diff content","cwd":"."}}]}',
  apply_patch: '{"toolCalls":[{"tool":"apply_patch","args":{"patch":"diff content","cwd":"."}}]}',
  list_files: '{"toolCalls":[{"tool":"list_files","args":{"include":"**/*","exclude":"**/node_modules/**","maxResults":200}}]}',
  file_stat: '{"toolCalls":[{"tool":"file_stat","args":{"path":"relative/path"}}]}',
  write_file: '{"toolCalls":[{"tool":"write_file","args":{"path":"relative/path","content":"text","overwrite":false,"append":false}}]}',
  create_dir: '{"toolCalls":[{"tool":"create_dir","args":{"path":"relative/path"}}]}',
  delete_file: '{"toolCalls":[{"tool":"delete_file","args":{"path":"relative/path","recursive":false}}]}',
  move_file: '{"toolCalls":[{"tool":"move_file","args":{"from":"relative/path","to":"relative/path","overwrite":false}}]}',
  read_dir: '{"toolCalls":[{"tool":"read_dir","args":{"path":"relative/path","maxDepth":3,"maxEntries":400}}]}',
  read_output: '{"toolCalls":[{"tool":"read_output","args":{"maxChars":12000,"tail":true}}]}',
  run_command: '{"toolCalls":[{"tool":"run_command","args":{"command":"npm create vite@latest app -- --template react","cwd":".","timeoutMs":60000}}]}',
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
    'delete_file', 'move_file', 'run_command'
];

function getToolSchemas(toolNames) {
    return toolNames.map(name => ALL_TOOLS[name]).filter(Boolean);
}

function buildSystemPrompt(mode, context) {
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
            'Provide a concise plan and actionable steps.',
            'If you propose code changes, include file paths and minimal patches or snippets.',
            'Ask a clarifying question if required.',
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
            'Prefer non-interactive commands (use flags like --yes). Keep commands scoped to the workspace.',
            'After making changes, verify the workspace state (a tree and file list may be provided) before returning the final response.',
            'If workspace problems are provided, attempt to resolve them before finishing when possible.',
            'Maintain a TODO list in your JSON responses using {"todo":[{"id":"1","text":"...","status":"pending|done"}]}. Update statuses as you complete steps.',
            'When using edit_file or replace_range, set newText to ONLY the replacement lines for the specified range.',
            'Do not include unchanged context lines before/after the range, and do not re-emit entire functions/files for small edits.',
            'Avoid duplicate imports or JSX blocks; when adding an import, insert only the new line.',
            'When the user mentions a file name or extension (e.g., about.md), use locate_file and do not call search.',
            'Do not use any tools that are not listed below. Only the tools listed below are available to you.',
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
            'When done, respond with {"final":"..."} and no other text.',
            'If no tool is needed, respond with {"final":"..."}.'
        ]
    };

    const toolNames = mode === 'agent' ? AGENT_TOOL_NAMES : CHAT_TOOL_NAMES;
    const toolSchemas = getToolSchemas(toolNames);

    const prompt = [
        ...persona[mode],
        '',
        ...instructions[mode],
        'Tool schema:',
        ...toolSchemas,
        ...responseFormat[mode]
    ];

    const ctx = buildChatContextBlock(context);
    if (ctx) {
        prompt.push('', 'CONTEXT:', ctx);
    }

    return prompt.join('\n');
}


module.exports = {
    buildSystemPrompt,
    CHAT_TOOL_NAMES,
    AGENT_TOOL_NAMES
};
