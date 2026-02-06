/**
 * FinalizationPhase - Finalize agent turn and prepare for next iteration
 * Simplified: completion logic handled earlier (e.g., CompletionDecisionPhase / ParsingPhase)
 */

const { PhaseResult } = require('../PhaseResult');

class FinalizationPhase {
  /**
   * Execute finalization phase
   * - Increment step counter
   * - Update chat state
   * - Post state updates
   * - Set continuation for potential resume
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue to next iteration
   */
  async execute(context) {
    // Increment step counter
    context.incrementStep();
    
    // Update chat state with current messages
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;
    
    // Post state update
    if (context.deps.postChatState) {
      context.deps.postChatState();
    }
    
    // Set continuation for potential resume
    if (context.deps.setAgentContinuation) {
      context.deps.setAgentContinuation(context.modelMessages);
    }
    
    // Always continue - completion detection happens in earlier phases
    return PhaseResult.continue();
  }
}

module.exports = { FinalizationPhase };
