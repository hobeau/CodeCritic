/**
 * ChatInitializationPhase - Initialize chat context with configuration
 */

const { PhaseResult } = require('../PhaseResult');

class ChatInitializationPhase {
  /**
   * Execute initialization phase for chat mode
   * - Load configuration (max steps, history limit)
   * - Initialize context state variables
   * 
   * @param {ChatContext} context - Chat execution context
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context) {
    // Get chat-specific configuration from injected dependencies
    const maxSteps = context.deps.getChatMaxSteps();
    const historyLimit = context.deps.getChatHistoryCharLimit();
    
    // Initialize context with config values
    context.initializeConfig(maxSteps, historyLimit);
    
    // Return continue to proceed to next phase
    return PhaseResult.continue();
  }
}

module.exports = { ChatInitializationPhase };
