/**
 * PlanReflectionPhase - Meta-cognitive reflection on the execution plan
 * 
 * After each act+observe cycle (action execution + validation), this phase asks:
 * "Given what you just observed, does the plan still make sense?"
 * 
 * Key responsibilities:
 * - Trigger reflection based on cadence (mutations, validation failures, every N steps)
 * - Build reflection prompt with plan summary, recent observations, evidence, findings
 * - Parse LLM response for plan modifications (addTasks, removeTasks, reviseAcceptanceChecks, scopeUpdate)
 * - Use MarkdownPlanManager utilities to update plan structure
 * - Set needsReExploration flag when critical context is missing
 * - Record reflection observations
 * 
 * Reflection frequency:
 * - After every mutation (file write)
 * - After validation failures (tests/build/diagnostics regression)
 * - Every N steps (configurable, default: 3)
 * 
 * Safety boundaries:
 * - Max reflections per outer loop: 10
 * - Require human confirmation for scope expansion
 * - Preserve soft-deleted tasks for audit trail
 */

const PhaseResult = require('../PhaseResult');
const {
  addTask,
  removeTask,
  addAcceptanceCheck,
  removeAcceptanceCheck,
  reviseAcceptanceCheck,
  updateScope
} = require('../utils/MarkdownPlanManager');

/**
 * PlanReflectionPhase - Continuous plan refinement through meta-cognitive reflection
 */
class PlanReflectionPhase {
  constructor() {
    this.name = 'PlanReflectionPhase';
    this.cadenceSteps = 3; // Reflect every N steps
    this.maxReflectionsPerLoop = 10; // Safety limit per outer loop
  }

  /**
   * Execute plan reflection phase
   * @param {AgentContext} context - Execution context
   * @returns {Promise<PhaseResult>} Result (continue or final)
   */
  async execute(context) {
    context.setStage('reflect');
    
    // Check if reflection should be triggered
    const shouldReflect = this._shouldTriggerReflection(context);
    if (!shouldReflect) {
      return PhaseResult.continue('Skipping reflection (cadence not met)');
    }
    
    // Safety limit: max reflections per outer loop
    if (context.planReflectionCount >= this.maxReflectionsPerLoop) {
      return PhaseResult.continue('Reflection limit reached for this outer loop');
    }
    
    // Build reflection prompt
    const prompt = this._buildReflectionPrompt(context);
    
    // Call LLM for reflection
    const { llm } = require('../../../helpers/llm');
    context.addModelMessage({ role: 'user', content: prompt });
    
    const response = await llm(context, {
      temperature: 0.2, // Lower temperature for analytical reflection
      jsonSchema: this._getReflectionSchema()
    });
    
    if (!response || !response.content) {
      return PhaseResult.continue('No reflection response received');
    }
    
    // Parse reflection response
    const reflection = this._parseReflection(response.content);
    
    // Track whether plan was modified
    let planChanged = false;
    const changes = [];
    
    // Apply plan modifications
    const plan = context.getParsedPlan();
    
    // Add new tasks
    if (reflection.addTasks && Array.isArray(reflection.addTasks)) {
      for (const taskSpec of reflection.addTasks) {
        addTask(plan, taskSpec);
        planChanged = true;
        changes.push(`Added task: ${taskSpec.title}`);
      }
    }
    
    // Remove tasks (soft-delete)
    if (reflection.removeTasks && Array.isArray(reflection.removeTasks)) {
      for (const taskId of reflection.removeTasks) {
        try {
          removeTask(plan, taskId);
          planChanged = true;
          changes.push(`Removed task: ${taskId}`);
        } catch (err) {
          // Task not found, log but continue
          changes.push(`Warning: Could not remove task ${taskId}: ${err.message}`);
        }
      }
    }
    
    // Revise acceptance checks
    if (reflection.reviseAcceptanceChecks && Array.isArray(reflection.reviseAcceptanceChecks)) {
      for (const revision of reflection.reviseAcceptanceChecks) {
        const { action, originalText, newText } = revision;
        
        try {
          if (action === 'add') {
            addAcceptanceCheck(plan, newText);
            planChanged = true;
            changes.push(`Added acceptance check: ${newText}`);
          } else if (action === 'remove') {
            removeAcceptanceCheck(plan, originalText);
            planChanged = true;
            changes.push(`Removed acceptance check: ${originalText}`);
          } else if (action === 'revise') {
            reviseAcceptanceCheck(plan, originalText, newText);
            planChanged = true;
            changes.push(`Revised acceptance check: ${originalText} → ${newText}`);
          }
        } catch (err) {
          changes.push(`Warning: Could not revise acceptance check: ${err.message}`);
        }
      }
    }
    
    // Update scope (requires human confirmation)
    if (reflection.scopeUpdate && reflection.scopeUpdate.newScope) {
      // TODO: Add human confirmation gate for scope expansion
      // For now, just log the request
      changes.push(`Scope update requested: ${reflection.scopeUpdate.newScope}`);
      changes.push('Note: Scope updates require human confirmation (not yet implemented)');
    }
    
    // Handle re-exploration request
    if (reflection.needsReExploration) {
      context.needsReExploration = true;
      context.reExplorationReason = reflection.reExplorationReason || 'Critical context missing for plan completion';
      changes.push(`Re-exploration requested: ${context.reExplorationReason}`);
    }
    
    // Update plan if changed
    if (planChanged) {
      context.updateParsedPlan(plan);
      context.planChanged = true;
    }
    
    // Increment reflection counter
    context.incrementPlanReflectionCount();
    context.planReflected = true;
    
    // Record reflection observation
    const impactSummary = changes.length > 0 ? changes.join('; ') : 'No plan changes';
    context.recordObservation('reflection', reflection.reasoning || 'Plan reflection completed', impactSummary);
    
    // Return result
    if (reflection.needsReExploration) {
      return PhaseResult.continue(`Re-exploration needed: ${context.reExplorationReason}`);
    }
    
    if (planChanged) {
      return PhaseResult.continue(`Plan updated: ${changes.length} changes applied`);
    }
    
    return PhaseResult.continue('Plan reflection complete, no changes needed');
  }

