/**
 * PlanInitializationPhase (Phase A) - Generate markdown plan contract
 * 
 * Responsibilities:
 * - Prompt LLM to generate full plan template (Objective, Constraints, Scope, etc.)
 * - Store plan in context (virtual memory, thread-scoped)
 * - Display plan to user once via streamMarkdown()
 * - Calculate complexity score for Phase C skip decision
 */

const { PhaseResult } = require('../PhaseResult');
const { 
  parseMarkdownPlan, 
  buildMarkdownPlan, 
  calculateComplexityScore,
  createEmptyPlan
} = require('../utils/MarkdownPlanManager');

class PlanInitializationPhase {
  /**
   * Execute plan initialization phase
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context) {
    // Skip if plan already exists
    if (context.markdownPlan && context.planDisplayed) {
      return PhaseResult.continue();
    }

    context.setCurrentPhase('A');
    if (typeof context.setStage === 'function') {
      context.setStage('plan');
    }

    // Extract user request from base messages
    const userRequest = (typeof context.userRequest === 'string' && context.userRequest.trim())
      ? context.userRequest
      : this._extractUserRequest(context);
    const requestedFromPrompt = this._extractRequestedFilePaths(userRequest);
    const requestedFromMessages = this._extractRequestedFilePathsFromMessages(context);
    const requestedFromContext = Array.isArray(context.requestedFilePaths) ? context.requestedFilePaths : [];
    context.requestedFilePaths = Array.from(new Set([
      ...requestedFromContext,
      ...requestedFromPrompt,
      ...requestedFromMessages
    ]));

    // Build prompt for plan generation
    const planPrompt = this._buildPlanGenerationPrompt(context, userRequest);

    // Call LLM to generate plan
    const planMarkdown = await this._generatePlan(context, planPrompt);

    // Store plan in context
    context.setMarkdownPlan(planMarkdown);

    // Ensure at least one acceptance check exists
    const parsedPlan = context.getParsedPlan();
    if (!parsedPlan.acceptanceChecks || parsedPlan.acceptanceChecks.length === 0) {
      parsedPlan.acceptanceChecks = [
        { checked: false, text: 'Requested behavior implemented and verified' }
      ];
      context.updateParsedPlan(parsedPlan);
    }

    // Display plan to user (once)
    await this._displayPlan(context, planMarkdown);
    context.markPlanDisplayed();

    // Calculate complexity score for Phase C skip decision
    const parsedPlanForScore = context.getParsedPlan();
    const complexityScore = calculateComplexityScore(parsedPlanForScore);
    
    // Store complexity score in context for later use
    context.planComplexityScore = complexityScore;

    return PhaseResult.continue();
  }

  /**
   * Extract user request from base messages
   * @private
   */
  _extractUserRequest(context) {
    const chatState = context.getChatState() || {};
    const messages = (Array.isArray(chatState.baseMessages) && chatState.baseMessages.length)
      ? chatState.baseMessages
      : (Array.isArray(chatState.messages) && chatState.messages.length)
        ? chatState.messages
        : (Array.isArray(context.uiMessages) && context.uiMessages.length)
          ? context.uiMessages
          : (Array.isArray(context.modelMessages) ? context.modelMessages : []);
    
    // Find the last user message
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      return 'No specific request provided';
    }

