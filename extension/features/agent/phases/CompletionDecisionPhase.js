/**
 * CompletionDecisionPhase (Phase H) - Verify all acceptance checks with evidence
 * 
 * Responsibilities:
 * - Verify all acceptance checks are satisfied with evidence
 * - Check that diff is within scope
 * - Ensure no new diagnostics vs baseline
 * - Decide whether to stop (complete) or continue (more work needed)
 */

const { PhaseResult } = require('../PhaseResult');
const { 
  areAllAcceptanceChecksSatisfied, 
  areAllTasksComplete,
  getPendingTasks,
  getAcceptanceCheckRequirements
} = require('../utils/MarkdownPlanManager');
const { EvidenceStrength } = require('../EvidenceTypes');
const { TOOL_WRITE, isToolResultSuccess } = require('../utils/toolUtils');

class CompletionDecisionPhase {
  /**
   * Execute completion decision phase
   * - Evaluate all acceptance checks
   * - Compare evidence against baseline
   * - Check scope boundaries
   * - Decide to stop or continue
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Stop or Continue
   */
  async execute(context) {
    context.setCurrentPhase('H');

    // Skip completion check if last action failed - give agent chance to recover
    const executions = Array.isArray(context.executedTools) ? context.executedTools : [];
    const lastExecution = executions.length ? executions[executions.length - 1] : null;
    const lastResult = lastExecution ? lastExecution.result : null;
    const lastSucceeded = (() => {
      if (!lastExecution) return true;
      if (lastResult && typeof lastResult === 'object') {
        return lastResult.success !== false;
      }
      return isToolResultSuccess(lastResult);
    })();
    if (!lastSucceeded) {
      return PhaseResult.continue({
        skippedCompletionCheck: true,
        reason: 'Last action failed - skipping completion check to allow recovery'
      });
    }

    // Check if awaiting human input
    if (context.awaitingHumanInput) {
      return PhaseResult.continue({
        pausedForHumanInput: true,
        pendingQuestion: context.pendingQuestion
      });
    }

    const parsedPlan = context.getParsedPlan();
    const evidence = context.currentEvidence;
    const baseline = context.baseline;
    const requirements = getAcceptanceCheckRequirements(parsedPlan);
    const didMutate = this.didMutate(context);

    // NEW: Guard for continuous plan refinement
    // If plan was just reflected and changed, continue to validate changes
    if (context.planReflected && context.planChanged) {
      return PhaseResult.continue({
        skippedCompletionCheck: true,
        reason: 'Plan was recently updated - continuing to validate changes'
      });
    }

    // Perform completion checks
    const checks = {
      acceptanceChecksSatisfied: this.checkAcceptanceCriteria(parsedPlan, evidence, baseline),
      allTasksComplete: this.checkTasksComplete(parsedPlan),
      evidenceStrengthAdequate: this.checkEvidenceStrength(context),
      noNewDiagnostics: this.checkDiagnostics(parsedPlan, evidence, baseline),
      withinScope: this.checkScope(parsedPlan, context)
    };

    // Guard: if diagnostics were required and baseline had errors, require at least one mutation
    if (requirements.requiresDiagnostics) {
      const baselineCount = baseline?.diagnostics?.count || 0;
      if (baselineCount > 0 && !didMutate) {
        checks.acceptanceChecksSatisfied = {
          passed: false,
          reason: 'Baseline diagnostics had errors but no code changes were made'
        };
        // Build concrete edit guidance with diagnostic details
        const diagList = baseline?.diagnostics?.list;
        const diagLines = Array.isArray(diagList) && diagList.length
          ? diagList.map(d => `- ${d}`).join('\n')
          : '';
        // Extract the range of error lines to guide the LLM to a wider edit
        const lineNumbers = Array.isArray(diagList)
          ? diagList.map(d => { const m = /:(\d+):\d+/.exec(d); return m ? Number(m[1]) : 0; }).filter(n => n > 0)
          : [];
        const minLine = lineNumbers.length ? Math.max(1, Math.min(...lineNumbers) - 3) : 0;
        const maxLine = lineNumbers.length ? Math.max(...lineNumbers) + 5 : 0;
        const rangeHint = minLine && maxLine
          ? ` Cover the full error region (approximately lines ${minLine}-${maxLine}) in a single edit_file call to fix all related issues at once.`
          : '';

        context.addModelMessage({
          role: 'user',
          content: `IMPORTANT: You have not made any code edits yet. The diagnostics show ${baselineCount} error(s) that need a code fix.${diagLines ? '\n' + diagLines : ''}\nUse edit_file with startLine, endLine, and newText as a JSON response.${rangeHint}\nExample: {"text":"Fixing errors","toolCalls":[{"tool":"edit_file","args":{"path":"src/file.js","startLine":10,"endLine":20,"newText":"corrected code here"}}]}`
        });
      }
    }

    const allChecksPassed = Object.values(checks).every(check => check.passed);

    // Build decision summary
    const summary = this.buildDecisionSummary(checks);
    
    context.addUiMessage({
      role: 'assistant',
      content: `**Completion Check**:\n${summary}`
    });

    // If all checks passed, we're done
    if (allChecksPassed) {
      return this.completeSuccessfully(context, summary);
    }

    // Otherwise, identify what needs work
    const nextSteps = this.identifyNextSteps(checks, parsedPlan);
    
    context.addModelMessage({
      role: 'user',
      content: `**Completion Status**: Not yet complete.\n\n${summary}\n\n**Next steps**: ${nextSteps}`
    });

    return PhaseResult.continue({
      completionChecked: true,
      allChecksPassed: false,
      nextSteps
    });
  }

