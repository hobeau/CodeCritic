/**
 * ValidationPhase (Phase E) - Run acceptance ladder and update Progress Log
 * 
 * Responsibilities:
 * - Run acceptance ladder: build → targeted tests → repro → diagnostics comparison
 * - Update Progress Log with evidence IDs
 * - Link evidence to specific acceptance checks and tasks
 * - Determine if work should continue or if validation passed
 */

const { PhaseResult } = require('../PhaseResult');
const { addProgressLogEntry, markTaskComplete, getAcceptanceCheckRequirements } = require('../utils/MarkdownPlanManager');
const { filterProblemsByContext } = require('../utils/diagnosticsUtils');

class ValidationPhase {
  /**
   * Execute validation phase
   * - Skip if no mutations occurred
   * - Skip if evidence already collected this iteration
   * - Run acceptance ladder (build, tests, diagnostics)
   * - Update Progress Log with evidence
   * - Provide validation feedback to LLM
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue with validation results
   */
  async execute(context) {
    const requirements = getAcceptanceCheckRequirements(context.getParsedPlan());
    const missingEvidence = this.getMissingRequiredEvidence(requirements, context.currentEvidence);
    const mutationsMade = context.data?.isMutation;
    const forceValidation = context.data?.forceValidation;
    const shouldValidate = Boolean(mutationsMade || forceValidation || missingEvidence.length > 0);
    if (!shouldValidate) {
      return PhaseResult.continue();
    }
    
    // Skip if evidence already collected and no missing requirements
    if (!context.evidenceStale && missingEvidence.length === 0 && !forceValidation) {
      return PhaseResult.continue();
    }

    context.setCurrentPhase('E');

    try {
      // Collect evidence via acceptance ladder
      const evidence = await this.runAcceptanceLadder(context);
      
      // Store evidence
      context.recordEvidence(evidence);
      
      // NEW: Record observation for continuous plan refinement
      const observationSummary = this._buildObservationSummary(evidence);
      const impactOnPlan = this._assessImpactOnPlan(context, evidence);
      context.recordObservation('validation', observationSummary, impactOnPlan);
      
      // Auto-update acceptance checks based on evidence
      this.updateAcceptanceChecksFromEvidence(context, evidence);

      // Update Progress Log with evidence
      this.updateProgressLog(context, evidence);
      
      // Format validation summary for UI and LLM
      const summary = this.formatValidationSummary(context, evidence);
      context.addUiMessage({
        role: 'assistant',
        content: `**Validation Results**:\n${summary}`
      });
      
      // Build enhanced guidance when diagnostics show new problems
      let guidance = 'Analyze these results and determine next steps.';
      const baseline = context.baseline || {};
      const baselineCount = baseline?.diagnostics?.count || 0;
      const currentCount = evidence?.diagnostics?.count || 0;
      if (currentCount > baselineCount && evidence?.diagnostics?.problems?.length) {
        const lineNumbers = evidence.diagnostics.problems
          .map(p => { const m = /:(\d+):\d+/.exec(p); return m ? Number(m[1]) : 0; })
          .filter(n => n > 0);
        const minLine = lineNumbers.length ? Math.max(1, Math.min(...lineNumbers) - 3) : 0;
        const maxLine = lineNumbers.length ? Math.max(...lineNumbers) + 5 : 0;
        const rangeHint = minLine && maxLine
          ? ` Edit a wider range (lines ${minLine}-${maxLine}) to fix all issues at once.`
          : '';
        guidance = `Your previous edit introduced new errors. The fix was too narrow — it changed only part of the broken region.${rangeHint} Read the affected lines first if needed, then use a single edit_file covering ALL error locations with the complete corrected code in newText.`;
      }

      // Add to model context
      context.addModelMessage({
        role: 'user',
        content: `**Validation Evidence**:\n${summary}\n\n${guidance}`
      });
      
      return PhaseResult.continue({ 
        evidence,
        validationComplete: true
      });
    } catch (err) {
      context.addUiMessage({
        role: 'assistant',
        content: `**Note**: Validation failed - ${err.message}`
      });
      return PhaseResult.continue();
    }
  }

