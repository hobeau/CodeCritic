/**
 * AgentStrategy - Orchestrates agent execution through staged ReAct loops
 * 
 * Phase Flow:
 * 1) Explore (read-only) - interleave reasoning + read/search actions until ready
 * 2) Plan (markdown contract) - generate plan after exploration findings
 * 3) Execute (mutations allowed) - reason → act → observe → verify until complete
 */

const { PhaseResult } = require('./PhaseResult');
const { AgentInitializationPhase } = require('./phases/AgentInitializationPhase');
const { ExplorationInitializationPhase } = require('./phases/ExplorationInitializationPhase');
const { ExplorationSummaryPhase } = require('./phases/ExplorationSummaryPhase');
const { PrePlanFinalizationPhase } = require('./phases/PrePlanFinalizationPhase');
const { PlanInitializationPhase } = require('./phases/PlanInitializationPhase');
const { BaselineCapturePhase } = require('./phases/BaselineCapturePhase');
const { ExecutionInitializationPhase } = require('./phases/ExecutionInitializationPhase');
const { StopCheckPhase } = require('./phases/StopCheckPhase');
const { LLMCallPhase } = require('./phases/LLMCallPhase');
const { ParsingPhase } = require('./phases/ParsingPhase');
const { MarkdownPlanUpdatePhase } = require('./phases/MarkdownPlanUpdatePhase');
const { ActionPolicyPhase } = require('./phases/ActionPolicyPhase');
const { SingleActionExecutionPhase } = require('./phases/SingleActionExecutionPhase');
const { ValidationPhase } = require('./phases/ValidationPhase');
const PlanReflectionPhase = require('./phases/PlanReflectionPhase'); // NEW
const { CompletionDecisionPhase } = require('./phases/CompletionDecisionPhase');
const { FinalizationPhase } = require('./phases/FinalizationPhase');

class AgentStrategy {
  constructor() {
    // Initialize phases in execution order
    this.initPhases = [
      new AgentInitializationPhase(),        // Config initialization
      new ExplorationInitializationPhase()   // Pre-plan exploration init
    ];

    // Pre-plan exploration loop: reason + read/search action + observe
    this.explorationPhases = [
      new StopCheckPhase(),
      new LLMCallPhase(),
      new ParsingPhase(),
      new ActionPolicyPhase(),               // Explore-mode: read/search only
      new SingleActionExecutionPhase(),      // Execute ONE action (read/search)
      new PrePlanFinalizationPhase()         // Increment prePlanStep, sync state
    ];

    // One-time post-exploration setup
    this.postExplorationPhases = [
      new ExplorationSummaryPhase(),         // Structured findings for plan grounding
      new PlanInitializationPhase(),         // Generate markdown plan
      new BaselineCapturePhase(),            // Capture baseline evidence per plan
      new ExecutionInitializationPhase()     // Explicitly enter execution (mutations allowed)
    ];
    
    // Main execute loop: reason → plan update → policy → act → observe → reflect → verify
    this.loopPhases = [
      new StopCheckPhase(),
      new LLMCallPhase(),
      new ParsingPhase(),
      new MarkdownPlanUpdatePhase(),         // Apply structured plan updates
      new ActionPolicyPhase(),               // Execute-mode: read-before-write gating
      new SingleActionExecutionPhase(),      // Execute tool actions (Act)
      new ValidationPhase(),                 // Acceptance ladder (Observe)
      new PlanReflectionPhase(),             // NEW: Meta-cognitive plan reflection
      new CompletionDecisionPhase(),         // Evidence-based completion check
      new FinalizationPhase()                // Increment execute step counter
    ];
  }

