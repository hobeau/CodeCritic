/**
 * ContractTypes - Completion contract schema and utilities
 */

/**
 * Task types for automatic contract generation
 */
const TaskType = {
  FIX_BUG: 'fix-bug',
  ADD_FEATURE: 'add-feature',
  REFACTOR: 'refactor',
  ADD_TESTS: 'add-tests',
  FIX_ERRORS: 'fix-errors',
  UNKNOWN: 'unknown'
};

/**
 * Acceptance check types
 */
const CheckType = {
  TESTS_PASS: 'tests-pass',
  BUILD_SUCCEEDS: 'build-succeeds',
  DIAGNOSTICS_CLEAN: 'diagnostics-clean',
  REPRO_WORKS: 'repro-works',
  NO_REGRESSIONS: 'no-regressions',
  SPECIFIC_BEHAVIOR: 'specific-behavior'
};

/**
 * Create a completion contract
 * @param {string} targetBehavior - What should happen after completion
 * @param {Array<object>} acceptanceChecks - Verifiable conditions [{type, description}]
 * @param {Array<string>} nonGoals - What must not change
 * @param {string} taskType - Type of task (from TaskType)
 * @returns {object} Completion contract
 */
function createContract(targetBehavior, acceptanceChecks = [], nonGoals = [], taskType = TaskType.UNKNOWN) {
  return {
    targetBehavior: String(targetBehavior || '').trim(),
    acceptanceChecks: Array.isArray(acceptanceChecks) ? acceptanceChecks : [],
    nonGoals: Array.isArray(nonGoals) ? nonGoals : [],
    taskType,
    createdAt: Date.now()
  };
}

/**
 * Validate completion contract structure
 * @param {object} contract - Contract to validate
 * @returns {boolean}
 */
function isValidContract(contract) {
  if (!contract || typeof contract !== 'object') return false;
  if (!contract.targetBehavior || typeof contract.targetBehavior !== 'string') return false;
  if (!Array.isArray(contract.acceptanceChecks)) return false;
  return true;
}

/**
 * Create default contract for bug fix tasks
 * @param {string} description - Bug description
 * @returns {object}
 */
function createBugFixContract(description) {
  return createContract(
    `Fix the bug: ${description}`,
    [
      { type: CheckType.TESTS_PASS, description: 'All tests pass' },
      { type: CheckType.DIAGNOSTICS_CLEAN, description: 'No new errors or warnings' },
      { type: CheckType.REPRO_WORKS, description: 'Bug reproduction no longer occurs' }
    ],
    ['Do not break existing functionality', 'Do not modify unrelated code'],
    TaskType.FIX_BUG
  );
}

/**
 * Create default contract for feature addition tasks
 * @param {string} description - Feature description
 * @returns {object}
 */
function createFeatureContract(description) {
  return createContract(
    `Add feature: ${description}`,
    [
      { type: CheckType.TESTS_PASS, description: 'All tests pass including new feature tests' },
      { type: CheckType.BUILD_SUCCEEDS, description: 'Project builds successfully' },
      { type: CheckType.DIAGNOSTICS_CLEAN, description: 'No new errors or warnings' }
    ],
    ['Do not break existing features', 'Maintain API compatibility'],
    TaskType.ADD_FEATURE
  );
}

/**
 * Create default contract for error fixing tasks
 * @param {number} errorCount - Number of errors to fix
 * @returns {object}
 */
function createErrorFixContract(errorCount = 0) {
  return createContract(
    'Fix all compilation/lint errors',
    [
      { type: CheckType.DIAGNOSTICS_CLEAN, description: `Reduce errors from ${errorCount} to 0` },
      { type: CheckType.BUILD_SUCCEEDS, description: 'Project builds without errors' },
      { type: CheckType.NO_REGRESSIONS, description: 'No new errors introduced' }
    ],
    ['Do not suppress errors without fixing root cause', 'Do not disable linting rules'],
    TaskType.FIX_ERRORS
  );
}

/**
 * Detect task type from user request
 * @param {string} request - User's request text
 * @returns {string} TaskType
 */
function detectTaskType(request) {
  const lower = String(request || '').toLowerCase();
  
  if (/(fix|bug|issue|error|problem|broken)/i.test(lower)) {
    return TaskType.FIX_BUG;
  }
  if (/(add|create|implement|build|feature|functionality)/i.test(lower)) {
    return TaskType.ADD_FEATURE;
  }
  if (/(refactor|clean|reorganize|restructure)/i.test(lower)) {
    return TaskType.REFACTOR;
  }
  if (/(test|spec|coverage)/i.test(lower)) {
    return TaskType.ADD_TESTS;
  }
  if (/(diagnostic|warning|lint)/i.test(lower)) {
    return TaskType.FIX_ERRORS;
  }
  
  return TaskType.UNKNOWN;
}

/**
 * Generate default contract based on request
 * @param {string} request - User request
 * @param {object} context - Optional context (error count, etc.)
 * @returns {object}
 */
function generateDefaultContract(request, context = {}) {
  const taskType = detectTaskType(request);
  
  switch (taskType) {
    case TaskType.FIX_BUG:
      return createBugFixContract(request);
    case TaskType.ADD_FEATURE:
      return createFeatureContract(request);
    case TaskType.FIX_ERRORS:
      return createErrorFixContract(context.errorCount);
    default:
      return createContract(
        request,
        [
          { type: CheckType.BUILD_SUCCEEDS, description: 'Project builds successfully' },
          { type: CheckType.NO_REGRESSIONS, description: 'No existing tests broken' }
        ],
        [],
        TaskType.UNKNOWN
      );
  }
}

module.exports = {
  TaskType,
  CheckType,
  createContract,
  isValidContract,
  createBugFixContract,
  createFeatureContract,
  createErrorFixContract,
  detectTaskType,
  generateDefaultContract
};