  /**
   * Run acceptance ladder: build → tests → diagnostics
   * @private
   */
  async runAcceptanceLadder(context) {
    const evidence = {
      timestamp: Date.now(),
      tests: null,
      build: null,
      diagnostics: null
    };
    
    context.addUiMessage({
      role: 'assistant',
      content: '**Running Acceptance Ladder**...'
    });
    
    // Wait for VS Code diagnostics to update after file edits
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const requirements = getAcceptanceCheckRequirements(context.getParsedPlan());

    // Step 1: Run build if required by plan
    if (requirements.requiresBuild && context.deps.discoverBuildCommand && context.deps.runToolCall) {
      try {
        const buildInfo = await context.deps.discoverBuildCommand();
        if (buildInfo) {
          evidence.build = await this.runBuild(buildInfo, context);
        }
      } catch (err) {
        evidence.build = { error: 'Build execution failed', success: false };
      }
    }
    
    // Step 2: Run tests if required by plan (and build passed or no build)
    const shouldRunTests = requirements.requiresTests &&
                           (!evidence.build || evidence.build.success);
    
    if (shouldRunTests && context.deps.discoverTestCommand && context.deps.runToolCall) {
      try {
        const testInfo = await context.deps.discoverTestCommand();
        if (testInfo) {
          evidence.tests = await this.runTests(testInfo, context);
        }
      } catch (err) {
        evidence.tests = { error: 'Test execution failed', passed: false };
      }
    }
    
    // Step 3: Collect diagnostics if required by plan
    if (requirements.requiresDiagnostics && context.deps.collectWorkspaceProblems) {
      try {
        const problems = context.deps.collectWorkspaceProblems(50) || [];
        const filtered = filterProblemsByContext(problems, context);
        evidence.diagnostics = {
          clean: filtered.length === 0,
          count: filtered.length,
          problems: filtered.map(p => String(p).substring(0, 200))
        };
      } catch (err) {
        evidence.diagnostics = { 
          error: 'Diagnostic collection failed', 
          clean: false, 
          count: 0 
        };
      }
    }
    
    return evidence;
  }

  /**
   * Determine which required evidence is missing
   * @private
   */
  getMissingRequiredEvidence(requirements, evidence) {
    const missing = [];
    const current = evidence || {};
    if (requirements.requiresBuild && !current.build) missing.push('build');
    if (requirements.requiresTests && !current.tests) missing.push('tests');
    if (requirements.requiresDiagnostics && !current.diagnostics) missing.push('diagnostics');
    return missing;
  }

  /**
   * Run tests and parse results
   * @private
   */
  async runTests(testInfo, context) {
    try {
      const result = await context.deps.runToolCall({
        tool: 'run_command',
        args: {
          command: testInfo.command,
          cwd: context.deps.getWorkspaceRoot ? context.deps.getWorkspaceRoot() : process.cwd(),
          timeoutMs: 120000
        }
      });
      
      const parsed = parseCommandResult(result);
      const output = parsed.output || String(result || '').trim();
      const exitCode = parsed.exitCode;
      
      if (context.deps.parseTestOutput) {
        return context.deps.parseTestOutput(output, testInfo.runner, exitCode);
      }
      
      return {
        passed: exitCode === 0,
        exitCode,
        raw: output.substring(0, 500)
      };
    } catch (err) {
      return {
        passed: false,
        error: String(err.message || err).substring(0, 200)
      };
    }
  }

  /**
   * Run build and parse results
   * @private
   */
  async runBuild(buildInfo, context) {
    try {
      const result = await context.deps.runToolCall({
        tool: 'run_command',
        args: {
          command: buildInfo.command,
          cwd: context.deps.getWorkspaceRoot ? context.deps.getWorkspaceRoot() : process.cwd(),
          timeoutMs: 120000
        }
      });
      
      const parsed = parseCommandResult(result);
      const output = parsed.output || String(result || '').trim();
      const exitCode = parsed.exitCode;
      
      if (context.deps.parseBuildOutput) {
        return context.deps.parseBuildOutput(output, buildInfo.tool, exitCode);
      }
      
      return {
        success: exitCode === 0,
        exitCode,
        raw: output.substring(0, 500)
      };
    } catch (err) {
      return {
        success: false,
        error: String(err.message || err).substring(0, 200)
      };
    }
  }

  /**
   * Update Progress Log with evidence
   * @private
   */
  updateProgressLog(context, evidence) {
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan) return;
    
    // Add evidence entries to Progress Log
    if (evidence.build) {
      const buildStatus = evidence.build.error
        ? `Build failed: ${evidence.build.error}`
        : (evidence.build.success ? 'Build passed' : `Build failed (exit ${evidence.build.exitCode})`);
      
      const { plan: updatedPlan } = addProgressLogEntry(parsedPlan, buildStatus);
      context.updateParsedPlan(updatedPlan);
    }
    
    if (evidence.tests) {
      const testStatus = evidence.tests.error
        ? `Tests failed: ${evidence.tests.error}`
        : (evidence.tests.passed
          ? `Tests passed (${evidence.tests.passedCount || 0}/${evidence.tests.total || 0})`
          : `Tests failed (${evidence.tests.failedCount || 0} failures)`);
      
      const { plan: updatedPlan } = addProgressLogEntry(parsedPlan, testStatus);
      context.updateParsedPlan(updatedPlan);
    }
    
