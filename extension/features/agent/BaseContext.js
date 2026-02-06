/**
 * BaseContext - Base class for all mode contexts (agent, chat, planner)
 * Provides common state management and dependency injection
 */

class BaseContext {
  /**
   * @param {object} options - Context configuration
   * @param {string} options.mode - Execution mode ('agent', 'chat', 'planner')
   * @param {Array} options.baseMessages - Initial messages for UI
   * @param {Array} options.modelMessages - Messages for model context
   * @param {object} options.deps - Injected dependencies
   */
  constructor(options) {
    const { mode, baseMessages, modelMessages, deps } = options;
    
    // Mode identifier
    this.mode = mode || 'chat';
    
    // Message state
    this.uiMessages = [...baseMessages];
    this.modelMessages = Array.isArray(modelMessages) && modelMessages.length
      ? [...modelMessages]
      : [...baseMessages];
    
    // Loop control
    this.step = 0;
    this.maxSteps = 0;
    this.historyLimit = 0;
    
    // Retry/error handling
    this.retryCount = 0;
    this.lastAssistantText = '';
    
    // Tool execution tracking
    this.executedTools = [];
    
    // Injected dependencies
    this.deps = deps || {};
  }

  /**
   * Initialize config-dependent values (max steps, history limit)
   * @param {number} maxSteps - Maximum steps
   * @param {number} historyLimit - Chat history character limit
   */
  initializeConfig(maxSteps, historyLimit) {
    this.maxSteps = maxSteps;
    this.historyLimit = historyLimit;
  }

  /**
   * Add a message to UI messages
   * @param {object} message - Message with role and content
   */
  addUiMessage(message) {
    this.uiMessages.push(message);
  }

  /**
   * Add a message to model messages
   * @param {object} message - Message with role and content
   */
  addModelMessage(message) {
    this.modelMessages.push(message);
  }

  /**
   * Increment the step counter
   * @returns {number} New step value
   */
  incrementStep() {
    this.step += 1;
    return this.step;
  }

  /**
   * Check if stop was requested
   * @returns {boolean}
   */
  isStopRequested() {
    return this.deps.stopRequested && this.deps.stopRequested();
  }

  /**
   * Check if maximum steps reached
   * @returns {boolean}
   */
  isMaxStepsReached() {
    return this.step >= this.maxSteps;
  }

  /**
   * Record a tool execution
   * @param {object} toolCall - Tool call with tool and args
   * @param {string} result - Tool execution result
   */
  recordToolExecution(toolCall, result) {
    this.executedTools.push({
      tool: toolCall.tool,
      args: toolCall.args,
      result
    });
  }

  /**
   * Increment retry counter
   * @returns {number} New retry count
   */
  incrementRetry() {
    this.retryCount += 1;
    return this.retryCount;
  }

  /**
   * Reset retry counter
   */
  resetRetry() {
    this.retryCount = 0;
  }

  /**
   * Check if retry limit reached (3 retries)
   * @returns {boolean}
   */
  isRetryLimitReached() {
    return this.retryCount >= 3;
  }

  /**
   * Get current chat state reference
   * @returns {object} Chat state object
   */
  getChatState() {
    return this.deps.chatState;
  }

  /**
   * Get a summary object for the current context state (for debugging/logging)
   * @returns {object} Context summary
   */
  getSummary() {
    return {
      mode: this.mode,
      step: this.step,
      maxSteps: this.maxSteps,
      retryCount: this.retryCount,
      uiMessageCount: this.uiMessages.length,
      modelMessageCount: this.modelMessages.length,
      executedToolCount: this.executedTools.length
    };
  }
}

module.exports = { BaseContext };
