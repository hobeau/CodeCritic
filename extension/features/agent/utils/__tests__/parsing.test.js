const { parseAgentResponse, extractActionLineToolCall } = require('../parsing');

describe('agent parsing', () => {
  it('should parse readyForPlan and planUpdate metadata', () => {
    const input = JSON.stringify({
      text: 'Reading context',
      readyForPlan: true,
      planUpdate: { progressLogEntry: 'obs: did a thing' },
      toolCalls: [{ tool: 'read_file', args: { path: 'a.js', startLine: 1, endLine: 10 } }]
    });

    const parsed = parseAgentResponse(input);
    expect(parsed).toBeTruthy();
    expect(parsed.text).toBe('Reading context');
    expect(parsed.readyForPlan).toBe(true);
    expect(parsed.planUpdate).toEqual({ progressLogEntry: 'obs: did a thing' });
    expect(Array.isArray(parsed.toolCalls)).toBe(true);
    expect(parsed.toolCalls[0].tool).toBe('read_file');
  });

  it('should carry metadata through final responses', () => {
    const input = JSON.stringify({
      final: 'done',
      readyForPlan: true,
      planUpdate: { findings: { entryPoints: 'x' } }
    });

    const parsed = parseAgentResponse(input);
    expect(parsed).toEqual({
      final: 'done',
      readyForPlan: true,
      planUpdate: { findings: { entryPoints: 'x' } }
    });
  });

  it('should extract tool calls from **Action**: lines', () => {
    const input = '**Action**: locate_file query="app.jsx"';
    const parsed = extractActionLineToolCall(input);
    expect(parsed).toEqual({
      toolCalls: [{ tool: 'locate_file', args: { query: 'app.jsx' } }],
      text: ''
    });
  });

  it('should extract positional read_file from Action: lines and default the range', () => {
    const input = 'Action: read_file src/App.jsx';
    const parsed = extractActionLineToolCall(input);
    expect(parsed.toolCalls[0].tool).toBe('read_file');
    expect(parsed.toolCalls[0].args.path).toBe('src/App.jsx');
    expect(parsed.toolCalls[0].args.startLine).toBe(1);
    expect(parsed.toolCalls[0].args.endLine).toBe(200);
  });

  it('should strip repeated line ranges from read_file path', () => {
    const input = 'Action: read_file src/App.jsx lines 1-70 lines 1-70';
    const parsed = extractActionLineToolCall(input);
    expect(parsed.toolCalls[0].tool).toBe('read_file');
    expect(parsed.toolCalls[0].args.path).toBe('src/App.jsx');
    expect(parsed.toolCalls[0].args.startLine).toBe(1);
    expect(parsed.toolCalls[0].args.endLine).toBe(70);
  });
});
