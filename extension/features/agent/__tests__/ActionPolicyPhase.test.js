/**
 * @jest-environment node
 */

const { ActionPolicyPhase } = require('../phases/ActionPolicyPhase');

function makeContext({ stage, parsed, hasRead = false } = {}) {
  return {
    stage,
    data: { parsed: parsed || { toolCalls: [] } },
    addModelMessage: jest.fn(),
    addUiMessage: jest.fn(),
    hasReadSinceLastWrite: jest.fn().mockReturnValue(hasRead)
  };
}

describe('ActionPolicyPhase', () => {
  it('should redirect writes to read_file during exploration when path is present', async () => {
    const phase = new ActionPolicyPhase();
    const context = makeContext({
      stage: 'explore',
      parsed: {
        text: 'Editing',
        toolCalls: [{ tool: 'edit_file', args: { path: 'src/a.js', startLine: 1, endLine: 1, newText: 'x' } }]
      }
    });

    const result = await phase.execute(context);
    expect(result.status).toBe('continue');
    expect(context.data.parsed.toolCalls[0].tool).toBe('read_file');
    expect(context.data.parsed.toolCalls[0].args.path).toBe('src/a.js');
    expect(context.addUiMessage).toHaveBeenCalled();
    expect(result.data.redirected).toBe(true);
  });

  it('should retry during exploration when tool is disallowed and cannot be redirected', async () => {
    const phase = new ActionPolicyPhase();
    const context = makeContext({
      stage: 'explore',
      parsed: {
        text: 'Running tests',
        toolCalls: [{ tool: 'run_command', args: { command: 'npm test' } }]
      }
    });

    const result = await phase.execute(context);
    expect(result.status).toBe('retry');
    expect(context.addModelMessage).toHaveBeenCalled();
  });

  it('should redirect mutating edits to read_file in execute stage when file not read', async () => {
    const phase = new ActionPolicyPhase();
    const context = makeContext({
      stage: 'execute',
      hasRead: false,
      parsed: {
        text: 'Make a change',
        toolCalls: [{ tool: 'edit_file', args: { path: 'src/a.js', startLine: 1, endLine: 1, newText: 'x' } }]
      }
    });

    const result = await phase.execute(context);
    expect(result.status).toBe('continue');
    expect(context.data.parsed.toolCalls[0].tool).toBe('read_file');
    expect(context.addUiMessage).toHaveBeenCalled();
    expect(result.data.redirected).toBe(true);
  });

  it('should allow edits in execute stage when file was read since last write', async () => {
    const phase = new ActionPolicyPhase();
    const context = makeContext({
      stage: 'execute',
      hasRead: true,
      parsed: {
        text: 'Make a change',
        toolCalls: [{ tool: 'edit_file', args: { path: 'src/a.js', startLine: 1, endLine: 1, newText: 'x' } }]
      }
    });

    const result = await phase.execute(context);
    expect(result.status).toBe('continue');
    expect(context.data.parsed.toolCalls[0].tool).toBe('edit_file');
    expect(context.addUiMessage).not.toHaveBeenCalled();
  });

  it('should allow new file creation without prior read', async () => {
    const phase = new ActionPolicyPhase();
    const context = makeContext({
      stage: 'execute',
      hasRead: false,
      parsed: {
        text: 'Create a file',
        toolCalls: [{ tool: 'write_file', args: { path: 'new.txt', content: 'hi', overwrite: false, append: false } }]
      }
    });

    const result = await phase.execute(context);
    expect(result.status).toBe('continue');
    expect(context.data.parsed.toolCalls[0].tool).toBe('write_file');
  });
});

