/**
 * SelfCorrectionPrompts - Critique templates for post-edit self-correction
 * 
 * These prompts are injected after each code edit to encourage the agent
 * to think critically about potential issues before proceeding.
 */

/**
 * Get self-correction prompt after an edit action
 * @param {object} editInfo - Information about the edit that was made
 * @returns {string} Self-correction prompt
 */
function getSelfCorrectionPrompt(editInfo = {}) {
  const { files = [], action = 'edit' } = editInfo;
  
  const fileList = files.length > 0 
    ? `Affected files: ${files.join(', ')}`
    : 'Multiple files affected';

  return `
**Self-Correction Checkpoint**

You just performed a ${action}. ${fileList}

Before proceeding, critically evaluate your change:

1. **What could this break?**
   - Are there other code paths that depend on what you changed?
   - Did you consider edge cases or error handling?
   - Could this affect performance or memory usage?

2. **Did I respect invariants?**
   - Does this maintain backward compatibility?
   - Are public APIs and contracts unchanged (or explicitly versioned)?
   - Did you preserve existing error handling semantics?
   - Are there any assumptions in other parts of the code that might be violated?

3. **Did I change too much surface area?**
   - Is this a minimal, focused change?
   - Did you stay within the intended scope?
   - Could this change be broken into smaller patches?
   - Are there unrelated changes that snuck in?

4. **What should I validate next?**
   - What's the fastest way to prove this works?
   - Which test(s) would catch a regression here?
   - Do I need to check diagnostics or run a build?

**Action**: Respond with either:
- A brief acknowledgment if confident (e.g., "Change looks good, proceeding to validation")
- OR specific concerns you've identified that need addressing
- OR a decision to revert/modify based on identified risks
`;
}

/**
 * Get debug loop self-correction prompt after a failure
 * @param {object} failureInfo - Information about the failure
 * @returns {string} Debug self-correction prompt
 */
function getDebugSelfCorrectionPrompt(failureInfo = {}) {
  const { type = 'unknown', message = '', attemptCount = 1 } = failureInfo;
  
  return `
**Debug Loop Self-Correction** (Attempt ${attemptCount})

Failure type: ${type}
${message ? `Message: ${message}` : ''}

Before making another fix attempt, reflect:

1. **Is my hypothesis correct?**
   - Am I fixing the right thing?
   - Did I trace the error to its root cause, or just a symptom?
   - Have I seen this exact error pattern before?

2. **What evidence contradicts my current approach?**
   - What did the last fix attempt change?
   - Why didn't it work?
   - Is there information in the error output I'm ignoring?

3. **Am I stuck in a loop?**
   - Have I tried this same fix before?
   - Am I making progress, or going in circles?
   - Should I try a completely different approach?

4. **Do I need human input?**
   - Is there a design decision I need clarification on?
   - Am I missing context about how this system works?
   - Would a human expert see something I'm missing?

**Action**: Respond with:
- Your updated hypothesis and next targeted fix
- OR a decision to try a different approach
- OR a request for human input if stuck (will pause execution)
`;
}

/**
 * Get scope violation warning prompt
 * @param {object} violationInfo - Information about the scope violation
 * @returns {string} Scope warning prompt
 */
function getScopeViolationPrompt(violationInfo = {}) {
  const { files = [], expectedScope = '' } = violationInfo;
  
  return `
**⚠️ Scope Violation Warning**

You've made changes to files that may be outside the intended scope:
${files.map(f => `- ${f}`).join('\n')}

Expected scope: ${expectedScope || 'Not explicitly defined'}

**Before proceeding:**
1. Is this scope expansion justified and necessary?
2. Should the plan be updated to reflect the new scope?
3. Could this introduce unintended side effects?
4. Do you need to ask the human to approve this scope change?

**Action**: Respond with justification or revert the out-of-scope changes.
`;
}

/**
 * Get feature mapping guidance prompt
 * @returns {string} Feature mapping prompt
 */
function getFeatureMappingPrompt() {
  return `
**Feature Mapping Phase (Read-Only)**

Your task is to understand the codebase WITHOUT making any edits.

Focus on:

1. **Entry Points**: Where does the relevant functionality start?
   - UI event handlers, API endpoints, CLI commands
   - Service layer entry points
   - Configuration or initialization code

2. **Data Flow**: How does data move through the system?
   - What data structures are involved?
   - Where is state stored and modified?
   - What are the key transformations?

3. **Invariants**: What must NOT change?
   - Public API contracts
   - Data model shapes
   - Error handling semantics
   - Performance characteristics
   - Security boundaries

4. **Risk Areas**: What's fragile or complex?
   - Tightly coupled code
   - Shared mutable state
   - Complex algorithms or business logic
   - Error-prone edge cases

**Tools to use**: read_file, grep_search, list_code_usages
**Tools to avoid**: write_file, replace_in_file, run_command (except read-only queries)

Update the plan's Findings section with your discoveries.
`;
}

/**
 * Get task completion verification prompt
 * @param {object} taskInfo - Information about the completed task
 * @returns {string} Verification prompt
 */
function getTaskCompletionPrompt(taskInfo = {}) {
  const { taskId = '', doneWhen = '' } = taskInfo;
  
  return `
**Task Completion Verification: ${taskId}**

"Done when" criteria: ${doneWhen}

Before marking this task complete:

1. **Does it meet the "Done when" criteria?**
   - Have you verified each condition?
   - Is there objective evidence (test pass, build success, etc.)?

2. **What's the evidence?**
   - Link to specific obs-XXX entries in the Progress Log
   - Reference test results, build output, or diagnostic checks

3. **Are there loose ends?**
   - TODOs or comments you left behind?
   - Temporary workarounds that need follow-up?
   - Related tasks that should be added?

**Action**: If truly done, mark task complete and add evidence reference.
If not done, continue working on the task.
`;
}

module.exports = {
  getSelfCorrectionPrompt,
  getDebugSelfCorrectionPrompt,
  getScopeViolationPrompt,
  getFeatureMappingPrompt,
  getTaskCompletionPrompt
};
