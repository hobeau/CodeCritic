/**
 * PrePlanFinalizationPhase - Finalize a pre-plan exploration iteration
 *
 * Responsibilities:
 * - Increment prePlanStep (separate from main execute step budget)
 * - Sync UI state and continuation messages
 */

const { PhaseResult } = require('../PhaseResult');

class PrePlanFinalizationPhase {
  async execute(context) {
    context.incrementPrePlanStep();

    // Track whether we successfully executed at least one exploration action
    if (context.data && context.data.toolSucceeded) {
      context.markPrePlanSuccessfulAction();
    }

    // Update chat state with current messages
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;

    if (context.deps.postChatState) {
      context.deps.postChatState();
    }

    if (context.deps.setAgentContinuation) {
      context.deps.setAgentContinuation(context.modelMessages);
    }

    return PhaseResult.continue({ prePlanStep: context.prePlanStep });
  }
}

module.exports = { PrePlanFinalizationPhase };

