/**
 * ExplorationSummaryPhase - Summarize exploration findings before plan generation
 *
 * Responsibilities:
 * - Call LLM once (no tool calls) to produce a structured summary
 * - Store summary in context.explorationSummary
 * - Add a short UI message for user visibility
 */

const { PhaseResult } = require('../PhaseResult');

function safeJsonParse(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function compact(value, maxLen = 300) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen - 3) + '...';
}

class ExplorationSummaryPhase {
  async execute(context) {
    context.setStage('plan');

    const prompt =
`[[STAGE:PLAN]]
Create a concise **exploration summary** based on the tool outputs and observations so far.

Respond with JSON only in this exact shape:
{
  "explorationSummary": {
    "keyFiles": ["path1", "path2"],
    "entryPoints": "brief",
    "dataFlow": "brief",
    "invariants": "brief",
    "assumptions": "brief",
    "openQuestions": "brief"
  },
  "text": "1–2 sentence summary for the user"
}

Rules:
- Do NOT include toolCalls.
- Keep each field short and concrete (file paths + function names when possible).`;

    context.addModelMessage({ role: 'user', content: prompt });

    if (!context.deps.callLLM) {
      return PhaseResult.continue();
    }

    let response = '';
    try {
      response = await context.deps.callLLM(context.modelMessages, context.mode);
    } catch (err) {
      context.addUiMessage({
        role: 'assistant',
        content: `⚠️ Exploration summary failed: ${String(err && err.message ? err.message : err)}`
      });
      return PhaseResult.continue();
    }

    context.addModelMessage({ role: 'assistant', content: response });

    const parsed = safeJsonParse(response);
    const summary = parsed && parsed.explorationSummary && typeof parsed.explorationSummary === 'object'
      ? parsed.explorationSummary
      : null;

    context.explorationSummary = summary || { raw: compact(response, 1200) };

    const keyFiles = Array.isArray(summary && summary.keyFiles) ? summary.keyFiles.filter(Boolean) : [];
    const userText = parsed && typeof parsed.text === 'string' ? parsed.text : '';

    const uiLines = [
      '**Exploration Summary**',
      userText ? compact(userText, 400) : '',
      keyFiles.length ? `- Key files: ${compact(keyFiles.slice(0, 6).join(', '), 400)}` : '',
      summary && summary.entryPoints ? `- Entry points: ${compact(summary.entryPoints, 400)}` : '',
      summary && summary.invariants ? `- Invariants: ${compact(summary.invariants, 400)}` : ''
    ].filter(Boolean);

    context.addUiMessage({
      role: 'assistant',
      content: uiLines.join('\n')
    });

    return PhaseResult.continue({ explorationSummary: context.explorationSummary });
  }
}

module.exports = { ExplorationSummaryPhase };
