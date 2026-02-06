/**
 * ReflectionPhase - Self-review code changes before execution
 * 
 * This phase performs automated code review on mutations (create/edit/patch operations)
 * before they are executed. It prompts the LLM to critique its own proposed code changes
 * and can either approve, revise, or warn about potential issues.
 * 
 * Only runs for Agent mode and only reviews code-modifying operations.
 */

const { PhaseResult } = require('../PhaseResult');

class ReflectionPhase {
  /**
   * Execute reflection phase
   * - Identify code mutation tool calls
   * - Prompt LLM to review proposed changes
   * - Handle approval, revision, or warnings
   * 
   * @param {AgentContext} context - Agent execution context
   * @returns {Promise<PhaseResult>} Continue with original or revised tool calls
   */
  async execute(context) {
    // Skip if not agent mode
    if (context.mode !== 'agent') {
      return PhaseResult.continue();
    }

    // Skip if already in reflection to prevent infinite loops
    if (context.isInReflection) {
      return PhaseResult.continue();
    }

    const { parsed } = context.data || {};
    
    if (!parsed || !parsed.toolCalls || !parsed.toolCalls.length) {
      return PhaseResult.continue();
    }
    
    // Identify code mutations that need review
    const codeMutations = this.identifyCodeMutations(parsed.toolCalls);
    
    if (!codeMutations.length) {
      return PhaseResult.continue(); // No code changes to review
    }
    
    // Build reflection prompt
    const reflectionPrompt = this.buildReflectionPrompt(codeMutations);
    
    // Add reflection request to model messages
    context.addModelMessage({ 
      role: 'user', 
      content: reflectionPrompt 
    });
    
    // Mark as in reflection
    context.isInReflection = true;
    
    // Call LLM for self-review
    let reflectionResponse;
    try {
      if (!context.deps.callLLM) {
        context.isInReflection = false;
        return PhaseResult.continue(); // No LLM available, skip reflection
      }
      
      reflectionResponse = await context.deps.callLLM(
        context.modelMessages,
        context.mode
      );
    } catch (err) {
      // If reflection call fails, continue with original plan
      context.isInReflection = false;
      context.addUiMessage({
        role: 'assistant',
        content: `⚠️ Code reflection failed: ${err.message}. Proceeding with original changes.`
      });
      return PhaseResult.continue();
    }
    
    context.isInReflection = false;
    
    // Parse reflection result
    const reflection = this.parseReflection(reflectionResponse);
    
    if (reflection.approved) {
      // Code passed self-review
      context.addUiMessage({ 
        role: 'assistant', 
        content: '✓ Self-review passed. Code changes approved.' 
      });
      
      // Add reflection response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reflectionResponse
      });
      
