/**
 * testUtils - Test discovery, execution, and result parsing utilities
 */

const path = require('path');

/**
 * Test runner types
 */
const TestRunner = {
  JEST: 'jest',
  MOCHA: 'mocha',
  VITEST: 'vitest',
  PYTEST: 'pytest',
  AVA: 'ava',
  TAPE: 'tape',
  UNKNOWN: 'unknown'
};

/**
 * Detect test runner from package.json
 * @param {object} packageJson - Parsed package.json
 * @returns {string} TestRunner type
 */
function detectTestRunner(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') {
    return TestRunner.UNKNOWN;
  }
  
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  
  if (deps.jest || deps['@types/jest']) return TestRunner.JEST;
  if (deps.mocha || deps['@types/mocha']) return TestRunner.MOCHA;
  if (deps.vitest) return TestRunner.VITEST;
  if (deps.pytest) return TestRunner.PYTEST;
  if (deps.ava) return TestRunner.AVA;
  if (deps.tape) return TestRunner.TAPE;
  
  return TestRunner.UNKNOWN;
}

/**
 * Discover test command from package.json or workspace
 * @param {string} workspaceRoot - Workspace root path
 * @param {Function} readFile - File reader function
 * @returns {Promise<object|null>} { command, runner, targetFiles } or null
 */
async function discoverTestCommand(workspaceRoot, readFile) {
  try {
    // Read package.json
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath));
    
    // Check for test script
    const scripts = packageJson.scripts || {};
    if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
      const runner = detectTestRunner(packageJson);
      return {
        command: 'npm test',
        runner,
        targetFiles: []
      };
    }
    
    // Check for specific test commands
    if (scripts['test:unit']) {
      return {
        command: 'npm run test:unit',
        runner: detectTestRunner(packageJson),
        targetFiles: []
      };
    }
    
    // Fallback: try common test commands directly
    const runner = detectTestRunner(packageJson);
    if (runner !== TestRunner.UNKNOWN) {
      return {
        command: runner,
        runner,
        targetFiles: []
      };
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse Jest test output
 * @param {string} output - Test output
 * @param {number} exitCode - Process exit code
 * @returns {object} Test result
 */
function parseJestOutput(output, exitCode) {
  const summary = {
    runner: TestRunner.JEST,
    passed: exitCode === 0,
    total: 0,
    passedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    summary: '',
    failures: [],
    exitCode
  };
  
  // Parse test counts: "Tests: 1 failed, 10 passed, 11 total"
  const countsMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(\d+)\s+total/i);
  if (countsMatch) {
    summary.failedCount = parseInt(countsMatch[1] || '0', 10);
    summary.passedCount = parseInt(countsMatch[2] || '0', 10);
    summary.skippedCount = parseInt(countsMatch[3] || '0', 10);
    summary.total = parseInt(countsMatch[4] || '0', 10);
  }
  
  // Extract failure messages
  const failureMatches = output.matchAll(/● (.*?)\n\s*\n([\s\S]*?)(?=\n\s*●|\n\s*\n\s*(?:Test Suites:|Tests:)|\n$)/g);
  for (const match of failureMatches) {
    summary.failures.push({
      test: match[1].trim(),
      message: match[2].trim().substring(0, 500)
    });
  }
  
  summary.summary = summary.passed
    ? `All ${summary.passedCount} tests passed`
    : `${summary.failedCount} of ${summary.total} tests failed`;
  
  return summary;
}

/**
 * Parse Mocha test output
 * @param {string} output - Test output
 * @param {number} exitCode - Process exit code
 * @returns {object} Test result
 */
