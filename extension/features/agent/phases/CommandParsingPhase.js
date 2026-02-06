/**
 * CommandParsingPhase - Parse and handle special commands for chat/planner modes
 * Handles /debugger, /search, and /symbols commands
 */

const { PhaseResult } = require('../PhaseResult');

class CommandParsingPhase {
  /**
   * Execute command parsing phase
   * - Check for special commands (/debugger, /search, /symbols)
   * - Build command context messages
   * - Add to context for LLM
   * 
   * @param {ChatContext|PlannerContext} context - Execution context
   * @param {string} userText - User input text
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context, userText) {
    // Parse commands
    const debugCmd = this.parseDebuggerCommand(userText);
    const searchCmd = !debugCmd ? this.parseSearchCommand(userText) : null;
    const symbolsCmd = !debugCmd && !searchCmd ? this.parseSymbolsCommand(userText) : null;
    const problemsCmd = !debugCmd && !searchCmd && !symbolsCmd ? this.parseProblemsCommand(userText) : null;
    
    const commandMessages = [];
    
    // Build command context messages
    if (debugCmd && context.deps.buildDebuggerContextMessage) {
      const debuggerPayload = await context.deps.buildDebuggerContextMessage(debugCmd.sessionFilter);
      commandMessages.push({ role: 'assistant', content: debuggerPayload });
    } else if (searchCmd && context.deps.buildSearchContextMessage) {
      const searchPayload = await context.deps.buildSearchContextMessage(searchCmd.query);
      commandMessages.push({ role: 'assistant', content: searchPayload });
    } else if (symbolsCmd && context.deps.buildSymbolsContextMessage) {
      const symbolsPayload = await context.deps.buildSymbolsContextMessage(symbolsCmd.query);
      commandMessages.push({ role: 'assistant', content: symbolsPayload });
    } else if (problemsCmd && context.deps.buildProblemsContextMessage) {
      const problemsPayload = await context.deps.buildProblemsContextMessage();
      commandMessages.push({ role: 'assistant', content: problemsPayload });
    }
    
    // Store command messages in context
    context.setCommandMessages(commandMessages);
    
    // If we have command messages, update chat state and persist
    if (commandMessages.length) {
      // Add to UI messages
      for (const msg of commandMessages) {
        context.addUiMessage(msg);
      }
      
      const chatState = context.getChatState();
      chatState.messages = context.uiMessages;
      await context.deps.postChatState();
      
      // Persist to thread if available
      if (context.deps.threadId) {
        for (const msg of commandMessages) {
          await context.deps.addChatMessage(context.deps.threadId, 'assistant', msg.content);
        }
        await context.deps.touchChatThread(context.deps.threadId);
        await context.deps.refreshChatThreads();
      }
    }
    
    // Store command type in context for later use
    context.commandType = debugCmd ? 'debugger' : (searchCmd ? 'search' : (symbolsCmd ? 'symbols' : (problemsCmd ? 'problems' : '')));
    context.commandQuery = debugCmd
      ? debugCmd.query
      : (searchCmd ? searchCmd.query : (symbolsCmd ? symbolsCmd.query : (problemsCmd ? problemsCmd.query : '')));
    
    return PhaseResult.continue();
  }
  
  /**
   * Parse /debugger command
   * @param {string} text - User input text
   * @returns {object|null} Parsed command or null
   */
  parseDebuggerCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.toLowerCase().startsWith('/debugger')) return null;
    const rest = raw.slice('/debugger'.length).trim();
    if (!rest) return { query: '', sessionFilter: '' };
    const sessionMatch = /^session[:=]("([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/.exec(rest);
    if (sessionMatch) {
      const sessionFilter = sessionMatch[2] || sessionMatch[3] || sessionMatch[4] || '';
      const query = sessionMatch[5] || '';
      return { query, sessionFilter };
    }
    return { query: rest, sessionFilter: '' };
  }
  
  /**
   * Parse /search command
   * @param {string} text - User input text
   * @returns {object|null} Parsed command or null
   */
  parseSearchCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.toLowerCase().startsWith('/search')) return null;
    const rest = raw.slice('/search'.length).trim();
    return { query: rest };
  }
  
  /**
   * Parse /symbols command
   * @param {string} text - User input text
   * @returns {object|null} Parsed command or null
   */
  parseSymbolsCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.toLowerCase().startsWith('/symbols')) return null;
    const rest = raw.slice('/symbols'.length).trim();
    return { query: rest };
  }
  
  /**
   * Parse /problems command
   * @param {string} text - User input text
   * @returns {object|null} Parsed command or null
   */
  parseProblemsCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.toLowerCase().startsWith('/problems')) return null;
    const rest = raw.slice('/problems'.length).trim();
    return { query: rest };
  }
}

module.exports = { CommandParsingPhase };