    const lastUserMsg = userMessages[userMessages.length - 1];
    return lastUserMsg.content || 'No specific request provided';
  }

  /**
   * Build prompt for LLM to generate plan
   * @private
   */
  _buildPlanGenerationPrompt(context, userRequest) {
    const exploration = context && context.explorationSummary && typeof context.explorationSummary === 'object'
      ? context.explorationSummary
      : null;
    const explorationTruncated = Boolean(context && context.explorationTruncated);
    const requestedFiles = Array.isArray(context && context.requestedFilePaths) ? context.requestedFilePaths : [];
    const keyFiles = exploration && Array.isArray(exploration.keyFiles) ? exploration.keyFiles.filter(Boolean) : [];

    const explorationBlock = exploration
      ? [
          '**Exploration Summary (grounding):**',
          explorationTruncated ? '- Note: exploration was truncated due to step limit.' : '',
          requestedFiles.length ? `- Requested file hints: ${requestedFiles.join(', ')}` : '',
          keyFiles.length ? `- Key files: ${keyFiles.join(', ')}` : '',
          exploration.entryPoints ? `- Entry points: ${exploration.entryPoints}` : '',
          exploration.dataFlow ? `- Data flow: ${exploration.dataFlow}` : '',
          exploration.invariants ? `- Invariants: ${exploration.invariants}` : '',
          exploration.assumptions ? `- Assumptions: ${exploration.assumptions}` : '',
          exploration.openQuestions ? `- Open questions: ${exploration.openQuestions}` : ''
        ].filter(Boolean).join('\n')
      : (requestedFiles.length ? `**Requested file hints:** ${requestedFiles.join(', ')}` : '');

    return `You are an expert software engineering agent using the ReAct methodology.

Your task is to generate a **comprehensive execution plan** for the following request:

---
**User Request:**
${userRequest}
---

${explorationBlock ? `${explorationBlock}\n` : ''}

Generate a markdown plan following this **exact structure** (headings must match), but **make the content dynamic** based on the request.

Dynamic planning rules:
- Only include acceptance checks that are actually required by the user request.
  - If the user asks to "fix errors" or "fix issues", prioritize IDE diagnostics/compilation errors and omit build/tests unless explicitly requested.
  - If the user asks to implement a feature, include checks for the requested behavior and any scope-specific tests you plan to run.
  - If the user explicitly asks to "ensure the app builds" or "run tests", include build/tests checks.
- Include a diagnostics check by default unless the user explicitly says to skip diagnostics.
- Keep acceptance checks short and verifiable. Include at least one check.
- Scope boundaries should reflect the files/features mentioned in the request (not generic).
- Baseline snapshot items that are not required should be set to "Not required (per plan)" instead of "Not yet captured".
- For simple syntax/typo fixes (missing braces, semicolons, typos), create at most 2 tasks: one to apply the fix and one to verify. Do NOT create separate tasks for diagnosis, analysis, or review — the fix is already known from exploration.

# ReAct Agent Execution Plan

## 0) Header
- **Objective**: [Clear, measurable goal]
- **Context**: [Brief background if needed]
- **Constraints**: [No new dependencies, backward compatibility, style rules, etc.]
- **Scope boundaries**: [Allowed folders/files]
- **Out of scope**: [What to avoid touching]

## 1) Baseline Snapshot (before edits)
- **Baseline build**: [Not yet captured - will run before edits OR Not required (per plan)]
- **Baseline tests**: [Not yet captured - will run before edits OR Not required (per plan)]
- **Baseline IDE diagnostics**: [Not yet captured - will capture before edits OR Not required (per plan)]
- **Baseline behavior**: [Expected current behavior to validate]

## 2) Acceptance Checks (exit criteria)
The agent may stop only when **all** are true:
- [ ] [Only the checks required for this request; omit build/tests if not requested]
- [ ] Diff stays within scope

## 3) Task List (patch-sized)
Each task must have "Done when …"
- [ ] **T1: [Task name]** [Brief description]
  *Done when:* [Specific, verifiable completion criteria]
- [ ] **T2: [Task name]** [Brief description]
  *Done when:* [Specific, verifiable completion criteria]
[Add more tasks as needed - keep them small and sequential]

## 4) Findings (Living Notes)
- **Entry points**: [To be filled during feature mapping]
- **Data flow / state**: [To be filled during feature mapping]
- **Invariants**: [To be filled during feature mapping]
- **Assumptions**: [To be filled during feature mapping]
- **Open questions / required human choice**: [To be filled as needed]

## 5) Progress Log (evidence ledger)
Every ✅ should reference evidence:
[Will be populated as work progresses with obs-001, obs-002, etc.]

---

**Important Guidelines:**
1. Keep tasks **patch-sized** (1-3 file edits per task max)
2. Make acceptance checks **specific and verifiable**, and only include those required by the request
3. Define clear "Done when" criteria for each task
4. Consider backward compatibility and existing behavior
5. Identify scope boundaries explicitly

Generate the plan now in valid markdown format:`;
  }

  /**
   * Extract file-like tokens from user request for diagnostics scoping
   * @private
   */
  _extractRequestedFilePaths(userRequest) {
    const text = String(userRequest || '');
    if (!text) return [];
    const matches = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || [];
    const unique = new Set();
    for (const raw of matches) {
      const cleaned = raw.replace(/[),.;:]+$/g, '');
      if (cleaned) unique.add(cleaned);
    }
    return Array.from(unique);
  }

  /**
   * Extract file paths from prior messages (e.g., /problems output)
   * @private
   */
  _extractRequestedFilePathsFromMessages(context) {
    const chatState = context.getChatState() || {};
    const messages = (Array.isArray(chatState.baseMessages) && chatState.baseMessages.length)
      ? chatState.baseMessages
      : (Array.isArray(chatState.messages) && chatState.messages.length)
        ? chatState.messages
        : (Array.isArray(context.uiMessages) && context.uiMessages.length)
          ? context.uiMessages
          : [];
    const paths = new Set();
    for (const msg of messages) {
      if (!msg || typeof msg.content !== 'string') continue;
      const content = msg.content;
      // Match diagnostics-style entries: path:line:col
      const diagMatches = content.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):\d+:\d+/g) || [];
      for (const match of diagMatches) {
        const filePath = match.split(':')[0];
        if (filePath) paths.add(filePath);
      }
      // Also capture plain file tokens
      const fileMatches = content.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || [];
      for (const match of fileMatches) {
        const cleaned = match.replace(/[),.;:]+$/g, '');
        if (cleaned) paths.add(cleaned);
      }
    }
    return Array.from(paths);
  }

  /**
   * Generate plan by calling LLM
   * @private
   */
  async _generatePlan(context, planPrompt) {
    const chatState = context.getChatState();
    
    // Prepare messages for LLM
    const messages = [
      {
        role: 'user',
        content: planPrompt
      }
    ];

    // Call LLM
    const response = await context.deps.callLLM(messages, 'agent_plan');

    // Extract markdown plan from response (response is a string, not an object)
    let planMarkdown = response || '';

    // Clean up any code fences if present
    planMarkdown = planMarkdown.replace(/```markdown\n?/g, '').replace(/```\n?$/g, '');

    // If plan generation failed or is too short, create a basic template
    if (planMarkdown.length < 200) {
      const userRequest = this._extractUserRequest(context);
      planMarkdown = this._createFallbackPlan(userRequest);
    }

    return planMarkdown;
  }

  /**
   * Create fallback plan if LLM fails
   * @private
   */
  _createFallbackPlan(userRequest) {
    const plan = createEmptyPlan();
    const requestText = String(userRequest || '').toLowerCase();
    const wantsBuild = /\b(build|compile|ci)\b/.test(requestText);
    const wantsTests = /\b(test|tests|jest|vitest|pytest)\b/.test(requestText);
    const wantsFixErrors = /\b(fix|error|errors|issue|issues|bug|bugs)\b/.test(requestText);
    const wantsNoDiagnostics = /\b(skip diagnostics|ignore diagnostics|no diagnostics)\b/.test(requestText);
    const wantsDiagnostics = !wantsNoDiagnostics;

    plan.header.objective = userRequest;
    plan.header.constraints = 'Maintain backward compatibility, no new dependencies';
    plan.header.scope = 'To be determined during feature mapping';
    plan.baseline.build = wantsBuild ? 'Not yet captured - will run before edits' : 'Not required (per plan)';
    plan.baseline.tests = wantsTests ? 'Not yet captured - will run before edits' : 'Not required (per plan)';
    plan.baseline.diagnostics = wantsDiagnostics ? 'Not yet captured - will capture before edits' : 'Not required (per plan)';

    const acceptanceChecks = [];
    if (wantsDiagnostics) acceptanceChecks.push({ checked: false, text: 'No relevant IDE errors/warnings in scope' });
    if (wantsBuild) acceptanceChecks.push({ checked: false, text: 'Build succeeds (or unchanged vs baseline)' });
    if (wantsTests) acceptanceChecks.push({ checked: false, text: 'Targeted tests pass' });
    if (acceptanceChecks.length === 0) {
      acceptanceChecks.push({ checked: false, text: 'Requested behavior implemented and verified' });
    }
    acceptanceChecks.push({ checked: false, text: 'Diff stays within scope' });
    plan.acceptanceChecks = acceptanceChecks;

    plan.tasks = [
      {
        id: 'T1',
        checked: false,
        title: 'Analyze requirements',
        description: 'Understand the requested change',
        doneWhen: 'Requirements are clear and scope is defined'
      },
      {
        id: 'T2',
        checked: false,
        title: 'Implement change',
        description: 'Make the necessary code modifications',
        doneWhen: wantsFixErrors ? 'Diagnostics for scope are clean' : 'Requested behavior is implemented'
      }
    ];

    return buildMarkdownPlan(plan);
  }

  /**
   * Display plan to user via streaming
   * @private
   */
  async _displayPlan(context, planMarkdown) {
    const chatState = context.getChatState();
    
    const wrapped = '\n\n---\n\n## 📋 Execution Plan\n\n' + planMarkdown + '\n\n---\n\n';

    // Ensure the plan persists through later chatState syncs.
    context.addUiMessage({ role: 'assistant', content: wrapped });
    // Backends like Ollama require the last message to be a user/tool turn.
    // Store the plan as a user instruction so execution can begin immediately.
    context.addModelMessage({
      role: 'user',
      content:
`Execution plan (follow this contract during execution):

${planMarkdown}

Now begin execution. Respond with JSON only. Include {"text":"...","toolCalls":[{...},...]}.\nYou may include multiple tool calls to fix multiple issues in one response.\nIf the fix is already known from exploration, proceed directly with edit_file — do not re-read files or call non-standard tools.`
    });

    chatState.markdownPlan = planMarkdown;
    chatState.messages = context.uiMessages;
    if (context.deps.postChatState) {
      context.deps.postChatState();
    }
  }
}

module.exports = { PlanInitializationPhase };
