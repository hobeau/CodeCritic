/**
 * StrengtheningPhase (Phase G) - Add/adjust tests and refactor within scope
 * 
 * Responsibilities:
 * - Prompt LLM to add or adjust tests for new behavior
 * - Allow light refactoring within scope
 * - Re-run acceptance checks after strengthening
 * - Ensure changes stay within scope boundaries
 */

const { PhaseResult } = require('../PhaseResult');

class StrengtheningPhase {
  /**
   * Execute strengthening phase
   * - Skip if already strengthened this cycle
   * - Skip if validation is failing (fix first)
   * - Prompt for test additions and light refactoring
   * - Validate after strengthening
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context) {
    // Skip if currently in debug loop (fix failures first)
    if (context.data?.inDebugLoop) {
      return PhaseResult.continue();
    }
    
    // Skip if no tool executions have happened yet
    // Without this check, we can prompt strengthening before any work is done
    const hasExecutions = Array.isArray(context.executedTools) && context.executedTools.length > 0;
    if (!hasExecutions) {
      return PhaseResult.continue();
    }
    
    // Skip if validation is failing
    if (this.hasValidationFailures(context)) {
      return PhaseResult.continue();
    }
    
    // Skip if already strengthened (check flag in context)
    if (context.strengtheningComplete) {
      return PhaseResult.continue();
    }

    context.setCurrentPhase('G');

    // Check if strengthening is needed
    const needsStrengthening = this.assessStrengtheningNeeds(context);
    
    if (!needsStrengthening) {
      context.strengtheningComplete = true;
      return PhaseResult.continue({ strengtheningSkipped: true });
    }

    // Prompt LLM for strengthening
    const strengtheningPrompt = this.buildStrengtheningPrompt(context);
    
    context.addUiMessage({
      role: 'assistant',
      content: '**Phase G: Strengthening** (Add tests and optional refactoring)'
    });
    
    // Add strengthening guidance to model context
    context.addModelMessage({
      role: 'user',
      content: strengtheningPrompt
    });
    
    // Mark as prompted (LLM will take action in next iteration)
    context.strengtheningPrompted = true;
    
    return PhaseResult.continue({ 
      strengtheningActive: true
    });
  }

  /**
   * Check if validation has failures
   * @private
   */
  hasValidationFailures(context) {
    const evidence = context.currentEvidence;
    if (!evidence) return false;
    
    if (evidence.build && !evidence.build.success && !evidence.build.error) {
      return true;
    }
    
    if (evidence.tests && !evidence.tests.passed && !evidence.tests.error) {
      return true;
    }
    
    if (evidence.diagnostics && context.baseline?.diagnostics) {
      const baselineCount = context.baseline.diagnostics.count || 0;
      const currentCount = evidence.diagnostics.count || 0;
      if (currentCount > baselineCount) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Assess if strengthening is needed
   * @private
   */
  assessStrengtheningNeeds(context) {
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan) return false;

    // Check if plan includes test-related acceptance checks
    const hasTestRequirement = parsedPlan.acceptanceChecks?.some(check => 
      check.text.toLowerCase().includes('test')
    );
    
    // Check if plan includes test-related tasks
    const hasTestTask = parsedPlan.tasks?.some(task =>
      task.title.toLowerCase().includes('test') || 
      task.description.toLowerCase().includes('test')
    );
    
    // Strengthening needed if tests are mentioned in acceptance or tasks
    return hasTestRequirement || hasTestTask;
  }

  /**
   * Build strengthening prompt for LLM
   * @private
   */
  buildStrengtheningPrompt(context) {
    const parsedPlan = context.getParsedPlan();
    const objective = parsedPlan?.header?.objective || 'the change';
    const scope = parsedPlan?.header?.scope || 'current scope';

    return `**Phase G: Strengthening**

Your implementation is passing validation, but we need to ensure it's robust and maintainable.

**Tasks:**

1. **Add or Update Tests**
   - Add tests that prove the new behavior works
   - Ensure tests fail before your changes and pass after
   - Cover edge cases and error conditions
   - Update existing tests if behavior changed

2. **Light Refactoring (Optional)**
   - Only if it reduces complexity or improves readability
   - Must stay within scope: ${scope}
   - No new dependencies or major architectural changes
   - Preserve all existing behavior and contracts

3. **Validation**
   - After any changes, re-run acceptance checks
   - Ensure build/tests/diagnostics still pass
   - Verify no regressions introduced

**Objective**: ${objective}

**Constraints:**
- Stay within scope boundaries
- Don't break existing functionality
- Keep changes minimal and focused
- If no strengthening is needed, simply confirm and proceed

Begin strengthening now, or confirm that strengthening is not needed.`;
  }
}

module.exports = { StrengtheningPhase };
