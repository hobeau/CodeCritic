/**
 * BaselineCapturePhase (Phase B) - Capture initial test/build/diagnostic state
 * Runs only on first iteration after plan initialization
 * Enforces no-edits-before-baseline and records results in plan's Baseline Snapshot
 */

const { PhaseResult } = require('../PhaseResult');
const { getAcceptanceCheckRequirements } = require('../utils/MarkdownPlanManager');
const { filterProblemsByContext } = require('../utils/diagnosticsUtils');

class BaselineCapturePhase {
  /**
   * Execute baseline capture phase
   * - Skip if baseline already exists
   * - Enforce no edits before baseline
   * - Run test discovery and execution
   * - Run build discovery and execution (optional)
   * - Collect diagnostics
   * - Store in context.baseline AND update markdown plan
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue with baseline data
   */
  async execute(context) {
    // Skip if baseline already captured
    if (context.baseline) {
      return PhaseResult.continue();
    }

    context.setCurrentPhase('B');
    
    const parsedPlan = context.getParsedPlan();
    const requirements = getAcceptanceCheckRequirements(parsedPlan);

    // Collect baseline
    const baseline = {
      timestamp: Date.now(),
      tests: null,
      build: null,
      diagnostics: null
    };
    
    try {
      context.addUiMessage({
        role: 'assistant',
        content: '**Capturing Baseline State**...'
      });
      
      // Discover and run tests (only if required by plan)
      if (requirements.requiresTests && context.deps.discoverTestCommand && context.deps.runToolCall) {
        try {
          const testInfo = await context.deps.discoverTestCommand();
          if (testInfo) {
            baseline.tests = await this.runTests(testInfo, context);
          }
        } catch (err) {
          // Test discovery/execution failed - continue without test baseline
          baseline.tests = { error: 'Test discovery failed', passed: false };
        }
      }
      
      // Discover and run build (only if required by plan)
      if (requirements.requiresBuild && context.deps.discoverBuildCommand && context.deps.runToolCall) {
        try {
          const buildInfo = await context.deps.discoverBuildCommand();
          if (buildInfo) {
            baseline.build = await this.runBuild(buildInfo, context);
          }
        } catch (err) {
          // Build discovery/execution failed - continue without build baseline
          baseline.build = { error: 'Build discovery failed', success: false };
        }
      }
      
      // Collect diagnostics (only if required by plan)
      if (requirements.requiresDiagnostics && context.deps.collectWorkspaceProblems) {
        try {
          const problems = context.deps.collectWorkspaceProblems(50) || [];
          const filtered = filterProblemsByContext(problems, context);
          baseline.diagnostics = {
            clean: filtered.length === 0,
            count: filtered.length,
            problems: filtered.map(p => String(p).substring(0, 200))
          };
        } catch (err) {
          baseline.diagnostics = { error: 'Diagnostic collection failed', clean: false, count: 0 };
        }
      }
      
      // Store baseline
      context.setBaseline(baseline);
      
      // Update markdown plan's Baseline Snapshot section
      this.updatePlanBaseline(context, baseline, requirements);
      
      // Format baseline summary
      const summary = this.formatBaselineSummary(baseline);
      context.addUiMessage({
        role: 'assistant',
        content: `**Baseline Captured**:\n${summary}`
      });
      
      return PhaseResult.continue({ baseline });
    } catch (err) {
      // Complete failure - continue without baseline (fallback to simple completion)
      context.addUiMessage({
        role: 'assistant',
        content: '**Note**: Baseline capture failed - using simple completion detection'
      });
      return PhaseResult.continue();
    }
  }

  /**
   * Update markdown plan with baseline results
   * @private
   * @param {AgentContext} context - Execution context
   * @param {object} baseline - Baseline state
   */
  updatePlanBaseline(context, baseline, requirements) {
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan) return;

    if (!requirements.requiresBuild) {
      parsedPlan.baseline.build = 'Not required (per plan)';
    }
    if (!requirements.requiresTests) {
      parsedPlan.baseline.tests = 'Not required (per plan)';
    }
    if (!requirements.requiresDiagnostics) {
      parsedPlan.baseline.diagnostics = 'Not required (per plan)';
    }

    // Update baseline section
    if (baseline.build) {
      const buildStatus = baseline.build.error 
        ? baseline.build.error 
        : (baseline.build.success ? 'pass' : `fail (exit code ${baseline.build.exitCode || 1})`);
      parsedPlan.baseline.build = buildStatus;
    }

    if (baseline.tests) {
      const testStatus = baseline.tests.error
        ? baseline.tests.error
        : (baseline.tests.passed 
          ? `pass (${baseline.tests.passedCount || 0}/${baseline.tests.total || 0})`
          : `fail (${baseline.tests.failedCount || 0} failures)`);
      parsedPlan.baseline.tests = testStatus;
    }

    if (baseline.diagnostics) {
      const diagStatus = baseline.diagnostics.error
        ? baseline.diagnostics.error
        : `${baseline.diagnostics.count} problems${baseline.diagnostics.clean ? ' (clean)' : ''}`;
      parsedPlan.baseline.diagnostics = diagStatus;
    }

    // Update context with modified plan
    context.updateParsedPlan(parsedPlan);
  }

  /**
   * Run tests and parse results
   * @private
   * @param {object} testInfo - Test command info
   * @param {AgentContext} context - Execution context
   * @returns {Promise<object|null>}
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
   * @param {object} buildInfo - Build command info
   * @param {AgentContext} context - Execution context
   * @returns {Promise<object|null>}
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
   * Format baseline summary for UI
   * @private
   * @param {object} baseline - Baseline state
   * @returns {string}
   */
  formatBaselineSummary(baseline) {
    const parts = [];
    
    if (baseline.tests) {
      if (baseline.tests.error) {
        parts.push(`- ⚠️ Tests: ${baseline.tests.error}`);
      } else {
        const { passed, passedCount, failedCount, total } = baseline.tests;
        const status = passed ? '✓' : '✗';
        parts.push(`- ${status} Tests: ${passed ? 'passing' : 'failing'} (${passedCount || 0}/${total || 0})`);
      }
    }
    
    if (baseline.build) {
      if (baseline.build.error) {
        parts.push(`- ⚠️ Build: ${baseline.build.error}`);
      } else {
        const { success } = baseline.build;
        const status = success ? '✓' : '✗';
        parts.push(`- ${status} Build: ${success ? 'succeeding' : 'failing'}`);
      }
    }
    
    if (baseline.diagnostics) {
      if (baseline.diagnostics.error) {
        parts.push(`- ⚠️ Diagnostics: ${baseline.diagnostics.error}`);
      } else {
        const { count, clean } = baseline.diagnostics;
        const status = clean ? '✓' : '✗';
        parts.push(`- ${status} Diagnostics: ${count} problems`);
      }
    }
    
    return parts.length > 0 ? parts.join('\n') : '- ⚠️ No baseline data collected';
  }
}

module.exports = { BaselineCapturePhase };

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
