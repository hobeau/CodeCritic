/**
 * DebugLoopPhase (Phase F) - Nested ReAct cycle with iteration counter
 * 
 * Responsibilities:
 * - Detect failures (build/test/diagnostic errors)
 * - Track debug iteration count
 * - Apply debug self-correction prompts
 * - Escalate to human after max iterations
 */

const { PhaseResult } = require('../PhaseResult');
const { getAcceptanceCheckRequirements } = require('../utils/MarkdownPlanManager');
const { getDebugSelfCorrectionPrompt } = require('../utils/SelfCorrectionPrompts');

class DebugLoopPhase {
  /**
   * Execute debug loop phase
   * - Check if validation failed (evidence shows failures)
   * - Increment debug iteration counter
   * - Apply debug self-correction prompt
   * - Escalate to human if max iterations reached
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue or await human input
   */
  async execute(context) {
    // Only enter debug loop right after a validation run in this iteration
    if (!context.data?.validationComplete) {
      return PhaseResult.continue();
    }
    const validationData = context.data || {};
    
    // Only enter debug loop if validation failed
    if (!this.hasValidationFailures(context)) {
      // Reset debug counter on success
      context.resetDebugIterationCount();
      return PhaseResult.continue();
    }

    context.setCurrentPhase('F');

    // Increment debug iteration counter
    const iterationCount = context.incrementDebugIterationCount();
    
    // Get max iterations from config
    const maxIterations = context.deps.getDebugLoopMaxIterations 
      ? context.deps.getDebugLoopMaxIterations() 
      : 5;
    
    // Check if we've hit the limit
    if (iterationCount >= maxIterations) {
      return await this.escalateToHuman(context, iterationCount);
    }
    
    // Categorize the failure
    const failureInfo = this.categorizeFailure(context);
    
    // Apply debug self-correction prompt
    const debugPrompt = getDebugSelfCorrectionPrompt({
      type: failureInfo.type,
      message: failureInfo.message,
      attemptCount: iterationCount
    });
    
    context.addUiMessage({
      role: 'assistant',
      content: `**Debug Loop** (Attempt ${iterationCount}/${maxIterations}): ${failureInfo.type}`
    });
    
    // Add debug prompt to model context
    context.addModelMessage({
      role: 'user',
      content: debugPrompt
    });
    
    return PhaseResult.continue({
      inDebugLoop: true,
      debugIteration: iterationCount,
      failureType: failureInfo.type
    });
  }

  /**
   * Check if validation revealed failures
   * @private
   */
  hasValidationFailures(context) {
    const evidence = context.currentEvidence;
    const requirements = getAcceptanceCheckRequirements(context.getParsedPlan());
    if (!evidence) return false;
    
    // Check for build failures
    if (requirements.requiresBuild && evidence.build && !evidence.build.success && !evidence.build.error) {
      return true;
    }
    
    // Check for test failures
    if (requirements.requiresTests && evidence.tests && !evidence.tests.passed && !evidence.tests.error) {
      return true;
    }
    
    // Check for new diagnostics vs baseline
    if (requirements.requiresDiagnostics && evidence.diagnostics && context.baseline?.diagnostics) {
      const baselineCount = context.baseline.diagnostics.count || 0;
      const currentCount = evidence.diagnostics.count || 0;
      if (currentCount > baselineCount) {
        return true; // New problems introduced
      }
    }
    
    return false;
  }

  /**
   * Categorize the type of failure
   * @private
   */
  categorizeFailure(context) {
    const evidence = context.currentEvidence;
    const requirements = getAcceptanceCheckRequirements(context.getParsedPlan());
    
    // Build failure
    if (requirements.requiresBuild && evidence?.build && !evidence.build.success) {
      return {
        type: 'compile/build error',
        message: evidence.build.raw ? evidence.build.raw.substring(0, 300) : 'Build failed'
      };
    }
    
    // Test failure
    if (requirements.requiresTests && evidence?.tests && !evidence.tests.passed) {
      const failedCount = evidence.tests.failedCount || 'some';
      return {
        type: 'test failure',
        message: `${failedCount} test(s) failed. ${evidence.tests.raw ? evidence.tests.raw.substring(0, 300) : ''}`
      };
    }
    
    // Diagnostic errors
    if (requirements.requiresDiagnostics && evidence?.diagnostics && evidence.diagnostics.count > 0) {
      const problems = evidence.diagnostics.problems || [];
      const sample = problems.slice(0, 3).join('; ');
      return {
        type: 'diagnostic/lint error',
        message: `${evidence.diagnostics.count} problems. Examples: ${sample}`
      };
    }
    
    // Runtime or integration failure
    return {
      type: 'runtime/integration error',
      message: 'Behavior does not match expected repro steps'
    };
  }

  /**
   * Escalate to human after max iterations
   * @private
   */
  async escalateToHuman(context, iterationCount) {
    const failureInfo = this.categorizeFailure(context);
    
    const question = `**Debug Loop Limit Reached** (${iterationCount} attempts)

I've attempted to fix the following issue ${iterationCount} times without success:

**Failure Type**: ${failureInfo.type}
**Details**: ${failureInfo.message}

**What I've tried:**
[Review the last ${iterationCount} iterations in the conversation]

**I need your help:**
1. Should I continue with a different approach? (Please suggest)
2. Is there context or design knowledge I'm missing?
3. Should I revert changes and start over?
4. Is the acceptance criteria correct, or should the plan be revised?

Please provide guidance on how to proceed.`;

    // Set awaiting human input state
    context.setAwaitingHumanInput(question);
    
    // Display question to user
    context.addUiMessage({
      role: 'assistant',
      content: question
    });
    
    // Return special result to pause agent loop
    return PhaseResult.continue({
      awaitingHumanInput: true,
      debugIterationCount: iterationCount,
      pendingQuestion: question
    });
  }
}

module.exports = { DebugLoopPhase };
