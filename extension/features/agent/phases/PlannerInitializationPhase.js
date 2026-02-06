/**
 * PlannerInitializationPhase - Initialize planner context with configuration
 */

const { PhaseResult } = require('../PhaseResult');

class PlannerInitializationPhase {
  /**
   * Execute initialization phase for planner mode
   * - Load configuration (max steps, history limit)
   * - Initialize context state variables
   * 
   * @param {PlannerContext} context - Planner execution context
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context) {
    // Get planner-specific configuration from injected dependencies
    const maxSteps = context.deps.getChatMaxSteps(); // Planner uses same as chat
    const historyLimit = context.deps.getChatHistoryCharLimit();
    
    // Initialize context with config values
    context.initializeConfig(maxSteps, historyLimit);
    
    // Return continue to proceed to next phase
    return PhaseResult.continue();
  }
}

module.exports = { PlannerInitializationPhase };