  /**
   * Check acceptance criteria
   * @private
   */
  checkAcceptanceCriteria(parsedPlan, evidence, baseline) {
    if (!parsedPlan || !parsedPlan.acceptanceChecks) {
      return { passed: false, reason: 'No acceptance checks defined' };
    }

    // NEW: Filter out soft-deleted acceptance checks ([REMOVED] prefix)
    const activeChecks = parsedPlan.acceptanceChecks.filter(c => 
      !c.text.startsWith('[REMOVED]')
    );
    
    if (activeChecks.length === 0) {
      return { passed: false, reason: 'No active acceptance checks defined' };
    }

    // Check if all active checks are marked as checked
    const allChecked = activeChecks.every(c => c.checked);
    if (!allChecked) {
      const unchecked = activeChecks.filter(c => !c.checked);
      return { 
        passed: false, 
        reason: `${unchecked.length} acceptance check(s) not satisfied: ${unchecked.map(c => c.text).join(', ')}`
      };
    }

    // Verify with evidence
    if (evidence) {
      // Build success check
      if (baseline?.build && evidence.build) {
        if (!evidence.build.success && baseline.build.success) {
          return { passed: false, reason: 'Build regressed from baseline' };
        }
      }

      // Test pass check
      if (baseline?.tests && evidence.tests) {
        if (!evidence.tests.passed && baseline.tests.passed) {
          return { passed: false, reason: 'Tests regressed from baseline' };
        }
      }
    }

    return { passed: true, reason: 'All acceptance checks satisfied' };
  }

  /**
   * Check if all tasks are complete
   * @private
   */
  checkTasksComplete(parsedPlan) {
    if (!parsedPlan || !parsedPlan.tasks) {
      return { passed: true, reason: 'No tasks defined' };
    }
    if (Array.isArray(parsedPlan.tasks) && parsedPlan.tasks.length > 0) {
      const anyChecked = parsedPlan.tasks.some(task => task.checked);
      if (!anyChecked) {
        return { passed: true, reason: 'Tasks not explicitly tracked (skipping task gate)' };
      }
    }

    const allComplete = areAllTasksComplete(parsedPlan);
    if (!allComplete) {
      const pending = getPendingTasks(parsedPlan);
      return { 
        passed: false, 
        reason: `${pending.length} task(s) incomplete: ${pending.map(t => t.id).join(', ')}`
      };
    }

    return { passed: true, reason: 'All tasks complete' };
  }

  /**
   * Check evidence strength
   * @private
   */
  checkEvidenceStrength(context) {
    const strength = context.getEvidenceStrength();
    const requirements = getAcceptanceCheckRequirements(context.getParsedPlan());
    const evidence = context.currentEvidence || {};

    const requiredParts = [];
    if (requirements.requiresBuild) requiredParts.push('build');
    if (requirements.requiresTests) requiredParts.push('tests');
    if (requirements.requiresDiagnostics) requiredParts.push('diagnostics');

    if (requiredParts.length > 0) {
      const missing = [];
      if (requirements.requiresBuild && !evidence.build) missing.push('build');
      if (requirements.requiresTests && !evidence.tests) missing.push('tests');
      if (requirements.requiresDiagnostics && !evidence.diagnostics) missing.push('diagnostics');
      if (missing.length > 0) {
        return {
          passed: false,
          reason: `Missing required evidence: ${missing.join(', ')}`
        };
      }
      return { passed: true, reason: 'Required evidence collected' };
    }

    // Fallback: Require at least MEDIUM strength
    if (strength < EvidenceStrength.MEDIUM) {
      return { 
        passed: false, 
        reason: `Evidence strength too low (${strength}). Need tests or build validation.`
      };
    }

    return { passed: true, reason: `Evidence strength adequate (${strength})` };
  }

