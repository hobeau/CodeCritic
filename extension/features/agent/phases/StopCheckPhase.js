/**
 * StopCheckPhase - Check if user requested agent stop
 */

const { PhaseResult } = require('../PhaseResult');

class StopCheckPhase {
  /**
   * Execute stop check phase
   * - Check if stop was requested
   * - Update state and messages if stopping
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Stop or Continue result
   */
  async execute(context) {
    if (context.isStopRequested()) {
      // Clear stop flag via dependency
      if (context.deps.clearStopFlag) {
        context.deps.clearStopFlag();
      }
      
      // Clear agent continuation
      if (context.deps.setAgentContinuation) {
        context.deps.setAgentContinuation(null);
      }
      
      // Add stop message to UI
      context.addUiMessage({ role: 'assistant', content: 'Stopped.' });
      
      // Update chat state
      const chatState = context.getChatState();
      chatState.messages = context.uiMessages;
      
      // Post state update
      if (context.deps.postChatState) {
        context.deps.postChatState();
      }
      
      return PhaseResult.stop();
    }
    
    return PhaseResult.continue();
  }
}

module.exports = { StopCheckPhase };
