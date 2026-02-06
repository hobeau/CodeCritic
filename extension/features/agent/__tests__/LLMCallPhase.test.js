/**
 * @jest-environment node
 */

const { LLMCallPhase } = require('../phases/LLMCallPhase');
const { BaseContext } = require('../BaseContext');

describe('LLMCallPhase', () => {
  it('should append a trailing user message when the last role is assistant (Ollama compatibility)', async () => {
    const phase = new LLMCallPhase();

    const callModelForChat = jest.fn(async ({ messages }) => {
      const last = messages[messages.length - 1];
      expect(last.role).toBe('user');
      return '{"text":"ok","toolCalls":[{"tool":"read_dir","args":{"path":".","maxDepth":1,"maxEntries":10}}]}';
    });

    const context = new BaseContext({
      mode: 'agent',
      baseMessages: [],
      modelMessages: [{ role: 'assistant', content: 'Execution plan...' }],
      deps: {
        chatState: { contexts: [] },
        callModelForChat,
        trimChatMessagesForModel: (msgs) => msgs
      }
    });
    context.historyLimit = 10000;

    const result = await phase.execute(context);
    expect(result.status).toBe('continue');
    expect(callModelForChat).toHaveBeenCalledTimes(1);
    expect(context.modelMessages[context.modelMessages.length - 1].role).toBe('user');
    expect(String(context.lastAssistantText)).toContain('"toolCalls"');
  });

  it.todo('should build plan instruction when plan exists');
  
  it.todo('should call LLM with trimmed messages');
  
  it.todo('should handle empty LLM response with retry');
  
  it.todo('should return PhaseResult.failure() after 3 empty responses');
  
  it.todo('should reset retry counter on successful response');
  
  it.todo('should store assistant text in context');
  
  it.todo('should return PhaseResult.continue() with assistant text data');
});