  /**
   * Determine if reflection should be triggered based on cadence
   * @param {AgentContext} context - Execution context
   * @returns {boolean} True if reflection should be triggered
   * @private
   */
  _shouldTriggerReflection(context) {
    // Always reflect after mutations (file writes)
    if (context.lastActionWasMutation) {
      return true;
    }
    
    // Always reflect after validation failures
    if (this._hasValidationFailures(context)) {
      return true;
    }
    
    // Reflect every N steps
    if (context.actionSeq % this.cadenceSteps === 0) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if recent validation had failures
   * @param {AgentContext} context - Execution context
   * @returns {boolean} True if validation failures detected
   * @private
   */
  _hasValidationFailures(context) {
    const currentEvidence = context.currentEvidence || {};
    const baseline = context.baseline || {};
    
    // Check if build regressed
    if (baseline.build?.success && currentEvidence.build && !currentEvidence.build.success) {
      return true;
    }
    
    // Check if tests regressed
    if (currentEvidence.tests && baseline.tests) {
      const currentFails = currentEvidence.tests.failedCount || 0;
      const baselineFails = baseline.tests.failedCount || 0;
      if (currentFails > baselineFails) {
        return true;
      }
    }
    
    // Check if diagnostics regressed
    if (currentEvidence.diagnostics && baseline.diagnostics) {
      const currentCount = currentEvidence.diagnostics.count || 0;
      const baselineCount = baseline.diagnostics.count || 0;
      if (currentCount > baselineCount) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Build reflection prompt with plan summary, observations, evidence
   * @param {AgentContext} context - Execution context
   * @returns {string} Reflection prompt
   * @private
   */
  _buildReflectionPrompt(context) {
    const plan = context.getParsedPlan();
    const recentObs = context.getRecentObservations(5);
    const currentEvidence = context.currentEvidence || {};
    const baseline = context.baseline || {};
    
    const sections = [];
    
    sections.push('# Plan Reflection');
    sections.push('');
    sections.push('You are reflecting on the current execution plan. Given what you have observed so far, answer:');
    sections.push('**Does the plan still make sense, or should it be updated?**');
    sections.push('');
    
    // Current plan summary
    sections.push('## Current Plan');
    sections.push(`**Objective**: ${plan.header.objective}`);
    sections.push(`**Scope**: ${plan.header.scope}`);
    sections.push('');
    sections.push('**Acceptance Checks**:');
    for (const check of plan.acceptanceChecks || []) {
      const status = check.checked ? '✅' : '⬜';
      sections.push(`- ${status} ${check.text}`);
    }
    sections.push('');
    sections.push('**Tasks**:');
    for (const task of plan.tasks || []) {
      const status = task.checked ? '✅' : '⬜';
      sections.push(`- ${status} **${task.id}**: ${task.title}`);
    }
    sections.push('');
    
    // Recent observations
    if (recentObs.length > 0) {
      sections.push('## Recent Observations');
      for (const obs of recentObs) {
        sections.push(`- **Step ${obs.step}** (${obs.type}): ${obs.summary}`);
        if (obs.impactOnPlan) {
          sections.push(`  Impact: ${obs.impactOnPlan}`);
        }
      }
      sections.push('');
    }
    
    // Evidence summary
    sections.push('## Evidence Status');
    const buildBaseline = baseline.build?.success ? 'pass' : (baseline.build ? 'fail' : 'unknown');
    const buildCurrent = currentEvidence.build?.success ? 'pass' : (currentEvidence.build ? 'fail' : 'unknown');
    sections.push(`**Build**: Baseline=${buildBaseline}, Current=${buildCurrent}`);
    
    if (currentEvidence.tests && baseline.tests) {
      const currentFails = currentEvidence.tests.failedCount || 0;
      const baselineFails = baseline.tests.failedCount || 0;
      sections.push(`**Tests**: Baseline=${baselineFails} failed, Current=${currentFails} failed`);
    }
    
    if (currentEvidence.diagnostics && baseline.diagnostics) {
      const currentCount = currentEvidence.diagnostics.count || 0;
      const baselineCount = baseline.diagnostics.count || 0;
      sections.push(`**Diagnostics**: Baseline=${baselineCount} issues, Current=${currentCount} issues`);
    }
    sections.push('');
    
    // Findings
    if (plan.findings && Object.values(plan.findings).some(v => v)) {
      sections.push('## Key Findings');
      if (plan.findings.entryPoints) sections.push(`**Entry points**: ${plan.findings.entryPoints}`);
      if (plan.findings.invariants) sections.push(`**Invariants**: ${plan.findings.invariants}`);
      if (plan.findings.openQuestions) sections.push(`**Open questions**: ${plan.findings.openQuestions}`);
      sections.push('');
    }
    
    // Reflection questions
    sections.push('## Reflection Questions');
    sections.push('Based on the observations and evidence:');
    sections.push('1. Are all tasks still necessary, or should some be removed?');
    sections.push('2. Do we need additional tasks to address new findings?');
    sections.push('3. Are the acceptance criteria still appropriate, or should they be revised?');
    sections.push('4. Do we have enough context to complete the plan, or do we need to re-explore?');
    sections.push('');
    sections.push('Respond with your reflection as a JSON object matching the schema provided.');
    
    return sections.join('\n');
  }

  /**
   * Get JSON schema for reflection response
   * @returns {object} JSON schema
   * @private
   */
  _getReflectionSchema() {
    return {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Brief explanation of your reflection (1-2 sentences)'
        },
        addTasks: {
          type: 'array',
          description: 'New tasks to add to the plan',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              doneWhen: { type: 'string' }
            },
            required: ['title', 'doneWhen']
          }
        },
        removeTasks: {
          type: 'array',
          description: 'Task IDs to remove (e.g., ["T1", "T3"])',
          items: { type: 'string' }
        },
        reviseAcceptanceChecks: {
          type: 'array',
          description: 'Acceptance check revisions',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['add', 'remove', 'revise']
              },
              originalText: { type: 'string' },
              newText: { type: 'string' }
            },
            required: ['action']
          }
        },
        scopeUpdate: {
          type: 'object',
          description: 'Scope boundary update (requires human confirmation)',
          properties: {
            newScope: { type: 'string' },
            reason: { type: 'string' }
          }
        },
        needsReExploration: {
          type: 'boolean',
          description: 'True if critical context is missing and re-exploration is needed'
        },
        reExplorationReason: {
          type: 'string',
          description: 'Explanation of what context is missing'
        }
      },
      required: ['reasoning']
    };
  }

  /**
   * Parse LLM reflection response
   * @param {string} content - LLM response content
   * @returns {object} Parsed reflection
   * @private
   */
  _parseReflection(content) {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(content);
      return parsed;
    } catch (err) {
      // Fallback: extract JSON from markdown code block
      const match = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch (innerErr) {
          // Could not parse JSON
        }
      }
      
      // Return minimal reflection
      return {
        reasoning: 'Could not parse reflection response',
        addTasks: [],
        removeTasks: [],
        reviseAcceptanceChecks: [],
        needsReExploration: false
      };
    }
  }
}

module.exports = PlanReflectionPhase;
