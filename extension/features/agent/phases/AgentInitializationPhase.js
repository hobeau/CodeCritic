/**
 * AgentInitializationPhase - Initialize agent context with configuration
 */

const { PhaseResult } = require('../PhaseResult');

class AgentInitializationPhase {
  /**
   * Execute initialization phase
   * - Load configuration (max steps, history limit)
   * - Initialize context state variables
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context) {
    // Get configuration from injected dependencies
    const maxSteps = context.deps.getAgentMaxSteps();
    const historyLimit = context.deps.getChatHistoryCharLimit();
    
    // Initialize context with config values
    context.initializeConfig(maxSteps, historyLimit);
    
    // Return continue to proceed to next phase
    return PhaseResult.continue();
  }
}

module.exports = { AgentInitializationPhase };