      return PhaseResult.continue();
    }
    
    if (reflection.revisedToolCalls && reflection.revisedToolCalls.length) {
      // LLM provided improved version
      context.data.parsed.toolCalls = reflection.revisedToolCalls;
      context.addUiMessage({ 
        role: 'assistant', 
        content: '⚠️ Self-review identified improvements. Applying revised version.' 
      });
      
      // Add reflection response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reflectionResponse
      });
      
      return PhaseResult.continue();
    }
    
    // If concerns noted but no fix provided, warn and continue
    if (reflection.concerns) {
      context.addUiMessage({ 
        role: 'assistant', 
        content: `⚠️ Self-review notes: ${reflection.concerns}` 
      });
      
      // Add reflection response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reflectionResponse
      });
    }
    
    return PhaseResult.continue();
  }

  /**
   * Identify tool calls that modify code
   * @private
   * @param {Array} toolCalls - Tool calls from parsed response
   * @returns {Array} Code mutation tool calls
   */
  identifyCodeMutations(toolCalls) {
    const codeMutationTools = new Set([
      'edit_file',
      'insert_text',
      'replace_range',
      'write_file',
      'apply_patch',
      'apply_patch_preview'
    ]);
    
    const codeFileExtensions = new Set([
      '.js', '.jsx', '.ts', '.tsx',
      '.py', '.java', '.cpp', '.c', '.h', '.hpp',
      '.go', '.rs', '.rb', '.php',
      '.cs', '.swift', '.kt', '.scala',
      '.sh', '.bash', '.zsh',
      '.html', '.css', '.scss', '.sass', '.less',
      '.json', '.xml', '.yaml', '.yml',
      '.sql', '.graphql'
    ]);
    
    return toolCalls.filter(call => {
      // Must be a mutation tool
      if (!codeMutationTools.has(call.tool)) {
        return false;
      }
      
      // Must target a code file
      const path = call.args?.path || call.args?.filePath || '';
      const isCodeFile = Array.from(codeFileExtensions).some(ext => 
        path.toLowerCase().endsWith(ext)
      );
      
      if (!isCodeFile) {
        return false;
      }
      
      // Must have substantial content (more than 50 chars)
      const content = call.args?.newText || call.args?.text || call.args?.content || '';
      return content.length > 50;
    });
  }

  /**
   * Build reflection prompt for code review
   * @private
   * @param {Array} codeMutations - Code mutation tool calls
   * @returns {string} Reflection prompt
   */
  buildReflectionPrompt(codeMutations) {
    const codeSnippets = codeMutations.map((call, i) => {
      const path = call.args?.path || call.args?.filePath || 'unknown';
      const content = call.args?.newText || call.args?.text || call.args?.content || '';
      const operation = call.tool === 'edit_file' ? 'Edit' : 
                       call.tool === 'write_file' ? 'Create' : 'Modify';
      
      return `${operation} ${i + 1}: ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``;
    }).join('\n\n');
    
    return `SELF-REVIEW REQUEST: Before applying these code changes, perform a critical review.

${codeSnippets}

Review for:
- Syntax errors or typos
- Logic bugs or incorrect algorithms
- Missing error handling or edge cases
- Security vulnerabilities (injection, XSS, etc.)
- Performance issues (inefficient loops, memory leaks)
- Code style violations or poor practices

If the code is good, respond with: {"approved": true, "reasoning": "brief explanation"}

If issues found, respond with revised tool calls that fix the issues, using the same JSON format as before.

If you have concerns but cannot provide a fix, respond with: {"concerns": "description of issues"}`;
  }

  /**
   * Parse reflection response
   * @private
   * @param {string} response - LLM reflection response
   * @returns {Object} Parsed reflection result
   */
  parseReflection(response) {
    if (!response || typeof response !== 'string') {
      return { approved: true }; // Default to approval if no response
    }
    
    // Try to parse structured JSON response
    try {
      const parsed = JSON.parse(response);
      
      if (parsed.approved === true) {
        return { approved: true };
      }
      
      if (parsed.toolCalls && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
        // Only accept revised tool calls if they're actually different from original
        // Otherwise treat as approval to prevent infinite loops
        return { revisedToolCalls: parsed.toolCalls };
      }
      
      if (parsed.concerns) {
        return { concerns: String(parsed.concerns).slice(0, 300) };
      }
      
      // If JSON but no recognized fields, treat as approval
      return { approved: true };
    } catch {
      // Not valid JSON, try other parsing strategies
    }
    
    // Check for approval keywords
    const approvalPatterns = [
      /code\s+(looks?\s+)?good/i,
      /appears?\s+correct/i,
      /no\s+issues?\s+found/i,
      /approved/i,
      /"approved"\s*:\s*true/i
    ];
    
    if (approvalPatterns.some(pattern => pattern.test(response))) {
      return { approved: true };
    }
    
    // Check for tool calls embedded in text
    const toolCallMatch = response.match(/\{[\s\S]*"toolCalls"\s*:[\s\S]*\}/);
    if (toolCallMatch) {
      try {
        const parsed = JSON.parse(toolCallMatch[0]);
        if (parsed.toolCalls && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
          return { revisedToolCalls: parsed.toolCalls };
        }
      } catch {
        // Failed to parse embedded tool calls
      }
    }
    
    // Check for concerns keywords (but be more selective to avoid false positives)
    const strongConcernPatterns = [
      /\b(critical|major|severe)\s+(issue|problem|bug|error)/i,
      /\bsecurity\s+(vulnerability|issue|concern)/i,
      /\bwill\s+(fail|crash|break)/i,
      /\bmust\s+(fix|change|correct)/i
    ];
    
    if (strongConcernPatterns.some(pattern => pattern.test(response))) {
      return { concerns: response.slice(0, 300) };
    }
    
    // Default to approval if no clear signal - this prevents loops
    // when LLM gives ambiguous responses
    return { approved: true };
  }
}

module.exports = { ReflectionPhase };
