/**
 * MarkdownPlanManager - Manages the markdown plan contract for ReAct agent loop
 * 
 * Plan Schema:
 * - Header: Objective, Context, Constraints, Scope boundaries, Out of scope
 * - Baseline Snapshot: Build/test/diagnostics/behavior before edits
 * - Acceptance Checks: Exit criteria with evidence requirements
 * - Task List: Patch-sized tasks with "Done when" criteria
 * - Findings: Living notes (entry points, data flow, invariants)
 * - Progress Log: Evidence ledger (obs-001, obs-002, etc.)
 */

/**
 * Parse markdown plan into structured format
 * @param {string} markdown - Raw markdown plan
 * @returns {object} Parsed plan with sections and tasks
 */
function parseMarkdownPlan(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return {
      header: {},
      baseline: {},
      acceptanceChecks: [],
      tasks: [],
      findings: {},
      progressLog: [],
      raw: ''
    };
  }

  const plan = {
    header: {},
    baseline: {},
    acceptanceChecks: [],
    tasks: [],
    findings: {},
    progressLog: [],
    raw: markdown
  };

  // Extract header sections (Objective, Context, Constraints, etc.)
  const objectiveMatch = markdown.match(/\*\*Objective\*\*:\s*(.+?)(?=\n|$)/);
  const contextMatch = markdown.match(/\*\*Context\*\*.*?:\s*(.+?)(?=\n|$)/);
  const constraintsMatch = markdown.match(/\*\*Constraints\*\*.*?:\s*(.+?)(?=\n|$)/);
  const scopeMatch = markdown.match(/\*\*Scope boundaries\*\*.*?:\s*(.+?)(?=\n|$)/);
  const outOfScopeMatch = markdown.match(/\*\*Out of scope\*\*.*?:\s*(.+?)(?=\n|$)/);

  plan.header = {
    objective: objectiveMatch ? objectiveMatch[1].trim() : '',
    context: contextMatch ? contextMatch[1].trim() : '',
    constraints: constraintsMatch ? constraintsMatch[1].trim() : '',
    scope: scopeMatch ? scopeMatch[1].trim() : '',
    outOfScope: outOfScopeMatch ? outOfScopeMatch[1].trim() : ''
  };

  // Extract baseline snapshot
  const baselineBuildMatch = markdown.match(/\*\*Baseline build\*\*:\s*(.+?)(?=\n|$)/);
  const baselineTestsMatch = markdown.match(/\*\*Baseline tests\*\*:\s*(.+?)(?=\n|$)/);
  const baselineDiagMatch = markdown.match(/\*\*Baseline IDE diagnostics\*\*:\s*(.+?)(?=\n|$)/);
  const baselineBehaviorMatch = markdown.match(/\*\*Baseline behavior\*\*:\s*(.+?)(?=\n|$)/);

  plan.baseline = {
    build: baselineBuildMatch ? baselineBuildMatch[1].trim() : '',
    tests: baselineTestsMatch ? baselineTestsMatch[1].trim() : '',
    diagnostics: baselineDiagMatch ? baselineDiagMatch[1].trim() : '',
    behavior: baselineBehaviorMatch ? baselineBehaviorMatch[1].trim() : ''
  };

  // Extract acceptance checks (checkboxes under "Acceptance Checks")
  const acceptanceSection = markdown.match(/###?\s*2\)\s*Acceptance Checks[\s\S]*?(?=###?\s*\d\)|$)/i);
  if (acceptanceSection) {
    const checkboxRegex = /- \[([ x])\]\s*(.+?)(?=\n|$)/gi;
    let match;
    while ((match = checkboxRegex.exec(acceptanceSection[0])) !== null) {
      plan.acceptanceChecks.push({
        checked: match[1].toLowerCase() === 'x',
        text: match[2].trim()
      });
    }
  }

  // Extract task list (checkboxes under "Task List")
  const taskSection = markdown.match(/###?\s*3\)\s*Task List[\s\S]*?(?=###?\s*\d\)|$)/i);
  if (taskSection) {
    // Line-oriented parsing to match the plan format we generate/build:
    // - [ ] **T1: Title** optional description
    //   *Done when:* ...
    const lines = taskSection[0].split(/\r?\n/);
    const isTaskLine = (line) => /^\s*-\s*\[[ xX]\]\s*\*\*/.test(String(line || ''));

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = line.match(/^\s*-\s*\[([ xX])\]\s*\*\*([^*]+)\*\*\s*(.*)$/);
      if (!match) continue;

      const checked = String(match[1] || '').toLowerCase() === 'x';
      const bold = String(match[2] || '').trim();
      const description = String(match[3] || '').trim();

      let id = '';
      let title = bold;
      const idMatch = bold.match(/^(T\d+)\s*:\s*(.+)$/i);
      if (idMatch) {
        id = String(idMatch[1] || '').toUpperCase();
        title = String(idMatch[2] || '').trim();
      } else {
        id = `T${plan.tasks.length + 1}`;
      }

      let doneWhen = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (isTaskLine(next)) break;
        const doneMatch = String(next || '').match(/^\s*(?:-\s*)?\*Done when:\*\s*(.+?)\s*$/i);
        if (doneMatch) {
          doneWhen = String(doneMatch[1] || '').trim();
          break;
        }
      }

      plan.tasks.push({
        id,
        checked,
        title,
        description,
        doneWhen
      });
    }
  }

  // Extract findings
  const findingsSection = markdown.match(/###?\s*4\)\s*Findings[\s\S]*?(?=###?\s*\d\)|$)/i);
  if (findingsSection) {
    const entryPointsMatch = findingsSection[0].match(/\*\*Entry points\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const dataFlowMatch = findingsSection[0].match(/\*\*Data flow[^:]*\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const invariantsMatch = findingsSection[0].match(/\*\*Invariants\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const assumptionsMatch = findingsSection[0].match(/\*\*Assumptions\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);
    const questionsMatch = findingsSection[0].match(/\*\*Open questions[^:]*\*\*:\s*(.+?)(?=\n\*\*|\n###|$)/s);

    plan.findings = {
      entryPoints: entryPointsMatch ? entryPointsMatch[1].trim() : '',
      dataFlow: dataFlowMatch ? dataFlowMatch[1].trim() : '',
      invariants: invariantsMatch ? invariantsMatch[1].trim() : '',
      assumptions: assumptionsMatch ? assumptionsMatch[1].trim() : '',
      openQuestions: questionsMatch ? questionsMatch[1].trim() : ''
    };
  }

  // Extract progress log (obs-001, obs-002, etc.)
  const progressSection = markdown.match(/###?\s*5\)\s*Progress Log[\s\S]*$/i);
  if (progressSection) {
    const lines = progressSection[0].split(/\r?\n/);
    for (const line of lines) {
      const match = String(line || '').match(/^\s*-\s*`(obs-\d+)`:\s*(.+?)\s*$/i);
      if (!match) continue;
      plan.progressLog.push({
        id: match[1],
        entry: String(match[2] || '').trim()
      });
    }
  }

  return plan;
}

/**
 * Build markdown plan from structured format
 * @param {object} plan - Structured plan object
 * @returns {string} Markdown string
 */
function buildMarkdownPlan(plan) {
  const sections = [];

  // Header
  sections.push('# ReAct Agent Execution Plan\n');
  sections.push('## 0) Header');
  if (plan.header.objective) sections.push(`- **Objective**: ${plan.header.objective}`);
  if (plan.header.context) sections.push(`- **Context**: ${plan.header.context}`);
  if (plan.header.constraints) sections.push(`- **Constraints**: ${plan.header.constraints}`);
  if (plan.header.scope) sections.push(`- **Scope boundaries**: ${plan.header.scope}`);
  if (plan.header.outOfScope) sections.push(`- **Out of scope**: ${plan.header.outOfScope}`);
  sections.push('');

  // Baseline
  sections.push('## 1) Baseline Snapshot (before edits)');
  if (plan.baseline.build) sections.push(`- **Baseline build**: ${plan.baseline.build}`);
  if (plan.baseline.tests) sections.push(`- **Baseline tests**: ${plan.baseline.tests}`);
  if (plan.baseline.diagnostics) sections.push(`- **Baseline IDE diagnostics**: ${plan.baseline.diagnostics}`);
  if (plan.baseline.behavior) sections.push(`- **Baseline behavior**: ${plan.baseline.behavior}`);
  sections.push('');

  // Acceptance Checks
  sections.push('## 2) Acceptance Checks (exit criteria)');
  sections.push('The agent may stop only when **all** are true:');
  for (const check of plan.acceptanceChecks || []) {
    const checkbox = check.checked ? '[x]' : '[ ]';
    sections.push(`- ${checkbox} ${check.text}`);
  }
  sections.push('');

  // Tasks
  sections.push('## 3) Task List (patch-sized)');
  sections.push('Each task must have "Done when …"');
  for (const task of plan.tasks || []) {
    const checkbox = task.checked ? '[x]' : '[ ]';
    sections.push(`- ${checkbox} **${task.id}: ${task.title}** ${task.description}`);
    sections.push(`  *Done when:* ${task.doneWhen}`);
  }
  sections.push('');

  // Findings
  sections.push('## 4) Findings (Living Notes)');
  if (plan.findings.entryPoints !== undefined) sections.push(`- **Entry points**: ${plan.findings.entryPoints}`);
  if (plan.findings.dataFlow !== undefined) sections.push(`- **Data flow / state**: ${plan.findings.dataFlow}`);
  if (plan.findings.invariants !== undefined) sections.push(`- **Invariants**: ${plan.findings.invariants}`);
  if (plan.findings.assumptions !== undefined) sections.push(`- **Assumptions**: ${plan.findings.assumptions}`);
  if (plan.findings.openQuestions !== undefined) sections.push(`- **Open questions / required human choice**: ${plan.findings.openQuestions}`);
  sections.push('');

  // Progress Log
  sections.push('## 5) Progress Log (evidence ledger)');
  sections.push('Every ✅ should reference evidence:');
  for (const log of plan.progressLog || []) {
    sections.push(`- \`${log.id}\`: ${log.entry}`);
  }

  return sections.join('\n');
}

/**
 * Get pending (unchecked) tasks from plan
 * Filters out tasks marked with [REMOVED] prefix (soft-deleted)
 * @param {object} plan - Parsed plan object
 * @returns {Array} Array of pending tasks
 */
function getPendingTasks(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return [];
  return plan.tasks.filter(task => 
    !task.checked && !task.title.startsWith('[REMOVED]')
  );
}

/**
 * Get completed (checked) tasks from plan
 * @param {object} plan - Parsed plan object
 * @returns {Array} Array of completed tasks
 */
function getCompletedTasks(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return [];
  return plan.tasks.filter(task => task.checked);
}

/**
 * Mark a task as complete (checked)
 * @param {object} plan - Parsed plan object
 * @param {string} taskId - Task ID (e.g., "T1")
 * @returns {object} Updated plan
 */
function markTaskComplete(plan, taskId) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  
  const task = plan.tasks.find(t => t.id === taskId);
  if (task) {
    task.checked = true;
  }
  
  return plan;
}

/**
 * Add evidence entry to progress log
 * @param {object} plan - Parsed plan object
 * @param {string} entry - Evidence description
 * @returns {object} Updated plan with new evidence ID
 */
function addProgressLogEntry(plan, entry) {
  if (!plan) return plan;
  if (!Array.isArray(plan.progressLog)) plan.progressLog = [];
  
  const nextId = plan.progressLog.length + 1;
  const evidenceId = `obs-${String(nextId).padStart(3, '0')}`;
  
  plan.progressLog.push({
    id: evidenceId,
    entry: entry
  });
  
  return { plan, evidenceId };
}

/**
 * Update findings section
 * @param {object} plan - Parsed plan object
 * @param {string} field - Field name (entryPoints, dataFlow, invariants, etc.)
 * @param {string} value - Value to set
 * @returns {object} Updated plan
 */
function updateFindings(plan, field, value) {
  if (!plan) return plan;
  if (!plan.findings) plan.findings = {};
  
  plan.findings[field] = value;
  
  return plan;
}

/**
 * Calculate task complexity score for skip logic
 * @param {object} plan - Parsed plan object
 * @returns {number} Complexity score (0-10, higher = more complex)
 */
function calculateComplexityScore(plan) {
  if (!plan) return 0;
  
  let score = 0;
  
  // More tasks = more complex
  const taskCount = plan.tasks?.length || 0;
  score += Math.min(taskCount, 5);
  
  // Multiple acceptance checks = more complex
  const checkCount = plan.acceptanceChecks?.length || 0;
  score += Math.min(checkCount - 2, 3); // Baseline is 2-3 checks
  
  // Explicit scope boundaries mentioned = more complex
  if (plan.header.scope && plan.header.scope.length > 50) {
    score += 2;
  }
  
  // Constraints mentioned = more complex
  if (plan.header.constraints && plan.header.constraints.length > 30) {
    score += 1;
  }
  
  return Math.min(score, 10);
}

/**
 * Check if all acceptance checks are satisfied
 * @param {object} plan - Parsed plan object
 * @returns {boolean} True if all checks are marked complete
 */
function areAllAcceptanceChecksSatisfied(plan) {
  if (!plan || !Array.isArray(plan.acceptanceChecks)) return false;
  if (plan.acceptanceChecks.length === 0) return false;
  
  return plan.acceptanceChecks.every(check => check.checked);
}

/**
 * Derive which validation gates are required based on acceptance checks
 * @param {object} plan - Parsed plan object
 * @returns {{requiresBuild: boolean, requiresTests: boolean, requiresDiagnostics: boolean, requiresRepro: boolean}}
 */
function getAcceptanceCheckRequirements(plan) {
  const checks = Array.isArray(plan?.acceptanceChecks) ? plan.acceptanceChecks : [];
  const texts = checks.map(c => String(c.text || '').toLowerCase());
  const includes = (token) => texts.some(t => t.includes(token));
  
  const requiresBuild = includes('build');
  const requiresTests = includes('test');
  const requiresDiagnostics = texts.some(t =>
    t.includes('diagnostic') ||
    t.includes('ide') ||
    t.includes('error') ||
    t.includes('warning') ||
    t.includes('lint') ||
    t.includes('problem') ||
    t.includes('compile')
  );
  const requiresRepro = texts.some(t =>
    t.includes('repro') ||
    t.includes('behavior') ||
    t.includes('expected behavior')
  );
  
  return { requiresBuild, requiresTests, requiresDiagnostics, requiresRepro };
}

/**
 * Check if all tasks are complete
 * @param {object} plan - Parsed plan object
 * @returns {boolean} True if all tasks are marked complete
 */
function areAllTasksComplete(plan) {
  if (!plan || !Array.isArray(plan.tasks)) return false;
  if (plan.tasks.length === 0) return false;
  
  return plan.tasks.every(task => task.checked);
}

/**
 * Create an empty plan template
 * @returns {object} Empty plan structure
 */
function createEmptyPlan() {
  return {
    header: {
      objective: '',
      context: '',
      constraints: '',
      scope: '',
      outOfScope: ''
    },
    baseline: {
      build: '',
      tests: '',
      diagnostics: '',
      behavior: ''
    },
    acceptanceChecks: [],
    tasks: [],
    findings: {
      entryPoints: '',
      dataFlow: '',
      invariants: '',
      assumptions: '',
      openQuestions: ''
    },
    progressLog: [],
    raw: ''
  };
}

// ===== NEW UTILITIES FOR CONTINUOUS PLAN REFINEMENT =====

/**
 * Add a new task to the plan
 * Task is appended to the end of the task list
 * @param {object} plan - Parsed plan object
 * @param {object} taskSpec - Task specification {title, description, doneWhen}
 * @returns {object} Updated plan
 */
function addTask(plan, taskSpec) {
  if (!plan) return plan;
  if (!Array.isArray(plan.tasks)) plan.tasks = [];
  
  const { title, description = '', doneWhen = '' } = taskSpec;
  if (!title || typeof title !== 'string') {
    throw new Error('Task title is required');
  }
  
  // Generate next task ID
  const existingIds = plan.tasks.map(t => {
    const match = t.id.match(/^T(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  });
  const nextNum = Math.max(0, ...existingIds) + 1;
  const taskId = `T${nextNum}`;
  
  plan.tasks.push({
    id: taskId,
    checked: false,
    title: String(title).trim(),
    description: String(description).trim(),
    doneWhen: String(doneWhen).trim()
  });
  
  return plan;
}

/**
 * Remove a task from the plan using soft-delete
 * Task title is prefixed with [REMOVED] and marked as checked
 * This preserves audit trail while filtering it from active tasks
 * @param {object} plan - Parsed plan object
 * @param {string} taskId - Task ID (e.g., "T1")
 * @returns {object} Updated plan
 */
function removeTask(plan, taskId) {
  if (!plan || !Array.isArray(plan.tasks)) return plan;
  
  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  
  // Soft-delete: prefix with [REMOVED] and mark checked
  if (!task.title.startsWith('[REMOVED]')) {
    task.title = `[REMOVED] ${task.title}`;
  }
  task.checked = true;
  
  return plan;
}

/**
 * Add a new acceptance check to the plan
 * Check is appended to the end of the acceptance checks list
 * @param {object} plan - Parsed plan object
 * @param {string} text - Acceptance check text
 * @returns {object} Updated plan
 */
function addAcceptanceCheck(plan, text) {
  if (!plan) return plan;
  if (!Array.isArray(plan.acceptanceChecks)) plan.acceptanceChecks = [];
  
  if (!text || typeof text !== 'string') {
    throw new Error('Acceptance check text is required');
  }
  
  plan.acceptanceChecks.push({
    checked: false,
    text: String(text).trim()
  });
  
  return plan;
}

/**
 * Remove an acceptance check from the plan using soft-delete
 * Check text is prefixed with [REMOVED] and marked as checked
 * @param {object} plan - Parsed plan object
 * @param {string} text - Acceptance check text (exact match)
 * @returns {object} Updated plan
 */
function removeAcceptanceCheck(plan, text) {
  if (!plan || !Array.isArray(plan.acceptanceChecks)) return plan;
  
  const check = plan.acceptanceChecks.find(c => c.text === text);
  if (!check) {
    throw new Error(`Acceptance check "${text}" not found`);
  }
  
  // Soft-delete: prefix with [REMOVED] and mark checked
  if (!check.text.startsWith('[REMOVED]')) {
    check.text = `[REMOVED] ${check.text}`;
  }
  check.checked = true;
  
  return plan;
}

/**
 * Revise an acceptance check's text
 * Finds check by original text and replaces with new text
 * @param {object} plan - Parsed plan object
 * @param {string} originalText - Original acceptance check text
 * @param {string} newText - New acceptance check text
 * @returns {object} Updated plan
 */
function reviseAcceptanceCheck(plan, originalText, newText) {
  if (!plan || !Array.isArray(plan.acceptanceChecks)) return plan;
  
  if (!newText || typeof newText !== 'string') {
    throw new Error('New acceptance check text is required');
  }
  
  const check = plan.acceptanceChecks.find(c => c.text === originalText);
  if (!check) {
    throw new Error(`Acceptance check "${originalText}" not found`);
  }
  
  check.text = String(newText).trim();
  // Reset checked state since criteria changed
  check.checked = false;
  
  return plan;
}

/**
 * Update the scope boundaries in the plan header
 * @param {object} plan - Parsed plan object
 * @param {string} newScope - New scope text
 * @returns {object} Updated plan
 */
function updateScope(plan, newScope) {
  if (!plan) return plan;
  if (!plan.header) plan.header = {};
  
  plan.header.scope = String(newScope || '').trim();
  
  return plan;
}

module.exports = {
  parseMarkdownPlan,
  buildMarkdownPlan,
  getPendingTasks,
  getCompletedTasks,
  markTaskComplete,
  addProgressLogEntry,
  updateFindings,
  calculateComplexityScore,
  areAllAcceptanceChecksSatisfied,
  areAllTasksComplete,
  getAcceptanceCheckRequirements,
  createEmptyPlan,
  // Continuous plan refinement utilities
  addTask,
  removeTask,
  addAcceptanceCheck,
  removeAcceptanceCheck,
  reviseAcceptanceCheck,
  updateScope
};
