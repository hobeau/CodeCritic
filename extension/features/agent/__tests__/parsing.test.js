/**
 * @jest-environment node
 */

const {
  parseAgentResponse,
  parseTaggedToolCalls,
  extractToolCallsFromText,
  extractLooseToolCalls,
  extractActionLineToolCall,
  normalizeAssistantResponse,
  extractToolFromGarbled,
  extractContentAfterActionLine,
  parseEditFileNamedTokens
} = require('../utils/parsing');

describe('parsing utils', () => {
  describe('parseAgentResponse', () => {
    it.todo('should parse JSON with final field');
    
    it.todo('should parse JSON with toolCalls array');
    
    it.todo('should parse JSON with single tool/args');
    
    it.todo('should normalize plan items');
    
    it.todo('should return null for invalid input');
  });
  
  describe('parseTaggedToolCalls', () => {
    it.todo('should parse [TOOL_CALLS]...[ARGS] format');
    
    it.todo('should handle multiple tool calls');
    
    it.todo('should extract remaining text after parsing');
    
    it.todo('should return null when no tool calls found');
  });
  
  describe('extractToolCallsFromText', () => {
    it.todo('should extract JSON objects with toolCalls array');
    
    it.todo('should handle nested JSON structures');
    
    it.todo('should remove extracted JSON from remaining text');
    
    it('should detect readyForPlan signal in text', () => {
      const text = 'Some text {"toolCalls":[{"tool":"read_file","args":{}}]} and readyForPlan is true';
      const result = extractToolCallsFromText(text);
      expect(result).toBeTruthy();
      expect(result.readyForPlan).toBe(true);
    });
  });
  
  describe('extractLooseToolCalls', () => {
    it.todo('should extract loose "tool": "..." and "args": {...} patterns');
    
    it.todo('should handle malformed JSON');
    
    it('should detect readyForPlan signal in text', () => {
      const text = '"tool": "read_file", "args": {"path": "test.js"} readyForPlan: true';
      const result = extractLooseToolCalls(text);
      expect(result).toBeTruthy();
      expect(result.readyForPlan).toBe(true);
    });
  });
  
  describe('extractActionLineToolCall', () => {
    it('should parse **Action**: locate_file format', () => {
      const text = '**Action**: locate_file query="app.jsx"';
      const result = extractActionLineToolCall(text);
      expect(result).toEqual({
        toolCalls: [{ tool: 'locate_file', args: { query: 'app.jsx' } }],
        text: ''
      });
    });

    it('should parse Action: read_file format', () => {
      const text = 'Action: read_file src/App.jsx';
      const result = extractActionLineToolCall(text);
      expect(result).toEqual({
        toolCalls: [{ tool: 'read_file', args: { path: 'src/App.jsx', startLine: 1, endLine: 200 } }],
        text: ''
      });
    });

    it('should detect readyForPlan action', () => {
      const text = '**Action**: readyForPlan';
      const result = extractActionLineToolCall(text);
      expect(result).toEqual({
        readyForPlan: true,
        toolCalls: [],
        text: ''
      });
    });

    it('should detect readyForPlan signal in text without action line', () => {
      const text = 'I have enough context. readyForPlan: true';
      const result = extractActionLineToolCall(text);
      expect(result).toEqual({
        readyForPlan: true,
        toolCalls: [],
        text: 'I have enough context. readyForPlan: true'
      });
    });

    it('should parse read_file with lines parameter', () => {
      const text = '**Action**: read_file src/App.jsx lines 65-70';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].args).toEqual({
        path: 'src/App.jsx',
        startLine: 65,
        endLine: 70
      });
    });
  });

  describe('normalizeAssistantResponse', () => {
    it('should return original text if already valid JSON', () => {
      const json = '{"text":"test","toolCalls":[]}';
      const result = normalizeAssistantResponse(json);
      expect(result).toBe(json);
    });

    it('should convert **Action**: locate_file to JSON', () => {
      const text = '**Action**: locate_file query="app.jsx"';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls).toEqual([
        { tool: 'locate_file', args: { query: 'app.jsx' } }
      ]);
    });

    it('should convert Action: read_file to JSON', () => {
      const text = 'Action: read_file src/App.jsx';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls).toEqual([
        { tool: 'read_file', args: { path: 'src/App.jsx', startLine: 1, endLine: 200 } }
      ]);
    });

    it('should convert readyForPlan action to JSON', () => {
      const text = '**Action**: readyForPlan';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.readyForPlan).toBe(true);
    });

    it('should parse lines parameter in read_file', () => {
      const text = '**Action**: read_file src/App.jsx lines 10-20';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].args).toEqual({
        path: 'src/App.jsx',
        startLine: 10,
        endLine: 20
      });
    });

    it('should return original text if no Action pattern found', () => {
      const text = 'Just some regular text';
      const result = normalizeAssistantResponse(text);
      expect(result).toBe(text);
    });

    it('should convert **Action**: file_stat with positional path to JSON', () => {
      const text = '**Action**: file_stat src/App.jsx';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls).toEqual([
        { tool: 'file_stat', args: { path: 'src/App.jsx' } }
      ]);
    });

    it('should convert **Action**: file_stat without args to JSON with empty args', () => {
      const text = '**Action**: file_stat';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('file_stat');
      expect(parsed.toolCalls[0].args.path).toBeUndefined();
    });

    it('should convert **Action**: run_command with positional command to JSON', () => {
      const text = '**Action**: run_command npm test';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls).toEqual([
        { tool: 'run_command', args: { command: 'npm test' } }
      ]);
    });

    it('should convert **Action**: document_symbols with positional uri to JSON', () => {
      const text = '**Action**: document_symbols src/App.jsx';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls).toEqual([
        { tool: 'document_symbols', args: { uri: 'src/App.jsx' } }
      ]);
    });

    it('should handle write_file glued to JSON args (no space)', () => {
      const text = '**Action**: write_file{"path":"src/services/stockService.js","content":"// Stock service"}';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('write_file');
      expect(parsed.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(parsed.toolCalls[0].args.content).toBe('// Stock service');
    });

    it('should handle task description concatenated with tool name', () => {
      const text = '**Action**: T1: Create StockTracker Componentwrite_file src/components/StockTracker.jsx';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('write_file');
      expect(parsed.toolCalls[0].args.path).toBe('src/components/StockTracker.jsx');
    });
  });

  describe('extractToolFromGarbled', () => {
    it('should extract tool from standard format', () => {
      const result = extractToolFromGarbled('read_file src/App.jsx');
      expect(result).toEqual({ tool: 'read_file', rest: 'src/App.jsx' });
    });

    it('should extract tool glued to JSON', () => {
      const result = extractToolFromGarbled('write_file{"path":"src/app.js","content":"//"}');
      expect(result).toEqual({ tool: 'write_file', rest: '{"path":"src/app.js","content":"//"}' });
    });

    it('should extract tool from task-description concatenation', () => {
      const result = extractToolFromGarbled('T1: Create StockTracker Componentwrite_file src/app.js');
      expect(result.tool).toBe('write_file');
      expect(result.rest).toBe('src/app.js');
    });

    it('should prefer longer tool names over shorter ones', () => {
      const result = extractToolFromGarbled('Some textread_file_range_by_symbols src/app.js');
      expect(result.tool).toBe('read_file_range_by_symbols');
    });

    it('should return null for unrecognized text', () => {
      const result = extractToolFromGarbled('some random garbage');
      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      expect(extractToolFromGarbled('')).toBeNull();
      expect(extractToolFromGarbled(null)).toBeNull();
    });
  });

  describe('extractActionLineToolCall - garbled formats', () => {
    it('should parse write_file glued to JSON args', () => {
      const text = '**Action**: write_file{"path":"src/services/stockService.js","content":"// service"}';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('write_file');
      expect(result.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(result.toolCalls[0].args.content).toBe('// service');
    });

    it('should parse task description concatenated with tool name', () => {
      const text = '**Action**: T1: Create StockTracker Componentwrite_file src/components/StockTracker.jsx';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('write_file');
      expect(result.toolCalls[0].args.path).toBe('src/components/StockTracker.jsx');
    });

    it('should parse edit_file glued to JSON args', () => {
      const text = '**Action**: edit_file{"path":"src/App.jsx","startLine":1,"endLine":5,"newText":"// fixed"}';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(1);
      expect(result.toolCalls[0].args.newText).toBe('// fixed');
    });
  });

  describe('extractContentAfterActionLine', () => {
    it('should extract content from fenced code block', () => {
      const text = '**Action**: write_file src/services/stockService.js\n```js\nexport async function fetchStockPrice(symbol) {\n  return { price: 150.00 };\n}\n```';
      const actionLine = '**Action**: write_file src/services/stockService.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('export async function fetchStockPrice(symbol) {\n  return { price: 150.00 };\n}');
    });

    it('should extract content from raw text lines', () => {
      const text = '**Action**: write_file src/services/stockService.js\nexport async function fetchStockPrice(symbol) {\n  return { price: 150.00 };\n}';
      const actionLine = '**Action**: write_file src/services/stockService.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toContain('export async function fetchStockPrice');
      expect(content).toContain('return { price: 150.00 }');
    });

    it('should return null when no content follows', () => {
      const text = '**Action**: write_file src/services/stockService.js';
      const actionLine = '**Action**: write_file src/services/stockService.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBeNull();
    });

    it('should stop at **Observation** marker', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n**Observation**: result';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should return null for empty lines only', () => {
      const text = '**Action**: write_file src/file.js\n\n\n';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBeNull();
    });

    it('should stop at "Write succeeded:" observation text', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\nWrite succeeded: src/file.js.';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should stop at "[[revert:" token', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n[[revert:abc123]]';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should stop at "```diff" markers', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n```diff\n@@ -1,0 +1,1 @@\n+const x = 1;';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should stop at **Validation Evidence** marker', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n**Validation Evidence**: File created';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should stop at **Completion Status** marker', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n**Completion Status**: Not yet complete';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should stop at **Next steps** marker', () => {
      const text = '**Action**: write_file src/file.js\nconst x = 1;\n**Next steps**: Run tests';
      const actionLine = '**Action**: write_file src/file.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('const x = 1;');
    });

    it('should not capture observation + diff + revert as file content', () => {
      // Simulates the real-world bug: LLM response has action line, content, then system observation text
      const text = [
        '**Action**: write_file src/services/stockService.js',
        'export async function fetchStockPrice(symbol) {',
        '  return { price: 150.00 };',
        '}',
        'Write succeeded: src/services/stockService.js.',
        '```diff',
        '@@ -1,0 +1,3 @@',
        '+export async function fetchStockPrice(symbol) {',
        '+  return { price: 150.00 };',
        '+}',
        '```',
        '[[revert:abc123]]',
        '**Validation Evidence**: File created',
        '**Completion Status**: Not yet complete',
        '**Next steps**: Add import to App.jsx',
        '**Action**: edit_file src/App.jsx startLine 4 endLine 4',
      ].join('\n');
      const actionLine = '**Action**: write_file src/services/stockService.js';
      const content = extractContentAfterActionLine(text, actionLine);
      expect(content).toBe('export async function fetchStockPrice(symbol) {\n  return { price: 150.00 };\n}');
    });
  });

  describe('extractActionLineToolCall - multi-line content', () => {
    it('should extract write_file content from subsequent code block', () => {
      const text = '**Action**: write_file src/services/stockService.js\n```js\nexport async function fetchStockPrice(symbol) {\n  return { price: 150.00 };\n}\n```';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('write_file');
      expect(result.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(result.toolCalls[0].args.content).toContain('export async function fetchStockPrice');
    });

    it('should extract write_file content from raw lines', () => {
      const text = '**Action**: write_file src/services/stockService.js\nexport function hello() {\n  return "world";\n}';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('write_file');
      expect(result.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(result.toolCalls[0].args.content).toContain('export function hello()');
    });

    it('should not set content when no subsequent lines exist', () => {
      const text = '**Action**: write_file src/services/stockService.js';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('write_file');
      expect(result.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(result.toolCalls[0].args.content).toBeUndefined();
    });
  });

  describe('normalizeAssistantResponse - multi-line content', () => {
    it('should extract write_file content from code block', () => {
      const text = '**Action**: write_file src/services/stockService.js\n```\nconst API_URL = "https://api.example.com";\nexport async function fetchStockPrice(symbol) {\n  return { price: 42.0 };\n}\n```';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('write_file');
      expect(parsed.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(parsed.toolCalls[0].args.content).toContain('export async function fetchStockPrice');
    });

    it('should not include content when only action line', () => {
      const text = '**Action**: write_file src/services/stockService.js';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('write_file');
      expect(parsed.toolCalls[0].args.path).toBe('src/services/stockService.js');
      expect(parsed.toolCalls[0].args.content).toBeUndefined();
    });
  });
  
  describe('parseEditFileNamedTokens', () => {
    it('should parse path, startLine, endLine, and newText from space-separated tokens', () => {
      const rest = 'src/App.jsx startLine 5 endLine 54 newText "import StockPrice from ./components/StockPrice;"';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/App.jsx');
      expect(result.startLine).toBe(5);
      expect(result.endLine).toBe(54);
      expect(result.newText).toBe('import StockPrice from ./components/StockPrice;');
    });

    it('should parse without newText', () => {
      const rest = 'src/App.jsx startLine 5 endLine 54';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/App.jsx');
      expect(result.startLine).toBe(5);
      expect(result.endLine).toBe(54);
      expect(result.newText).toBeUndefined();
    });

    it('should return null for input without startLine or lines keyword', () => {
      const result = parseEditFileNamedTokens('src/App.jsx');
      expect(result).toBeNull();
    });

    it('should return null for empty/null input', () => {
      expect(parseEditFileNamedTokens('')).toBeNull();
      expect(parseEditFileNamedTokens(null)).toBeNull();
    });

    it('should parse "lines N-N" format', () => {
      const rest = 'src/App.jsx lines 4-4';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/App.jsx');
      expect(result.startLine).toBe(4);
      expect(result.endLine).toBe(4);
    });

    it('should parse "lines N-N" with newText before lines keyword', () => {
      const rest = 'src/App.jsx newText "import StockPrice from \\"./StockPrice\\";" lines 4-4';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/App.jsx');
      expect(result.startLine).toBe(4);
      expect(result.endLine).toBe(4);
      expect(result.newText).toBe('import StockPrice from "./StockPrice";');
    });

    it('should parse "lines N-N" with multi-digit range', () => {
      const rest = 'src/components/Widget.tsx lines 10-25';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/components/Widget.tsx');
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(25);
    });

    it('should strip newText from path when embedded in path portion', () => {
      // Case: newText is between path and lines keyword, so path portion includes it
      const rest = 'src/App.jsx newText "const x = 1;" lines 5-5';
      const result = parseEditFileNamedTokens(rest);
      expect(result).not.toBeNull();
      expect(result.path).toBe('src/App.jsx');
      expect(result.newText).toBe('const x = 1;');
    });
  });

  describe('extractActionLineToolCall - edit_file named tokens', () => {
    it('should parse edit_file with space-separated startLine endLine newText', () => {
      const text = '**Action**: edit_file src/App.jsx startLine 5 endLine 5 newText "import StockPrice from ./StockPrice;"';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(5);
      expect(result.toolCalls[0].args.endLine).toBe(5);
      expect(result.toolCalls[0].args.newText).toBe('import StockPrice from ./StockPrice;');
    });

    it('should parse edit_file with startLine and endLine but no newText, extracting content from code block', () => {
      const text = '**Action**: edit_file src/App.jsx startLine 5 endLine 10\n```\nimport StockPrice from "./StockPrice";\n```';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(5);
      expect(result.toolCalls[0].args.endLine).toBe(10);
    });

    it('should parse edit_file with "lines N-N" format', () => {
      const text = '**Action**: edit_file src/App.jsx lines 4-4';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(4);
      expect(result.toolCalls[0].args.endLine).toBe(4);
    });

    it('should parse edit_file with "newText ... lines N-N" and strip newText from path', () => {
      const text = '**Action**: edit_file src/App.jsx newText "import StockPrice from \\"./components/StockPrice\\";" lines 4-4';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(4);
      expect(result.toolCalls[0].args.endLine).toBe(4);
      expect(result.toolCalls[0].args.newText).toBe('import StockPrice from "./components/StockPrice";');
    });

    it('should strip newText from path when embedded via fallback lines X-Y processing', () => {
      // If parseEditFileNamedTokens fails and we fall through to positional+lines regex,
      // the lines X-Y block should still strip newText from path
      const text = '**Action**: edit_file src/App.jsx newText "const x = 1;" lines 5-5';
      const result = extractActionLineToolCall(text);
      expect(result.toolCalls[0].tool).toBe('edit_file');
      expect(result.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(result.toolCalls[0].args.startLine).toBe(5);
      expect(result.toolCalls[0].args.endLine).toBe(5);
    });
  });

  describe('normalizeAssistantResponse - edit_file named tokens', () => {
    it('should parse edit_file with space-separated named args', () => {
      const text = '**Action**: edit_file src/App.jsx startLine 5 endLine 5 newText "const x = 1;"';
      const result = normalizeAssistantResponse(text);
      const parsed = JSON.parse(result);
      expect(parsed.toolCalls[0].tool).toBe('edit_file');
      expect(parsed.toolCalls[0].args.path).toBe('src/App.jsx');
      expect(parsed.toolCalls[0].args.startLine).toBe(5);
      expect(parsed.toolCalls[0].args.endLine).toBe(5);
      expect(parsed.toolCalls[0].args.newText).toBe('const x = 1;');
    });
  });

  // TODO extraction/stripping removed with deprecated todo architecture.
});