function parseMochaOutput(output, exitCode) {
  const summary = {
    runner: TestRunner.MOCHA,
    passed: exitCode === 0,
    total: 0,
    passedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    summary: '',
    failures: [],
    exitCode
  };
  
  // Parse summary: "10 passing\n1 failing"
  const passingMatch = output.match(/(\d+)\s+passing/i);
  const failingMatch = output.match(/(\d+)\s+failing/i);
  const pendingMatch = output.match(/(\d+)\s+pending/i);
  
  if (passingMatch) summary.passedCount = parseInt(passingMatch[1], 10);
  if (failingMatch) summary.failedCount = parseInt(failingMatch[1], 10);
  if (pendingMatch) summary.skippedCount = parseInt(pendingMatch[1], 10);
  
  summary.total = summary.passedCount + summary.failedCount + summary.skippedCount;
  
  // Extract failure messages
  const failureMatches = output.matchAll(/\d+\) (.*?)\n([\s\S]*?)(?=\n\n\d+\)|\n\n\s*\d+\s+passing|\n$)/g);
  for (const match of failureMatches) {
    summary.failures.push({
      test: match[1].trim(),
      message: match[2].trim().substring(0, 500)
    });
  }
  
  summary.summary = summary.passed
    ? `All ${summary.passedCount} tests passed`
    : `${summary.failedCount} of ${summary.total} tests failed`;
  
  return summary;
}

/**
 * Parse generic test output (best effort)
 * @param {string} output - Test output
 * @param {number} exitCode - Process exit code
 * @returns {object} Test result
 */
function parseGenericOutput(output, exitCode) {
  return {
    runner: TestRunner.UNKNOWN,
    passed: exitCode === 0,
    total: 0,
    passedCount: 0,
    failedCount: exitCode === 0 ? 0 : 1,
    skippedCount: 0,
    summary: exitCode === 0 ? 'Tests passed' : 'Tests failed',
    failures: [],
    exitCode,
    rawOutput: output.substring(0, 1000)
  };
}

/**
 * Parse test output based on runner
 * @param {string} output - Test command output
 * @param {string} runner - Test runner type
 * @param {number} exitCode - Process exit code
 * @returns {object} Parsed test result
 */
function parseTestOutput(output, runner = TestRunner.UNKNOWN, exitCode = 0) {
  const outputStr = String(output || '');
  
  switch (runner) {
    case TestRunner.JEST:
      return parseJestOutput(outputStr, exitCode);
    case TestRunner.MOCHA:
      return parseMochaOutput(outputStr, exitCode);
    case TestRunner.VITEST:
      // Vitest output is similar to Jest, but keep the runner label stable.
      return { ...parseJestOutput(outputStr, exitCode), runner: TestRunner.VITEST };
    default:
      return parseGenericOutput(outputStr, exitCode);
  }
}

/**
 * Build targeted test command for specific files
 * @param {string} baseCommand - Base test command (npm test)
 * @param {Array<string>} testFiles - Test file paths
 * @param {string} runner - Test runner type
 * @returns {string} Targeted test command
 */
function buildTestCommand(baseCommand, testFiles = [], runner = TestRunner.UNKNOWN) {
  if (!testFiles || !testFiles.length) {
    return baseCommand;
  }
  
  // For npm scripts, we can't easily pass file arguments
  // So return base command for now
  if (baseCommand.startsWith('npm ')) {
    return baseCommand;
  }
  
  // For direct runner commands, append file paths
  return `${baseCommand} ${testFiles.join(' ')}`;
}

/**
 * Format test result for UI display
 * @param {object} testResult - Parsed test result
 * @returns {string} Formatted message
 */
function formatTestResultForUi(testResult) {
  if (!testResult) return 'No test results available';
  
  const { passed, passedCount, failedCount, total, summary, failures } = testResult;
  
  let message = `**Test Results**: ${summary}\n`;
  if (total > 0) {
    message += `- Passed: ${passedCount}/${total}\n`;
    if (failedCount > 0) {
      message += `- Failed: ${failedCount}\n`;
      if (failures && failures.length > 0) {
        message += '\n**Failures**:\n';
        failures.slice(0, 3).forEach(f => {
          message += `- ${f.test}\n`;
        });
        if (failures.length > 3) {
          message += `- ... and ${failures.length - 3} more\n`;
        }
      }
    }
  }
  
  return message;
}

module.exports = {
  TestRunner,
  detectTestRunner,
  discoverTestCommand,
  parseTestOutput,
  buildTestCommand,
  formatTestResultForUi,
  parseJestOutput,
  parseMochaOutput
};
