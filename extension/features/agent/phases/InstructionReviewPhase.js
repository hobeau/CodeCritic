/**
 * InstructionReviewPhase - Custom instruction-based code review
 * 
 * This phase applies user-defined coding rules and guidelines from a custom instruction file.
 * It reviews code mutations against project-specific standards, conventions, and best practices.
 * 
 * Only runs if a custom instruction file is configured in settings.
 * Skips if no instruction file is defined or file doesn't exist.
 */

const { PhaseResult } = require('../PhaseResult');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;

class InstructionReviewPhase {
  /**
   * Execute instruction review phase
   * - Load custom instruction file
   * - Review code changes against custom rules
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

    // Skip if already in custom review to prevent infinite loops
    if (context.isInCustomReview) {
      return PhaseResult.continue();
    }

    const { parsed } = context.data || {};
    
    if (!parsed || !parsed.toolCalls || !parsed.toolCalls.length) {
      return PhaseResult.continue();
    }
    
    // Load custom instruction file
    const instructions = await this.loadInstructionFile();
    
    if (!instructions) {
      return PhaseResult.continue(); // No instructions configured, skip
    }
    
    // Identify code mutations that need review
    const codeMutations = this.identifyCodeMutations(parsed.toolCalls);
    
    if (!codeMutations.length) {
      return PhaseResult.continue(); // No code changes to review
    }
    
    // Build custom review prompt
    const reviewPrompt = this.buildReviewPrompt(codeMutations, instructions);
    
    // Add review request to model messages
    context.addModelMessage({ 
      role: 'user', 
      content: reviewPrompt 
    });
    
    // Mark as in custom review
    context.isInCustomReview = true;
    
    // Call LLM for custom review
    let reviewResponse;
    try {
      if (!context.deps.callLLM) {
        context.isInCustomReview = false;
        return PhaseResult.continue(); // No LLM available, skip review
      }
      
      reviewResponse = await context.deps.callLLM(
        context.modelMessages,
        context.mode
      );
    } catch (err) {
      // If review call fails, continue with original plan
      context.isInCustomReview = false;
      context.addUiMessage({
        role: 'assistant',
        content: `⚠️ Custom instruction review failed: ${err.message}. Proceeding with original changes.`
      });
      return PhaseResult.continue();
    }
    
    context.isInCustomReview = false;
    
    // Parse review result
    const review = this.parseReview(reviewResponse);
    
    if (review.approved) {
      // Code passed custom review
      context.addUiMessage({ 
        role: 'assistant', 
        content: '✓ Custom rules review passed. Code follows project guidelines.' 
      });
      
      // Add review response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reviewResponse
      });
      
      return PhaseResult.continue();
    }
    
    if (review.revisedToolCalls && review.revisedToolCalls.length) {
      // LLM provided version that follows guidelines
      context.data.parsed.toolCalls = review.revisedToolCalls;
      context.addUiMessage({ 
        role: 'assistant', 
        content: '⚠️ Custom rules review identified guideline violations. Applying corrected version.' 
      });
      
      // Add review response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reviewResponse
      });
      
      return PhaseResult.continue();
    }
    
    // If violations noted but no fix provided, warn and continue
    if (review.violations) {
      context.addUiMessage({ 
        role: 'assistant', 
        content: `⚠️ Custom rules violations detected: ${review.violations}` 
      });
      
      // Add review response to model history
      context.addModelMessage({
        role: 'assistant',
        content: reviewResponse
      });
    }
    
    return PhaseResult.continue();
  }

  /**
   * Load custom instruction file from settings
   * @private
   * @returns {Promise<string|null>} Instruction file content or null
   */
  async loadInstructionFile() {
    try {
      // Get configured instruction file path
      const config = vscode.workspace.getConfiguration('codeCritic');
      const instructionPath = config.get('codeReviewInstructionFile', '');
      
      if (!instructionPath || typeof instructionPath !== 'string') {
        return null; // No instruction file configured
      }
      
      // Resolve path relative to workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || !workspaceFolders.length) {
        return null; // No workspace open
      }
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const resolvedPath = path.isAbsolute(instructionPath) 
        ? instructionPath 
        : path.join(workspaceRoot, instructionPath);
      
      // Check if file exists
      try {
        await fs.access(resolvedPath);
      } catch {
        // File doesn't exist
        return null;
      }
      
      // Read instruction file
      const content = await fs.readFile(resolvedPath, 'utf8');
      
      if (!content || content.trim().length < 10) {
        return null; // Empty or too short
      }
      
      return content.trim();
      
    } catch (err) {
      // Silent fail - if we can't load instructions, just skip
      return null;
    }
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
   * Build review prompt with custom instructions
   * @private
   * @param {Array} codeMutations - Code mutation tool calls
   * @param {string} instructions - Custom instruction content
   * @returns {string} Review prompt
   */
  buildReviewPrompt(codeMutations, instructions) {
    const codeSnippets = codeMutations.map((call, i) => {
      const path = call.args?.path || call.args?.filePath || 'unknown';
      const content = call.args?.newText || call.args?.text || call.args?.content || '';
      const operation = call.tool === 'edit_file' ? 'Edit' : 
                       call.tool === 'write_file' ? 'Create' : 'Modify';
      
      return `${operation} ${i + 1}: ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``;
    }).join('\n\n');
    
    return `CUSTOM RULES REVIEW REQUEST: Review these code changes against the project's custom coding guidelines.

PROJECT CODING GUIDELINES:
${instructions}

PROPOSED CODE CHANGES:
${codeSnippets}

Verify that the code follows all rules and guidelines specified above. Check for:
- Compliance with naming conventions
- Adherence to code structure requirements
- Following specified patterns and practices
- Meeting documentation requirements
- Conforming to any project-specific rules

If the code follows all guidelines, respond with: {"approved": true, "reasoning": "brief explanation"}

If violations found, respond with revised tool calls that fix the violations, using the same JSON format as before.

If you detect violations but cannot fix them, respond with: {"violations": "description of guideline violations"}`;
  }

  /**
   * Parse review response
   * @private
   * @param {string} response - LLM review response
   * @returns {Object} Parsed review result
   */
  parseReview(response) {
    if (!response || typeof response !== 'string') {
      return { approved: true }; // Default to approval if no response
    }
    
    // Try to parse structured JSON response
    try {
      const parsed = JSON.parse(response);
      
      if (parsed.approved === true) {
        return { approved: true };
      }
      
      if (parsed.toolCalls && Array.isArray(parsed.toolCalls)) {
        return { revisedToolCalls: parsed.toolCalls };
      }
      
      if (parsed.violations) {
        return { violations: String(parsed.violations).slice(0, 300) };
      }
    } catch {
      // Not valid JSON, try other parsing strategies
    }
    
    // Check for approval keywords
    const approvalPatterns = [
      /follows?\s+(all\s+)?guidelines?/i,
      /compliant\s+with/i,
      /no\s+violations?/i,
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
        if (parsed.toolCalls && Array.isArray(parsed.toolCalls)) {
          return { revisedToolCalls: parsed.toolCalls };
        }
      } catch {
        // Failed to parse embedded tool calls
      }
    }
    
    // Check for violation keywords
    const violationPatterns = [
      /violation|violates/i,
      /does\s+not\s+follow/i,
      /missing|incorrect|wrong/i,
      /should|must|need to/i
    ];
    
    if (violationPatterns.some(pattern => pattern.test(response))) {
      return { violations: response.slice(0, 300) };
    }
    
    // Default to approval if no clear signal
    return { approved: true };
  }
}

module.exports = { InstructionReviewPhase };