  /**
   * Run the agent strategy with given context
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<string>} 'success', 'failure', or 'stopped'
   */
  async run(context) {
    // One-time init
    for (const phase of this.initPhases) {
      const result = await phase.execute(context);
      if (!result.isContinue()) {
        return this.handleNonContinueResult(result, context);
      }
    }

    // NEW: Outer loop for continuous plan refinement (explore → plan → execute → reflect → re-explore)
    const maxOuterLoops = 3;
    while (context.outerLoopCount < maxOuterLoops) {
      context.outerLoopCount += 1;
      
      // Reset reflection count for this outer loop iteration
      context.planReflectionCount = 0;
      context.planReflected = false;
      context.planChanged = false;

      // Stage 1: Pre-plan exploration loop (read-only)
      const explorationResult = await this._runExplorationStage(context);
      if (explorationResult !== 'continue') {
        return explorationResult;
      }

      // Stage 2: Summarize exploration, generate/merge plan, capture baseline
      const planResult = await this._runPlanStage(context);
      if (planResult !== 'continue') {
        return planResult;
      }

      // Stage 3: Main execute loop (mutations allowed)
      const executeResult = await this._runExecuteStage(context);
      if (executeResult !== 'continue') {
        // If execution completed successfully, return success
        if (executeResult === 'success') {
          return 'success';
        }
        return executeResult;
      }

      // Check if re-exploration is needed
      if (!context.needsReExploration) {
        // Execution did not complete and no re-exploration requested - likely max steps
        break;
      }

      // Prepare for re-exploration
      context.addUiMessage({
        role: 'assistant',
        content: `**Re-exploration needed**: ${context.reExplorationReason}\n\nStarting re-exploration cycle ${context.outerLoopCount + 1} of ${maxOuterLoops}...`
      });
      
      this._prepareReExploration(context);
    }

    // Max outer loops reached
    if (context.needsReExploration && context.outerLoopCount >= maxOuterLoops) {
      context.addUiMessage({
        role: 'assistant',
        content: `**Note**: Reached maximum re-exploration cycles (${maxOuterLoops}). Completing with current state.`
      });
    }

    return this.handleMaxStepsReached(context);
  }

  /**
   * Run Stage 1: Pre-plan exploration loop (read-only)
   * @private
   */
  async _runExplorationStage(context) {
    let exitedDueToReadyForPlan = false;
    while (context.prePlanStep < context.prePlanMaxSteps) {
      if (context.awaitingHumanInput) {
        return this.handleAwaitingHumanInput(context);
      }

      let phaseData = null;
      let iterationReadyForPlan = false;
      let restart = false;

      for (const phase of this.explorationPhases) {
        if (phaseData) {
          context.data = phaseData;
        }

        const result = await phase.execute(context);

        if (result.isStop()) {
          return 'stopped';
        }

        if (result.isFailure()) {
          return 'failure';
        }

        // Do not allow finalization during exploration
        if (result.isFinal()) {
          context.addModelMessage({
            role: 'user',
            content: 'Do not finalize during exploration. Use a read/search tool call or respond with {"readyForPlan":true}.'
          });
          restart = true;
          break;
        }

        if (result.isRetry()) {
          restart = true;
          break;
        }

        phaseData = result.data;

        // Track the readyForPlan signal (from ActionPolicyPhase)
        if (phase && phase.constructor && phase.constructor.name === 'ActionPolicyPhase') {
          if (result.data && result.data.readyForPlan === true) {
            iterationReadyForPlan = true;
          }
        }

        if (context.awaitingHumanInput) {
          return this.handleAwaitingHumanInput(context);
        }
      }

      if (restart) {
        continue;
      }

      // Confidence-based exploration exit: if all diagnostic locations are read
      // and we've completed at least 1 iteration, force exit
      if (context.prePlanHasSuccessfulAction && context.prePlanStep >= 1) {
        const hasReadAllDiagnostics = this._hasReadAllDiagnosticLocations(context);
        if (hasReadAllDiagnostics) {
          exitedDueToReadyForPlan = true;
          break;
        }
      }

      if (iterationReadyForPlan) {
        if (context.prePlanHasSuccessfulAction) {
          exitedDueToReadyForPlan = true;
          break;
        }
        context.addModelMessage({
          role: 'user',
          content: 'Before generating a plan, perform at least one successful read/search tool call to ground the request.'
        });
      }
    }

    if (!exitedDueToReadyForPlan) {
      context.explorationTruncated = true;
      context.addUiMessage({
        role: 'assistant',
        content: '**Note**: Exploration truncated (reached exploration step limit). Proceeding to plan generation.'
      });
    }

    return 'continue';
  }

