/**
 * PlanUpdatePhase - Update plan from parsed response (planner mode only)
 */

const { PhaseResult } = require('../PhaseResult');

class PlanUpdatePhase {
  /**
   * Execute plan update phase
   * - Extract plan from parsed response
   * - Update plan in chat state
   * 
   * @param {PlannerContext} context - Planner execution context
   * @param {object} parsed - Parsed response with plan array
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context, parsed) {
    // Only process if we have a plan array
    if (!parsed || !Array.isArray(parsed.plan)) {
      return PhaseResult.continue();
    }
    
    // Update plan via context
    await context.updatePlan(parsed.plan);
    
    return PhaseResult.continue();
  }
}

module.exports = { PlanUpdatePhase };
