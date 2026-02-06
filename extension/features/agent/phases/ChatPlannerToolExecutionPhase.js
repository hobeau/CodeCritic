/**
 * ChatPlannerToolExecutionPhase - Execute tool calls for chat/planner modes
 * Sequential execution only, no batching, no deduplication, no auto-verification
 * (read-only tools only for chat/planner modes)
 */

const { PhaseResult } = require('../PhaseResult');
const { normalizeToolCall, formatToolResultForUi, limitToolOutput } = require('../utils/toolUtils');

class ChatPlannerToolExecutionPhase {
  /**
   * Execute tool execution phase for chat/planner modes
   * - Display leading text if present
   * - Execute tools sequentially (no batching)
   * - Format and display results
   * - Add results to model context
   * 
   * @param {ChatContext|PlannerContext} context - Execution context
   * @param {object} parsed - Parsed response with toolCalls array
   * @returns {Promise<PhaseResult>} Continue result to loop again
   */
  async execute(context, parsed) {
    // Skip if no tool calls
    if (!parsed || !parsed.toolCalls || !parsed.toolCalls.length) {
      return PhaseResult.continue();
    }

    // Display leading text if present
    if (parsed.text && parsed.text.trim()) {
      const leadText = parsed.text.trim();
      context.addUiMessage({ role: 'assistant', content: leadText });
      
      // Update chat state immediately
      const chatState = context.getChatState();
      chatState.messages = context.uiMessages;
      await context.deps.postChatState();
      
      // Persist to thread if available
      if (context.deps.threadId) {
        await context.deps.addChatMessage(context.deps.threadId, 'assistant', leadText);
        await context.deps.touchChatThread(context.deps.threadId);
        await context.deps.refreshChatThreads();
      }
    }

    // Construct assistant message from parsed data for model context
    const assistantMessage = JSON.stringify({
      toolCalls: parsed.toolCalls,
      ...(parsed.text && { text: parsed.text }),
      ...(parsed.plan && { plan: parsed.plan })
    });
    context.addModelMessage({ role: 'assistant', content: assistantMessage });

    // Execute tools sequentially
    for (const call of parsed.toolCalls) {
      // Normalize tool call
      const normalizedCall = normalizeToolCall(call);
      
      // Describe tool call for UI
      const toolLabel = context.deps.describeToolCall
        ? context.deps.describeToolCall(normalizedCall)
        : `Calling ${normalizedCall.tool}...`;
      context.addToolMessage({ role: 'assistant', content: toolLabel });
      
      // Execute tool
      const result = await context.deps.runToolCall(normalizedCall);
      
      // Record execution
      context.recordToolExecution(normalizedCall, result);
      
      // Format result for display
      const resultText = formatToolResultForUi(normalizedCall.tool, limitToolOutput(result, 12000));
      context.addToolMessage({ role: 'assistant', content: resultText });
      context.addModelToolMessage({ role: 'user', content: resultText });
    }

    // Update UI with tool messages
    context.uiMessages = [...context.uiMessages, ...context.toolMessages];
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;
    await context.deps.postChatState();

    // Persist tool messages to thread if available
    if (context.deps.threadId) {
      for (const toolMsg of context.toolMessages) {
        await context.deps.addChatMessage(context.deps.threadId, 'assistant', toolMsg.content);
      }
      await context.deps.touchChatThread(context.deps.threadId);
      await context.deps.refreshChatThreads();
    }

    // Trim model messages with tool results
    const fullModelTrace = [...context.modelMessages, ...context.modelToolMessages];
    context.modelMessages = context.deps.trimChatMessagesForModel(fullModelTrace, context.historyLimit);

    // Return continue to loop for next iteration
    return PhaseResult.continue();
  }
}

module.exports = { ChatPlannerToolExecutionPhase };
