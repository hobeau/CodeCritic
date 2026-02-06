/**
 * ExecutionInitializationPhase - Transition from plan to execution (mutations allowed)
 *
 * Responsibilities:
 * - Set context.stage = 'execute'
 * - Add a clear model instruction that exploration read-only rules no longer apply
 * - Optionally surface scope/constraints + known diagnostics to guide the first edit
 */

const { PhaseResult } = require('../PhaseResult');
const { AGENT_TOOL_NAMES, CHAT_TOOL_NAMES } = require('../../../helpers/prompts');

// Mutation tools = agent tools minus read-only chat tools
const MUTATION_TOOL_NAMES = AGENT_TOOL_NAMES.filter(t => !CHAT_TOOL_NAMES.includes(t));

function compactLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function formatDiagnosticsHint(context) {
  const diag = context?.baseline?.diagnostics || context?.currentEvidence?.diagnostics;
  const problems = Array.isArray(diag?.problems) ? diag.problems.filter(Boolean) : [];
  if (!problems.length) return '';
  const sample = problems.slice(0, 6).join('\n- ');
  // Extract error line numbers to suggest a single wide edit range
  const lineNumbers = problems
    .map(p => { const m = /:(\d+):\d+/.exec(p); return m ? Number(m[1]) : 0; })
    .filter(n => n > 0);
  const minLine = lineNumbers.length ? Math.max(1, Math.min(...lineNumbers) - 3) : 0;
  const maxLine = lineNumbers.length ? Math.max(...lineNumbers) + 5 : 0;
  const rangeHint = minLine && maxLine
    ? `\nTip: Cover lines ${minLine}-${maxLine} in a single edit_file call to fix all related issues at once. Set newText to the complete corrected code for that range.`
    : '';
  return `Known diagnostics to address:\n- ${sample}${rangeHint}`;
}

class ExecutionInitializationPhase {
  async execute(context) {
    if (typeof context.setStage === 'function') {
      context.setStage('execute');
    }

    context.addUiMessage({
      role: 'assistant',
      content: '**Stage: Execute** (mutations allowed)'
    });

    const plan = typeof context.getParsedPlan === 'function' ? context.getParsedPlan() : null;
    const scope = plan?.header?.scope ? `Scope boundaries: ${plan.header.scope}` : '';
    const constraints = plan?.header?.constraints ? `Constraints: ${plan.header.constraints}` : '';
    const requested = Array.isArray(context.requestedFilePaths) && context.requestedFilePaths.length
      ? context.requestedFilePaths[0]
      : '';
    const diagnosticsHint = formatDiagnosticsHint(context);

    const instruction = compactLines([
      '[[STAGE:EXECUTE]]',
      'You are now in the **EXECUTION** stage. The exploration read-only rules no longer apply.',
      '',
      `You may use mutation tools (${MUTATION_TOOL_NAMES.join(', ')}) if required by the plan.`,
      'You may include multiple tool calls in a single response when fixing multiple issues. Respond with JSON only.',
      '',
      requested ? `The file to edit is: ${requested}. If you read the relevant regions during exploration, proceed directly with edit_file. If you need to see more context around other errors, you may read_file first.` : '',
      scope,
      constraints,
      diagnosticsHint,
      '',
      'Begin execution now. Use edit_file (or another mutation tool) as your first action if the fix is already known from exploration.'
    ]);

    context.addModelMessage({
      role: 'user',
      content: instruction
    });

    return PhaseResult.continue();
  }
}

module.exports = { ExecutionInitializationPhase };
