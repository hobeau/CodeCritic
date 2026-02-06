/**
 * ExplorationInitializationPhase - Initialize pre-plan exploration stage (read-only)
 *
 * Responsibilities:
 * - Set context.stage = 'explore'
 * - Extract user request and requested file hints
 * - Seed the model with an exploration contract (read/search only, 1 tool call)
 */

const { PhaseResult } = require('../PhaseResult');
const { CHAT_TOOL_NAMES } = require('../../../helpers/prompts');
const {
  extractLastUserRequest,
  extractRequestedFilePathsFromText,
  extractRequestedFilePathsFromMessages
} = require('../utils/requestUtils');

class ExplorationInitializationPhase {
  async execute(context) {
    context.setStage('explore');

    const prePlanMaxSteps = context.deps.getAgentPrePlanMaxSteps
      ? context.deps.getAgentPrePlanMaxSteps()
      : 3;
    context.initializePrePlan(prePlanMaxSteps);

    const userRequest = extractLastUserRequest(context);
    context.setUserRequest(userRequest);

    const requestedFromPrompt = extractRequestedFilePathsFromText(userRequest);
    const requestedFromMessages = extractRequestedFilePathsFromMessages(context);
    context.requestedFilePaths = Array.from(new Set([...requestedFromPrompt, ...requestedFromMessages]));

    context.addUiMessage({
      role: 'assistant',
      content: `**Stage: Explore** (read-only, up to ${context.prePlanMaxSteps} step(s))`
    });

    // Extract ALL diagnostics from initial user messages to provide targeted hints
    const diagnosticHints = this._extractAllDiagnosticHints(context);
    
    const hintPath = Array.isArray(context.requestedFilePaths) && context.requestedFilePaths.length
      ? context.requestedFilePaths[0]
      : (diagnosticHints.length ? diagnosticHints[0].path : '');
    
    let firstActionHint;
    if (diagnosticHints.length > 0) {
      // Compute a read range that covers ALL diagnostic locations in the same file
      const samePath = diagnosticHints.filter(h => h.path === diagnosticHints[0].path);
      const minLine = Math.min(...samePath.map(h => h.line));
      const maxLine = Math.max(...samePath.map(h => h.line));
      const readStart = Math.max(1, minLine - 10);
      const readEnd = maxLine + 10;
      const diagSummary = samePath.map(h => `${h.path}:${h.line} (${h.message})`).join('; ');
      firstActionHint = `Workspace diagnostics report ${samePath.length} issue(s): ${diagSummary}. Read the file region covering all errors (lines ${readStart}-${readEnd}), then signal readyForPlan.`;
    } else if (hintPath) {
      firstActionHint = `Start by reading ${hintPath} (use locate_file first if it's a bare filename).`;
    } else {
      firstActionHint = 'Start by locating the most relevant files (use locate_file/search/workspace_symbols).';
    }

    context.addModelMessage({
      role: 'user',
      content:
`[[STAGE:EXPLORE]]
You are in the pre-plan **EXPLORATION** stage. Your goal is to gather key context before generating an execution plan.

Rules:
- Use **read/search** tools only. No code mutations. No run_command.
- Respond with **JSON only**. Do NOT use "**Action**:" lines or markdown formatting.
- Your entire response must be a single JSON object parseable by JSON.parse.
- Include a brief \`text\` field (1–3 sentences) describing your intent.
- Either:
  - propose exactly **one** tool call in \`toolCalls\`, OR
  - signal \`"readyForPlan": true\` once you have enough context.
- If you have already read the relevant diagnostic region, signal readyForPlan immediately.

Allowed tools in exploration: ${CHAT_TOOL_NAMES.join(', ')}.

User request:
${userRequest || '(empty request)'}

${firstActionHint}`
    });

    return PhaseResult.continue();
  }

  /**
   * Extract ALL diagnostic hints from initial messages.
   * @private
   * @returns {Array<{path: string, line: number, col: number, message: string}>}
   */
  _extractAllDiagnosticHints(context) {
    const messages = context.modelMessages || [];
    const hints = [];
    
    for (const msg of messages) {
      const content = msg.content || '';
      if (!content.includes('Workspace Errors')) continue;
      
      // Match ALL diagnostics: path:line:col [type] (code) - message
      const regex = /([^:\s]+):(\d+):(\d+)\s+\[[^\]]+\]\s+\(\d+\)\s*-\s*(.+)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        hints.push({
          path: match[1],
          line: parseInt(match[2], 10),
          col: parseInt(match[3], 10),
          message: match[4].trim()
        });
      }
    }
    
    return hints;
  }
}

module.exports = { ExplorationInitializationPhase };
