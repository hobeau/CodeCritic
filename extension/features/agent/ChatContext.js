/**
 * ChatContext - Context for chat mode execution
 * Extends BaseContext with chat-specific features (simpler than agent, no deduplication/caching)
 */

const { BaseContext } = require('./BaseContext');

class ChatContext extends BaseContext {
  /**
   * @param {object} options - Context configuration
   * @param {Array} options.baseMessages - Initial messages for UI
   * @param {Array} options.modelMessages - Messages for model context
   * @param {object} options.deps - Injected dependencies
   */
  constructor(options) {
    super({ ...options, mode: 'chat' });
    
    // Chat-specific: Tool messages separate from base messages
    this.toolMessages = [];
    this.modelToolMessages = [];
    
    // Chat-specific: Special command context
    this.commandMessages = [];
    
    // Chat-specific: Smart search context
    this.smartSearchMessages = [];
  }

  /**
   * Add a tool-related message
   * @param {object} message - Message with role and content
   */
  addToolMessage(message) {
    this.toolMessages.push(message);
  }

  /**
   * Add a tool result message to model context
   * @param {object} message - Message with role and content
   */
  addModelToolMessage(message) {
    this.modelToolMessages.push(message);
  }

  /**
   * Set command context messages
   * @param {Array} messages - Command-related messages
   */
  setCommandMessages(messages) {
    this.commandMessages = messages || [];
  }

  /**
   * Set smart search context messages
   * @param {Array} messages - Smart search-related messages
   */
  setSmartSearchMessages(messages) {
    this.smartSearchMessages = messages || [];
  }

  /**
   * Build complete message trace for LLM call
   * @returns {Array} Complete message array
   */
  buildMessageTrace() {
    return [
      ...this.uiMessages,
      ...this.commandMessages,
      ...this.smartSearchMessages,
      ...this.toolMessages
    ];
  }

  /**
   * Build model message trace with tool results
   * @returns {Array} Model message array
   */
  buildModelMessageTrace() {
    return [
      ...this.modelMessages,
      ...this.modelToolMessages
    ];
  }
}

module.exports = { ChatContext };
