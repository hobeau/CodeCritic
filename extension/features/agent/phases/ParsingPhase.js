/**
 * ParsingPhase - Parse LLM response for tool calls or final answer
 */

const { PhaseResult } = require('../PhaseResult');
const {
  parseAgentResponse,
  parseTaggedToolCalls,
  extractToolCallsFromText,
  extractLooseToolCalls,
  extractActionLineToolCall
} = require('../utils/parsing');
const { areAllAcceptanceChecksSatisfied, getAcceptanceCheckRequirements } = require('../utils/MarkdownPlanManager');
const { filterProblemsByContext } = require('../utils/diagnosticsUtils');

class ParsingPhase {
  /**
   * Execute parsing phase
   * - Apply multi-strategy parsing to LLM response
   * - Handle final responses
   * - Handle parse failures with retry
   * - Extract structured response data
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Final response, Continue with parsed data, or Retry
   */
  async execute(context) {
    const assistantText = context.lastAssistantText;
    const chatState = context.getChatState();
    
    // Try multiple parsing strategies
    let parsed = parseAgentResponse(assistantText);
    if (!parsed) {
      parsed = parseTaggedToolCalls(assistantText)
        || extractToolCallsFromText(assistantText)
        || extractLooseToolCalls(assistantText)
        || extractActionLineToolCall(assistantText);
    }
    
    // Handle parse failure
    if (!parsed) {
      const retryCount = context.incrementRetry();
      
      if (context.isRetryLimitReached()) {
        // In agent mode, don't finalize on parse failure — push the model to respond with JSON/tool calls.
        if (context.mode === 'agent') {
          context.resetRetry();
          const requested = Array.isArray(context.requestedFilePaths) && context.requestedFilePaths.length
            ? context.requestedFilePaths[0]
            : null;
          const hint = requested
            ? `Start with a tool call like {"toolCalls":[{"tool":"read_file","args":{"path":"${requested}","startLine":1,"endLine":200}}]}.`
            : 'Start with a tool call (e.g., read_file/search) to proceed.';
          
          context.addModelMessage({
            role: 'user',
            content: `Error: could not parse your response as JSON. You must respond with JSON only. ${hint}`
          });
          
          // Treat as a final-like response so acceptance-check gating can block premature completion
          parsed = { final: assistantText };
        } else {
          // After 3 failures, treat as final response (non-agent modes)
          context.resetRetry();
          context.addUiMessage({ role: 'assistant', content: assistantText });
          context.addModelMessage({ role: 'assistant', content: assistantText });
          
          const chatState = context.getChatState();
          chatState.messages = context.uiMessages;
          
          if (context.deps.setAgentContinuation) {
            context.deps.setAgentContinuation(null);
          }
          
          if (context.deps.postChatState) {
            context.deps.postChatState();
          }
          
          return PhaseResult.final(assistantText);
        }
      } else {
        // Add error message and retry
        context.addModelMessage({
          role: 'user',
          content: `Error: could not parse your response. Please respond with valid JSON containing either {"toolCalls":[...]} or {"final":"..."} (Attempt ${retryCount}/3)`
        });
        
        return PhaseResult.retry('Parse failure');
      }
    }
    // Reset retry counter on successful parse
    context.resetRetry();

    // Detect "plan-only" responses and force execution kickoff in agent mode
    const planLikeText = (() => {
      const candidate = typeof parsed?.final === 'string'
        ? parsed.final
        : (typeof parsed?.text === 'string' ? parsed.text : '');
      if (!candidate) return '';
      return candidate;
    })();
    const isPlanOnlyResponse = context.mode === 'agent'
      && !parsed?.toolCalls?.length
      && /ReAct Agent Execution Plan/i.test(planLikeText)
      && /##\s*0\)\s*Header/i.test(planLikeText);
    if (isPlanOnlyResponse) {
      const hasPriorActions = Array.isArray(context.executedTools) && context.executedTools.length > 0;
      const requested = Array.isArray(context.requestedFilePaths) && context.requestedFilePaths.length
        ? context.requestedFilePaths[0]
        : null;
      if (!hasPriorActions && requested) {
        const isBareName = !requested.includes('/') && !requested.includes('\\');
        const kickoffCall = isBareName
          ? { tool: 'locate_file', args: { query: requested, include: '**/*', exclude: '**/node_modules/**', maxResults: 20 } }
          : { tool: 'read_file', args: { path: requested, startLine: 1, endLine: 200 } };
        context.addUiMessage({
          role: 'assistant',
          content: `**Proceeding**: Starting execution by reading ${requested}.`
        });
        return PhaseResult.continue({
          parsed: { toolCalls: [kickoffCall] },
          displayText: ''
        });
      }
      
      context.addModelMessage({
        role: 'user',
        content: 'You already produced the execution plan. Now execute it using tools. Start with a tool call (e.g., read_file or locate_file) and do not repeat the plan.'
      });
      return PhaseResult.retry('Plan-only response');
    }
    
    // Handle final response
    if (parsed.final) {
      // Pre-plan exploration: do not allow finalization
      if (context.mode === 'agent' && String(context.stage || '') === 'explore') {
        context.addModelMessage({
          role: 'user',
          content: 'Do not return a final answer during exploration. Use a read/search tool call, or respond with {"readyForPlan":true} when you have enough context.'
        });
        return PhaseResult.retry('Final response blocked during exploration');
      }

      // Extract and update plan if present
      if (parsed.plan && context.deps.applyPlanUpdate) {
        await context.deps.applyPlanUpdate(parsed.plan);
      }
      
      // Agent-specific: Block premature finalization if acceptance checks are not satisfied
      if (context.mode === 'agent') {
        const parsedPlan = context.getParsedPlan();
        if (parsedPlan && !areAllAcceptanceChecksSatisfied(parsedPlan)) {
          const requirements = getAcceptanceCheckRequirements(parsedPlan);
          const evidence = context.currentEvidence || {};
          const missing = [];
          if (requirements.requiresBuild && !evidence.build) missing.push('build');
          if (requirements.requiresTests && !evidence.tests) missing.push('tests');
          if (requirements.requiresDiagnostics && !evidence.diagnostics) missing.push('diagnostics');
          const pendingChecks = parsedPlan.acceptanceChecks
            .filter(c => !c.checked)
            .map(c => c.text)
            .join(', ');

          context.addModelMessage({
            role: 'user',
            content: `You attempted to finalize but acceptance checks are not satisfied. ` +
              `${pendingChecks ? `Unsatisfied checks: ${pendingChecks}. ` : ''}` +
              `${missing.length ? `Missing required evidence: ${missing.join(', ')}.` : ''} ` +
              `Continue with tools/validation until these are satisfied.`
          });

          if (parsed.final && parsed.final.trim()) {
            context.addUiMessage({ role: 'assistant', content: parsed.final.trim() });
          }

          return PhaseResult.continue({ forceValidation: missing.length > 0 });
        }
      }

      // Agent-specific: Check workspace problems if not already done
      if (context.mode === 'agent' && typeof context.wereProblemsCollected === 'function' && !context.wereProblemsCollected()) {
        if (context.deps.collectWorkspaceProblems) {
          const problems = context.deps.collectWorkspaceProblems(50);
          const filtered = filterProblemsByContext(problems, context);
          if (filtered && filtered.length) {
            const problemText = `\n\nWorkspace diagnostics:\n${filtered.join('\n')}`;
            context.addModelMessage({ role: 'user', content: problemText });
          }
        }
        if (context.markProblemsCollected) {
          context.markProblemsCollected();
        }
      }
      
      // Agent-specific: Save to agent memory if enabled
      if (context.mode === 'agent') {
        if (context.deps.isAgentMemoryEnabled && context.deps.isAgentMemoryEnabled()) {
          const summary = context.deps.formatAgentOutcome
            ? context.deps.formatAgentOutcome(context.uiMessages, parsed.final)
            : `Completed: ${parsed.final.slice(0, 200)}`;
          
          if (context.deps.appendAgentMemory) {
            await context.deps.appendAgentMemory(summary);
          }
        }
      }
      
      // Clear continuation
      if (context.deps.setAgentContinuation) {
        context.deps.setAgentContinuation(null);
      }
      
      // Add to UI messages
      context.addUiMessage({ role: 'assistant', content: parsed.final });
      chatState.messages = context.uiMessages;
      
      if (context.deps.postChatState) {
        context.deps.postChatState();
      }
      
      return PhaseResult.final(parsed.final, { plan: parsed.plan });
    }

    const displayText = parsed.text || '';
    
    // Return continue with parsed data
    return PhaseResult.continue({
      parsed,
      displayText,
      toolCalls: parsed.toolCalls
    });
  }
}

module.exports = { ParsingPhase };