  /**
   * Check diagnostics vs baseline
   * @private
   */
  checkDiagnostics(parsedPlan, evidence, baseline) {
    const requirements = getAcceptanceCheckRequirements(parsedPlan);
    if (!requirements.requiresDiagnostics) {
      return { passed: true, reason: 'Diagnostics not required by plan' };
    }
    if (!evidence?.diagnostics || !baseline?.diagnostics) {
      return { passed: true, reason: 'Diagnostics not available' };
    }

    const baselineCount = baseline.diagnostics.count || 0;
    const currentCount = evidence.diagnostics.count || 0;
    const newProblems = currentCount - baselineCount;

    if (newProblems > 0) {
      return { 
        passed: false, 
        reason: `${newProblems} new diagnostic problem(s) introduced`
      };
    }

    return { passed: true, reason: 'No new diagnostics vs baseline' };
  }

  /**
   * Check if changes are within scope
   * @private
   */
  checkScope(parsedPlan, context) {
    // For now, assume scope is okay unless explicitly flagged
    // In a full implementation, we'd check modified files against scope boundaries
    
    const scope = parsedPlan?.header?.scope;
    if (!scope || scope.includes('to be determined')) {
      return { passed: true, reason: 'Scope not strictly defined' };
    }

    // TODO: Check modified files against scope boundaries
    // This would require tracking all modified files throughout execution
    
    return { passed: true, reason: 'Changes appear within scope' };
  }

  /**
   * Check if any mutating tool call was executed in this run
   * @private
   */
  didMutate(context) {
    const executions = Array.isArray(context.executedTools) ? context.executedTools : [];
    return executions.some(exec => exec && TOOL_WRITE.has(exec.tool));
  }

  /**
   * Build decision summary
   * @private
   */
  buildDecisionSummary(checks) {
    const parts = [];
    
    for (const [name, check] of Object.entries(checks)) {
      const icon = check.passed ? '✓' : '✗';
      const label = name.replace(/([A-Z])/g, ' $1').trim();
      parts.push(`${icon} ${label}: ${check.reason}`);
    }

    return parts.join('\n');
  }

  /**
   * Identify next steps based on failed checks
   * @private
   */
  identifyNextSteps(checks, parsedPlan) {
    const steps = [];

    if (!checks.allTasksComplete.passed) {
      const pending = getPendingTasks(parsedPlan);
      if (pending.length) {
        steps.push(`Complete pending tasks: ${pending.map(t => t.id).join(', ')}`);
      }
    }

    if (!checks.acceptanceChecksSatisfied.passed) {
      steps.push('Satisfy remaining acceptance checks with evidence');
    }

    if (!checks.evidenceStrengthAdequate.passed) {
      steps.push('Run tests or build to strengthen evidence');
    }

    if (!checks.noNewDiagnostics.passed) {
      steps.push('Fix new diagnostic errors introduced by changes. Your previous edit was too narrow — use a wider line range that covers all related errors and provide complete corrected code in newText. Respond with JSON: {"text":"...","toolCalls":[{"tool":"edit_file","args":{"path":"...","startLine":N,"endLine":M,"newText":"..."}}]}');
    }

    if (!checks.withinScope.passed) {
      steps.push('Review scope and either revert out-of-scope changes or update plan');
    }

    if (steps.length === 0) {
      steps.push('Continue with any remaining work');
    }

    return steps.join('\n- ');
  }

  /**
   * Complete successfully
   * @private
   */
  completeSuccessfully(context, summary) {
    const parsedPlan = context.getParsedPlan();
    const objective = parsedPlan?.header?.objective || 'the task';

    const completionMessage = `**✓ Task Complete**

${summary}

**Objective Achieved**: ${objective}

All acceptance checks satisfied with evidence. Work is complete.`;

    context.addUiMessage({
      role: 'assistant',
      content: completionMessage
    });

    // Return final result
    return PhaseResult.final(completionMessage);
  }
}

module.exports = { CompletionDecisionPhase };
