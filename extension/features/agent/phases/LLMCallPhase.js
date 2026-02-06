/**
 * LLMCallPhase - Call LLM and handle response
 */

const { PhaseResult } = require('../PhaseResult');
const { getPendingPlan, buildPlanInstruction } = require('../utils/planUtils');
const { normalizeAssistantResponse } = require('../utils/parsing');

class LLMCallPhase {
  /**
   * Some OpenAI-compatible backends (notably Ollama-style servers) reject requests
   * where the last message role is "assistant". Ensure we always end with a "user"
   * turn before calling the model.
   * @private
   */
  _ensureLastMessageIsUser(messages, context) {
    const seed = Array.isArray(messages) ? messages : [];
    const last = seed.length ? seed[seed.length - 1] : null;
    const lastRole = last && typeof last.role === 'string' ? last.role : '';
    if (lastRole === 'user' || lastRole === 'tool') return seed;

    const mode = context && context.mode ? context.mode : 'chat';
    
    // In agent mode, provide concrete JSON examples and escalate after repeated failures
    if (mode === 'agent') {
      // Track non-JSON response streak for escalation
      if (!context._nonJsonStreak) context._nonJsonStreak = 0;
      context._nonJsonStreak += 1;
      
      // Extract last tool name if available for concrete example
      let exampleTool = 'read_file';
      let exampleArgs = { path: 'src/file.js', startLine: 1, endLine: 100 };
      
      if (last && last.role === 'assistant') {
        const actionMatch = /(?:\*\*Action\*\*|Action)\s*:\s*(\w+)/i.exec(last.content || '');
        if (actionMatch) {
          exampleTool = actionMatch[1];
          if (exampleTool === 'locate_file') exampleArgs = { query: 'file.js', maxResults: 20 };
          else if (exampleTool === 'search') exampleArgs = { query: 'function', maxResults: 20 };
        }
      }
      
      const nudge = context._nonJsonStreak >= 2
        ? `CRITICAL: Your previous ${context._nonJsonStreak} responses were not valid JSON. You MUST respond with a raw JSON object — no markdown, no "**Action**:" lines, no prose. Example: {"text":"Reading file","toolCalls":[{"tool":"${exampleTool}","args":${JSON.stringify(exampleArgs)}}]}`
        : `Continue execution. Your response MUST be a raw JSON object. Do NOT use "**Action**:" or any markdown formatting. Example: {"text":"Reading file","toolCalls":[{"tool":"${exampleTool}","args":${JSON.stringify(exampleArgs)}}]}`;
      
      const userMessage = { role: 'user', content: nudge };
      
      if (typeof context.addModelMessage === 'function') {
        context.addModelMessage(userMessage);
        return context.modelMessages;
      }
      return [...seed, userMessage];
    }
    
    const nudge = 'Continue.';
    const userMessage = { role: 'user', content: nudge };

    return [...seed, userMessage];
  }

  /**
   * Execute LLM call phase
   * - Build plan context if plan exists (planner mode only)
   * - Build message trace (mode-specific for chat/planner)
   * - Call LLM with messages
   * - Handle empty responses with retry
   * 
   * @param {BaseContext} context - Execution context (any mode)
   * @returns {Promise<PhaseResult>} Continue with assistant text, Retry, or Failure
   */
  async execute(context) {
    const chatState = context.getChatState();
    let modelSeed;
    
    // Build model messages based on mode
    if (context.mode === 'agent') {
      modelSeed = context.modelMessages;
    } else if (context.mode === 'planner') {
      // Planner mode: add plan instruction if plan exists
      const pendingPlan = getPendingPlan(chatState.plan);
      const planText = pendingPlan.length ? buildPlanInstruction(chatState.plan) : '';
      const planMessage = planText ? { role: 'user', content: planText } : null;
      modelSeed = context.buildModelMessageTrace
        ? context.buildModelMessageTrace()
        : context.modelMessages;
      if (planMessage) {
        modelSeed = [...modelSeed, planMessage];
      }
    } else if (context.mode === 'chat') {
      // Chat mode: use buildModelMessageTrace if available
      modelSeed = context.buildModelMessageTrace
        ? context.buildModelMessageTrace()
        : context.modelMessages;
    } else {
      modelSeed = context.modelMessages;
    }

    // Ensure the model sees a trailing user/tool message.
    modelSeed = this._ensureLastMessageIsUser(modelSeed, context);
    
    // Trim messages for model context limit
    const trimmedMessages = context.deps.trimChatMessagesForModel
      ? context.deps.trimChatMessagesForModel(modelSeed, context.historyLimit)
      : modelSeed;
    
    // Call LLM with mode-specific mode parameter
    let assistantText = await context.deps.callModelForChat({
      messages: trimmedMessages,
      mode: context.mode,
      context: chatState.contexts
    });
    
    // Normalize **Action**: format responses to JSON (for non-compliant models)
    if (context.mode === 'agent' && assistantText) {
      const normalized = normalizeAssistantResponse(assistantText);
      if (normalized !== assistantText) {
        // Normalization converted non-JSON (e.g. **Action**: ...) to JSON.
        // Do NOT reset _nonJsonStreak here — let nudges escalate so the
        // model learns to produce raw JSON instead of relying on normalization.
        assistantText = normalized;
      } else {
        // Already valid JSON — reset streak
        const parsed = require('../../../helpers/llm').safeJsonParse(assistantText);
        if (parsed && typeof parsed === 'object') {
          context._nonJsonStreak = 0;
        }
      }
    }
    
    // Handle empty response
    if (!assistantText || !String(assistantText).trim()) {
      const retryCount = context.incrementRetry();
      
      if (context.isRetryLimitReached()) {
        context.addUiMessage({
          role: 'assistant',
          content: 'Agent stopped: model returned empty response repeatedly.'
        });
        
        chatState.messages = context.uiMessages;
        if (context.deps.postChatState) {
          context.deps.postChatState();
        }
        
        return PhaseResult.failure('Empty response from LLM after 3 retries');
      }
      
      // Add error message and retry
      context.addModelMessage({
        role: 'user',
        content: `Error: you returned an empty response. Please provide a valid response with either tool calls or a final answer. (Attempt ${retryCount}/3)`
      });
      
      return PhaseResult.retry('Empty LLM response');
    }
    
    // Reset retry counter on success
    context.resetRetry();
    
    // Store assistant text
    context.lastAssistantText = assistantText;
    
    // Return continue with assistant text
    return PhaseResult.continue({ assistantText });
  }
}

module.exports = { LLMCallPhase };