  /**
   * Run Stage 2: Summarize exploration, generate/merge plan, capture baseline
   * @private
   */
  async _runPlanStage(context) {
    // If this is a re-exploration cycle (outerLoopCount > 1), merge findings instead of replacing plan
    if (context.outerLoopCount > 1) {
      // Merge re-exploration findings with existing plan
      const mergeResult = await this._mergeReExplorationFindings(context);
      if (mergeResult && mergeResult !== 'continue') {
        return mergeResult;
      }
    } else {
      // First cycle: generate new plan
      for (const phase of this.postExplorationPhases) {
        const result = await phase.execute(context);
        if (!result.isContinue()) {
          return this.handleNonContinueResult(result, context);
        }
      }
    }

    return 'continue';
  }

  /**
   * Run Stage 3: Main execute loop (mutations allowed)
   * @private
   */
  async _runExecuteStage(context) {
    context.setStage('execute');

    // Main ReAct loop
    while (context.step < context.maxSteps) {
      // Check if awaiting human input
      if (context.awaitingHumanInput) {
        return this.handleAwaitingHumanInput(context);
      }
      
      let phaseData = null;
      
      // Execute ReAct loop phases
      for (const phase of this.loopPhases) {
        // Store data from previous phase if any
        if (phaseData) {
          context.data = phaseData;
        }
        
        const result = await phase.execute(context);
        
        // Handle non-continue results
        if (result.isStop()) {
          return 'stopped';
        }
        
        if (result.isFinal()) {
          return 'success';
        }
        
        if (result.isFailure()) {
          return 'failure';
        }
        
        if (result.isRetry()) {
          // Retry from LLMCallPhase
          break; // Break inner loop, will restart at loop beginning
        }
        
        // Continue - store data for next phase
        phaseData = result.data;
        
        // Check if awaiting human input after each phase
        if (context.awaitingHumanInput) {
          return this.handleAwaitingHumanInput(context);
        }
      }
      
      // Check if re-exploration is needed after this iteration
      if (context.needsReExploration) {
        return 'continue'; // Signal to outer loop to re-explore
      }
      
      // If we completed all phases, continue to next iteration
      // (FinalizationPhase increments step counter)
    }

    // Max steps reached in execute loop
    return 'continue'; // Let outer loop handle max steps
  }

  /**
   * Prepare context for re-exploration
   * Resets exploration state with shorter budget, preserves plan
   * @private
   */
  _prepareReExploration(context) {
    // Capture reason before resetting (needed for model message)
    const reason = context.reExplorationReason || 'missing information';
    
    // Reset exploration state
    context.prePlanStep = 0;
    context.prePlanHasSuccessfulAction = false;
    context.explorationTruncated = false;
    
    // Shorter exploration budget for re-exploration (half of original)
    const originalBudget = context.prePlanMaxSteps || 3;
    context.prePlanMaxSteps = Math.max(1, Math.floor(originalBudget / 2));
    
    // Reset needsReExploration flag
    context.needsReExploration = false;
    context.reExplorationReason = null;
    
    // Preserve plan, evidence, and observations - we're adding to existing context
    // No need to reset markdownPlan, parsedPlan, baseline, evidence, observations
    
    // Add model message with re-exploration context
    context.addModelMessage({
      role: 'user',
      content: `Re-exploration phase: The plan requires additional context. Focus exploration on: ${reason}. You have ${context.prePlanMaxSteps} exploration steps.`
    });
  }