    if (evidence.diagnostics) {
      const diagStatus = evidence.diagnostics.error
        ? `Diagnostics check failed: ${evidence.diagnostics.error}`
        : `Diagnostics: ${evidence.diagnostics.count} problems${evidence.diagnostics.clean ? ' (clean)' : ''}`;
      
      const { plan: updatedPlan } = addProgressLogEntry(parsedPlan, diagStatus);
      context.updateParsedPlan(updatedPlan);
    }
  }

  /**
   * Auto-update acceptance checks based on evidence
   * @private
   */
  updateAcceptanceChecksFromEvidence(context, evidence) {
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan || !Array.isArray(parsedPlan.acceptanceChecks)) return;
    const baseline = context.baseline || {};
    let changed = false;

    for (const check of parsedPlan.acceptanceChecks) {
      if (check.checked) continue;
      const text = String(check.text || '').toLowerCase();
      if (!text) continue;

      if (text.includes('add any task-specific acceptance criteria')) {
        check.checked = true;
        changed = true;
        continue;
      }

      if (text.includes('build')) {
        if (evidence.build && (evidence.build.success || (!evidence.build.success && baseline.build?.success === false))) {
          check.checked = true;
          changed = true;
          continue;
        }
      }

      if (text.includes('test')) {
        if (evidence.tests && (evidence.tests.passed || (!evidence.tests.passed && baseline.tests?.passed === false))) {
          check.checked = true;
          changed = true;
          continue;
        }
      }

      if ((text.includes('diagnostic') || text.includes('ide') || text.includes('error') || text.includes('warning') || text.includes('compile')) && evidence.diagnostics) {
        const baselineCount = baseline.diagnostics?.count || 0;
        const currentCount = evidence.diagnostics.count || 0;
        if (evidence.diagnostics.clean || currentCount <= baselineCount) {
          check.checked = true;
          changed = true;
          continue;
        }
      }

      if (text.includes('compile')) {
        if ((evidence.build && evidence.build.success) || (evidence.diagnostics && evidence.diagnostics.clean)) {
          check.checked = true;
          changed = true;
          continue;
        }
      }

      if (text.includes('scope')) {
        check.checked = true;
        changed = true;
      }

      if (text.includes('regression') && (evidence.build || evidence.tests || evidence.diagnostics)) {
        const baselineCount = baseline.diagnostics?.count || 0;
        const currentCount = evidence.diagnostics?.count || 0;
        const buildRegressed = baseline.build?.success === true && evidence.build && !evidence.build.success;
        const testRegressed = baseline.tests?.passed === true && evidence.tests && !evidence.tests.passed;
        if (!buildRegressed && !testRegressed && currentCount <= baselineCount) {
          check.checked = true;
          changed = true;
        }
      }
    }

    if (changed) {
      context.updateParsedPlan(parsedPlan);
    }
  }

  /**
   * Format validation summary for UI
   * @private
   */
  formatValidationSummary(context, evidence) {
    const parts = [];
    const baseline = context.baseline || {};
    
    // Compare with baseline
    if (evidence.build) {
      const baselinePassed = baseline.build?.success;
      const currentPassed = evidence.build.success;
      
      if (evidence.build.error) {
        parts.push(`- ⚠️ Build: ${evidence.build.error}`);
      } else if (currentPassed) {
        parts.push(`- ✓ Build: succeeding${baselinePassed ? '' : ' (improved from baseline)'}`);
      } else {
        parts.push(`- ✗ Build: failing${baselinePassed ? ' (regressed from baseline)' : ''}`);
      }
    }
    
    if (evidence.tests) {
      const baselinePassed = baseline.tests?.passed;
      const currentPassed = evidence.tests.passed;
      
      if (evidence.tests.error) {
        parts.push(`- ⚠️ Tests: ${evidence.tests.error}`);
      } else if (currentPassed) {
        const count = `${evidence.tests.passedCount || 0}/${evidence.tests.total || 0}`;
        parts.push(`- ✓ Tests: passing (${count})${baselinePassed ? '' : ' (improved from baseline)'}`);
      } else {
        const failed = evidence.tests.failedCount || 0;
        parts.push(`- ✗ Tests: ${failed} failing${baselinePassed ? ' (regressed from baseline)' : ''}`);
      }
    }
    
    if (evidence.diagnostics) {
      const baselineCount = baseline.diagnostics?.count || 0;
      const currentCount = evidence.diagnostics.count;
      const newProblems = currentCount - baselineCount;
      
      if (evidence.diagnostics.error) {
        parts.push(`- ⚠️ Diagnostics: ${evidence.diagnostics.error}`);
      } else if (evidence.diagnostics.clean) {
        parts.push(`- ✓ Diagnostics: clean (0 problems)`);
      } else if (newProblems > 0) {
        parts.push(`- ✗ Diagnostics: ${currentCount} problems (+${newProblems} new vs baseline)`);
      } else if (newProblems < 0) {
        parts.push(`- ✓ Diagnostics: ${currentCount} problems (${Math.abs(newProblems)} fixed vs baseline)`);
      } else {
        parts.push(`- ○ Diagnostics: ${currentCount} problems (same as baseline)`);
      }

      if (!evidence.diagnostics.clean && evidence.diagnostics.problems?.length) {
        parts.push(`Diagnostics list:\n${evidence.diagnostics.problems.join('\n')}`);
      }
    }
    
    return parts.length > 0 ? parts.join('\n') : '- ⚠️ No validation data collected';
  }

  /**
   * Build compact observation summary from evidence
   * @param {object} evidence - Validation evidence
   * @returns {string} Compact observation summary
   * @private
   */
  _buildObservationSummary(evidence) {
    const parts = [];
    
    if (evidence.build) {
      const status = evidence.build.error ? 'error' : (evidence.build.success ? 'pass' : 'fail');
      parts.push(`build:${status}`);
    }
    
    if (evidence.tests) {
      if (evidence.tests.error) {
        parts.push(`tests:error`);
      } else {
        const passed = evidence.tests.passedCount || 0;
        const failed = evidence.tests.failedCount || 0;
        parts.push(`tests:${passed} pass, ${failed} fail`);
      }
    }
    
    if (evidence.diagnostics) {
      const count = evidence.diagnostics.count || 0;
      const status = evidence.diagnostics.clean ? 'clean' : `${count} issues`;
      parts.push(`diag:${status}`);
    }
    
    return parts.join(', ');
  }

  /**
   * Assess impact of validation evidence on the plan
   * @param {AgentContext} context - Execution context
   * @param {object} evidence - Validation evidence
   * @returns {string|null} Impact assessment or null if no significant impact
   * @private
   */
  _assessImpactOnPlan(context, evidence) {
    const baseline = context.baseline || {};
    const impacts = [];
    
    // Check for build regression
    if (baseline.build?.success && evidence.build && !evidence.build.success) {
      impacts.push('build regressed from pass to fail');
    }
    
    // Check for test regression
    if (evidence.tests && baseline.tests) {
      const currentFails = evidence.tests.failedCount || 0;
      const baselineFails = baseline.tests.failedCount || 0;
      const delta = currentFails - baselineFails;
      if (delta > 0) {
        impacts.push(`${delta} new test${delta > 1 ? 's' : ''} failing`);
      } else if (delta < 0) {
        impacts.push(`${Math.abs(delta)} test${Math.abs(delta) > 1 ? 's' : ''} fixed`);
      }
    }
    
    // Check for diagnostics regression/improvement
    if (evidence.diagnostics && baseline.diagnostics) {
      const currentCount = evidence.diagnostics.count || 0;
      const baselineCount = baseline.diagnostics.count || 0;
      const delta = currentCount - baselineCount;
      if (delta > 0) {
        impacts.push(`${delta} new diagnostic${delta > 1 ? 's' : ''} introduced — may need additional fix tasks`);
      } else if (delta < 0) {
        impacts.push(`${Math.abs(delta)} diagnostic${Math.abs(delta) > 1 ? 's' : ''} resolved`);
      }
    }
    
    return impacts.length > 0 ? impacts.join('; ') : null;
  }
}

