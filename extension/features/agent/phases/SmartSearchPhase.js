/**
 * SmartSearchPhase - Auto-search for backtick-wrapped terms in user input
 * Provides relevant code context before LLM call
 */

const { PhaseResult } = require('../PhaseResult');

class SmartSearchPhase {
  /**
   * Execute smart search phase
   * - Extract backtick-wrapped terms from user input
   * - Search workspace symbols for each term
   * - Add results to context for LLM
   * 
   * @param {ChatContext|PlannerContext} context - Execution context
   * @param {string} userText - User input text
   * @returns {Promise<PhaseResult>} Continue result
   */
  async execute(context, userText) {
    // Skip if we already have command context
    if (context.commandType) {
      context.setSmartSearchMessages([]);
      return PhaseResult.continue();
    }
    
    // Extract backtick terms
    const terms = this.extractBacktickTerms(userText);
    if (!terms.length) {
      context.setSmartSearchMessages([]);
      return PhaseResult.continue();
    }
    
    // Build smart search messages
    const messages = await this.buildSmartSearchMessages(context, terms);
    context.setSmartSearchMessages(messages);
    
    // If we have smart search messages, update chat state and persist
    if (messages.length) {
      // Add to UI messages
      for (const msg of messages) {
        context.addUiMessage(msg);
      }
      
      const chatState = context.getChatState();
      chatState.messages = context.uiMessages;
      await context.deps.postChatState();
      
      // Persist to thread if available
      if (context.deps.threadId) {
        for (const msg of messages) {
          await context.deps.addChatMessage(context.deps.threadId, 'assistant', msg.content);
        }
        await context.deps.touchChatThread(context.deps.threadId);
        await context.deps.refreshChatThreads();
      }
    }
    
    return PhaseResult.continue();
  }
  
  /**
   * Extract backtick-wrapped terms from text
   * @param {string} text - User input text
   * @returns {Array<string>} Extracted terms
   */
  extractBacktickTerms(text) {
    const str = String(text || '');
    const pattern = /`([^`]+)`/g;
    const terms = [];
    let match;
    while ((match = pattern.exec(str)) !== null) {
      const term = match[1].trim();
      if (term && !terms.includes(term)) {
        terms.push(term);
      }
    }
    return terms;
  }
  
  /**
   * Build smart search messages for backtick terms
   * @param {ChatContext|PlannerContext} context - Execution context
   * @param {Array<string>} terms - Terms to search
   * @returns {Promise<Array>} Search result messages
   */
  async buildSmartSearchMessages(context, terms) {
    const maxTerms = 5;
    const selected = terms.slice(0, maxTerms);
    const messages = [];
    
    for (const term of selected) {
      // Search workspace symbols
      const symbolResults = context.deps.searchWorkspaceSymbols
        ? await context.deps.searchWorkspaceSymbols(term)
        : [];
      
      // Filter and format results
      const preferred = symbolResults.filter((sym) =>
        context.deps.PREFERRED_SYMBOL_KINDS &&
        context.deps.PREFERRED_SYMBOL_KINDS.has(sym.kind) &&
        !(context.deps.isNoiseSymbol && context.deps.isNoiseSymbol(sym))
      );
      
      const usable = preferred.length
        ? preferred
        : symbolResults.filter((sym) => !(context.deps.isNoiseSymbol && context.deps.isNoiseSymbol(sym)));
      
      const limited = usable.slice(0, 20);
      
      if (limited.length) {
        const formatted = limited
          .map((sym) => context.deps.formatSymbolResultMarkdown ? context.deps.formatSymbolResultMarkdown(sym) : '')
          .filter(Boolean);
        const payload = `Symbol search results for \`${term}\` (${formatted.length}):\n` + formatted.join('\n');
        messages.push({
          role: 'assistant',
          content: context.deps.formatToolResultForUi
            ? context.deps.formatToolResultForUi('search', payload)
            : payload
        });
      } else {
        // Fallback to text search
        const searchArgs = { query: term, include: '**/*', exclude: '**/node_modules/**', maxResults: 20 };
        const textResults = context.deps.runToolWithSugar && context.deps.getToolRunner
          ? await context.deps.runToolWithSugar('search', searchArgs, () =>
              context.deps.getToolRunner().toolSearch(searchArgs)
            )
          : 'No results';
        const payload = `No code symbols found for \`${term}\`. Text search results:\n${textResults}`;
        messages.push({
          role: 'assistant',
          content: context.deps.formatToolResultForUi
            ? context.deps.formatToolResultForUi('search', payload)
            : payload
        });
      }
    }
    
    if (terms.length > maxTerms) {
      messages.push({
        role: 'assistant',
        content: context.deps.formatToolResultForUi
          ? context.deps.formatToolResultForUi('search', `Note: limited smart search to ${maxTerms} backtick terms.`)
          : `Note: limited smart search to ${maxTerms} backtick terms.`
      });
    }
    
    return messages;
  }
}

module.exports = { SmartSearchPhase };