  /**
   * Merge re-exploration findings with existing plan
   * Appends new findings to the plan's Findings section
   * @private
   * @returns {Promise<string>} 'continue' if successful, or error result
   */
  async _mergeReExplorationFindings(context) {
    // Run ExplorationSummaryPhase to generate new findings
    const summaryPhase = new ExplorationSummaryPhase();
    const result = await summaryPhase.execute(context);
    
    if (!result.isContinue()) {
      return this.handleNonContinueResult(result, context);
    }
    
    // Get existing plan and new exploration summary
    const parsedPlan = context.getParsedPlan();
    const newFindings = result.data?.explorationSummary || '';
    
    if (!parsedPlan || !newFindings) {
      return 'continue'; // No findings to merge, continue anyway
    }
    
    // Append new findings to existing findings
    const { updateFindings } = require('./utils/MarkdownPlanManager');
    const currentFindings = parsedPlan.findings?.openQuestions || '';
    const mergedFindings = currentFindings 
      ? `${currentFindings}\n\n**Re-exploration findings**:\n${newFindings}`
      : newFindings;
    
    updateFindings(parsedPlan, 'openQuestions', mergedFindings);
    context.updateParsedPlan(parsedPlan);
    
    context.addUiMessage({
      role: 'assistant',
      content: `**Re-exploration complete**: New findings merged into plan.\n\n${newFindings}`
    });
    
    return 'continue';
  }

  /**
   * Handle awaiting human input
   * @private
   */
  handleAwaitingHumanInput(context) {
    // Set continuation for resume when user responds
    if (context.deps.setAgentContinuation) {
      context.deps.setAgentContinuation(context.modelMessages);
    }
    
    // Update chat state
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;
    chatState.awaitingHumanInput = true;
    chatState.pendingQuestion = context.pendingQuestion;
    
    if (context.deps.postChatState) {
      context.deps.postChatState();
    }
    
    return 'awaiting_input'; // New return type for paused state
  }

  /**
   * Handle max steps reached
   * @private
   */
  handleMaxStepsReached(context) {
    // Set continuation for potential resume
    if (context.deps.setAgentContinuation) {
      context.deps.setAgentContinuation(context.modelMessages);
    }
    
    // Add failure message
    context.addUiMessage({
      role: 'assistant',
      content: 'Agent stopped: too many tool steps.'
    });
    
    // Update chat state
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;
    
    if (context.deps.postChatState) {
      context.deps.postChatState();
    }
    
    return 'failure';
  }

  /**
   * Handle non-continue results from initialization
   * @private
   */
  handleNonContinueResult(result, context) {
    if (result.isStop()) return 'stopped';
    if (result.isFinal()) return 'success';
    if (result.isFailure()) return 'failure';
    return 'failure'; // Unexpected state
  }

  /**
   * Check if all diagnostic locations from initial problems have been read.
   * @private
   */
  _hasReadAllDiagnosticLocations(context) {
    const diagnosticLocations = this._extractDiagnosticLocations(context);
    if (diagnosticLocations.length === 0) return false;

    return diagnosticLocations.every(loc => {
      if (!context.readActions || !context.readActions[loc.path]) return false;
      if (!context.executedTools || !Array.isArray(context.executedTools)) return false;
      
      // Check if a read_file call actually covered this diagnostic line
      for (const toolExec of context.executedTools) {
        if (toolExec.tool === 'read_file' && toolExec.args && toolExec.args.path === loc.path) {
          const startLine = toolExec.args.startLine || 1;
          const endLine = toolExec.args.endLine || Infinity;
          if (loc.line >= startLine && loc.line <= endLine) {
            return true;
          }
        }
      }
      return false;
    });
  }

  /**
   * Extract diagnostic file locations from model messages.
   * @private
   */
  _extractDiagnosticLocations(context) {
    const locations = [];
    const messages = context.modelMessages || [];
    
    for (const msg of messages) {
      const content = msg.content || '';
      if (!content.includes('Workspace Errors')) continue;
      
      const regex = /([^:\s]+):(\d+):(\d+)\s+\[[^\]]+\]\s+\(\d+\)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        locations.push({
          path: match[1],
          line: parseInt(match[2], 10),
          col: parseInt(match[3], 10)
        });
      }
    }
    
    return locations;
  }
}

module.exports = { AgentStrategy };