module.exports = { ValidationPhase };

function parseCommandResult(result) {
  const raw = String(result || '').trim();
  if (!raw) {
    return { output: '', exitCode: 0, failed: false };
  }
  if (/command canceled by user/i.test(raw) || /run failed:/i.test(raw)) {
    return { output: raw, exitCode: 1, failed: true };
  }
  const successMatch = raw.match(/Command succeeded\s*\(exit\s*(\d+)\)\s*:?/i);
  const failMatch = raw.match(/Command failed(?:\s*\(exit\s*(\d+)\))?\s*:/i);
  const stdoutMatch = raw.match(/STDOUT:\n([\s\S]*?)(?:\nSTDERR:\n|$)/i);
  const stderrMatch = raw.match(/STDERR:\n([\s\S]*?)$/i);
  const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
  const stderr = stderrMatch ? stderrMatch[1].trim() : '';
  let output = '';
  if (stdout || stderr) {
    output = [stdout, stderr].filter(Boolean).join('\n').trim();
  } else if (successMatch || failMatch) {
    output = raw.replace(/^(Command (?:succeeded|failed)[^:]*:\s*)/i, '').trim();
  } else {
    output = raw;
  }
  let exitCode = 0;
  if (successMatch) exitCode = parseInt(successMatch[1], 10);
  if (failMatch && failMatch[1]) exitCode = parseInt(failMatch[1], 10);
  if (failMatch && exitCode === 0) exitCode = 1;
  const failed = !!failMatch || exitCode !== 0;
  return { output, exitCode, failed };
}
