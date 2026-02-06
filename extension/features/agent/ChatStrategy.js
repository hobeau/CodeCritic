/**
 * ChatStrategy - Orchestrates chat execution through phases
 * Phase sequence: Init → StopCheck → Command → SmartSearch → LLMCall → Parsing → ToolExecution → Finalization
 */

const { PhaseResult } = require('./PhaseResult');
const { ChatInitializationPhase } = require('./phases/ChatInitializationPhase');
const { StopCheckPhase } = require('./phases/StopCheckPhase');
const { CommandParsingPhase } = require('./phases/CommandParsingPhase');
const { SmartSearchPhase } = require('./phases/SmartSearchPhase');
const { LLMCallPhase } = require('./phases/LLMCallPhase');
const { ParsingPhase } = require('./phases/ParsingPhase');
const { ChatPlannerToolExecutionPhase } = require('./phases/ChatPlannerToolExecutionPhase');
const { FinalizationPhase } = require('./phases/FinalizationPhase');

class ChatStrategy {
  constructor(userText) {
    this.userText = userText;
    
    // Define execution phases in order
    this.phases = [
      new ChatInitializationPhase(),
      new StopCheckPhase(),
      new CommandParsingPhase(),
      new SmartSearchPhase(),
      new LLMCallPhase(),
      new ParsingPhase(),
      new ChatPlannerToolExecutionPhase(),
      new FinalizationPhase()
    ];
  }

  /**
   * Run the chat strategy with given context
   * @param {ChatContext} context - Chat execution context
   * @returns {Promise<string>} 'success', 'failure', or 'stopped'
   */
  async run(context) {
    let lastResult = null;

    // Run initialization phase once
    const initResult = await this.phases[0].execute(context);
    if (!initResult.isContinue()) {
      return this.handleNonContinueResult(initResult, context);
    }

    // Main execution loop through remaining phases
    while (context.step < context.maxSteps) {

      // Execute phases in sequence (skip initialization phase at index 0)
      for (let i = 1; i < this.phases.length; i++) {
        const phase = this.phases[i];
        let result;

        // Special handling for phases that need extra parameters
        if (phase instanceof CommandParsingPhase || phase instanceof SmartSearchPhase) {
          result = await phase.execute(context, this.userText);
        } else if (phase instanceof ParsingPhase) {
          result = await phase.execute(context, lastResult?.data);
        } else if (phase instanceof ChatPlannerToolExecutionPhase) {
          // Only run if we have parsed tool calls
          if (lastResult?.data?.parsed?.toolCalls) {
            result = await phase.execute(context, lastResult.data.parsed);
          } else {
            result = PhaseResult.continue();
          }
        } else {
          result = await phase.execute(context, lastResult?.data);
        }

        // Handle phase results
        if (result.isStop()) {
          return 'stopped';
        }

        if (result.isFinal()) {
          return 'success';
        }

        if (result.isRetry()) {
          // Retry from LLMCallPhase
          i = this.phases.findIndex(p => p instanceof LLMCallPhase) - 1;
          continue;
        }

        if (result.isFailure()) {
          return 'failure';
        }

        // Continue to next phase
        lastResult = result;
      }

      // Increment step counter after completing all phases
      context.incrementStep();

      // After all phases, loop back for next iteration
      // (tool execution will have updated context for next LLM call)
    }
  }

  /**
   * Handle max steps reached
   * @param {ChatContext} context - Chat execution context
   * @returns {string} 'failure'
   */
  handleMaxStepsReached(context) {
    if (context.deps.setAgentContinuation) {
      context.deps.setAgentContinuation(context.modelMessages);
    }
    
    context.addUiMessage({
      role: 'assistant',
      content: 'Chat stopped: too many steps.'
    });
    
    const chatState = context.getChatState();
    chatState.messages = context.uiMessages;
    
    if (context.deps.postChatState) {
      context.deps.postChatState();
    }
    
    return 'failure';
  }
}

module.exports = { ChatStrategy };
