/**
 * MarkdownPlanUpdatePhase - Apply structured plan updates to the markdown plan contract
 *
 * Expects parsed.planUpdate with shape:
 * {
 *   acceptanceChecks?: [{ text: string, checked: boolean }],
 *   tasks?: [{ id: string, checked: boolean }],
 *   findings?: { entryPoints?, dataFlow?, invariants?, assumptions?, openQuestions? },
 *   progressLogEntry?: string,
 *   // NEW: Structural plan modifications (continuous plan refinement)
 *   addTasks?: [{ title: string, description?: string, doneWhen: string }],
 *   removeTasks?: [string], // Task IDs to soft-delete
 *   reviseAcceptanceChecks?: [{ action: 'add'|'remove'|'revise', originalText?: string, newText?: string }]
 * }
 */

const { PhaseResult } = require('../PhaseResult');
const { 
  addProgressLogEntry, 
  updateFindings,
  addTask,
  removeTask,
  addAcceptanceCheck,
  removeAcceptanceCheck,
  reviseAcceptanceCheck
} = require('../utils/MarkdownPlanManager');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

class MarkdownPlanUpdatePhase {
  async execute(context) {
    // Only meaningful once a markdown plan exists.
    const parsedPlan = context.getParsedPlan && context.getParsedPlan();
    if (!parsedPlan) return PhaseResult.continue();

    const parsed = context.data && context.data.parsed ? context.data.parsed : null;
    const planUpdate = parsed && parsed.planUpdate && typeof parsed.planUpdate === 'object'
      ? parsed.planUpdate
      : null;

    if (!planUpdate) return PhaseResult.continue();
    const baseData = context.data && typeof context.data === 'object' ? context.data : {};

    let changed = false;

    // Acceptance checks
    if (Array.isArray(planUpdate.acceptanceChecks)) {
      if (!Array.isArray(parsedPlan.acceptanceChecks)) parsedPlan.acceptanceChecks = [];

      for (const update of planUpdate.acceptanceChecks) {
        if (!update || typeof update.text !== 'string') continue;
        const needle = normalizeText(update.text);
        if (!needle) continue;
        const existing = parsedPlan.acceptanceChecks.find((c) => normalizeText(c && c.text) === needle);
        if (existing) {
          if (typeof update.checked === 'boolean' && existing.checked !== update.checked) {
            existing.checked = update.checked;
            changed = true;
          }
        } else {
          parsedPlan.acceptanceChecks.push({
            text: update.text.trim(),
            checked: Boolean(update.checked)
          });
          changed = true;
        }
      }
    }

    // Tasks
    if (Array.isArray(planUpdate.tasks) && Array.isArray(parsedPlan.tasks)) {
      for (const update of planUpdate.tasks) {
        if (!update || typeof update.id !== 'string') continue;
        const task = parsedPlan.tasks.find((t) => t && String(t.id) === String(update.id));
        if (!task) continue;
        if (typeof update.checked === 'boolean' && task.checked !== update.checked) {
          task.checked = update.checked;
          changed = true;
        }
      }
    }

    // Findings
    if (planUpdate.findings && typeof planUpdate.findings === 'object') {
      const fields = ['entryPoints', 'dataFlow', 'invariants', 'assumptions', 'openQuestions'];
      for (const field of fields) {
        if (!(field in planUpdate.findings)) continue;
        const value = planUpdate.findings[field];
        if (typeof value !== 'string') continue;
        updateFindings(parsedPlan, field, value);
        changed = true;
      }
    }

    // Progress log entry
    if (typeof planUpdate.progressLogEntry === 'string' && planUpdate.progressLogEntry.trim()) {
      const entry = planUpdate.progressLogEntry.trim();
      const { plan: updatedPlan } = addProgressLogEntry(parsedPlan, entry);
      if (updatedPlan) {
        changed = true;
      }
    }

    // NEW: Structural plan modifications (continuous plan refinement)
    
    // Add new tasks
    if (Array.isArray(planUpdate.addTasks)) {
      for (const taskSpec of planUpdate.addTasks) {
        try {
          addTask(parsedPlan, taskSpec);
          changed = true;
        } catch (err) {
          // Log error but continue processing other updates
          console.warn('Failed to add task:', err.message);
        }
      }
    }

    // Remove tasks (soft-delete with [REMOVED] prefix)
    if (Array.isArray(planUpdate.removeTasks)) {
      for (const taskId of planUpdate.removeTasks) {
        try {
          removeTask(parsedPlan, taskId);
          changed = true;
        } catch (err) {
          console.warn('Failed to remove task:', err.message);
        }
      }
    }

    // Revise acceptance checks (add/remove/revise)
    if (Array.isArray(planUpdate.reviseAcceptanceChecks)) {
      for (const revision of planUpdate.reviseAcceptanceChecks) {
        const { action, originalText, newText } = revision;
        
        try {
          if (action === 'add' && newText) {
            addAcceptanceCheck(parsedPlan, newText);
            changed = true;
          } else if (action === 'remove' && originalText) {
            removeAcceptanceCheck(parsedPlan, originalText);
            changed = true;
          } else if (action === 'revise' && originalText && newText) {
            reviseAcceptanceCheck(parsedPlan, originalText, newText);
            changed = true;
          }
        } catch (err) {
          console.warn('Failed to revise acceptance check:', err.message);
        }
      }
    }

    if (changed && typeof context.updateParsedPlan === 'function') {
      context.updateParsedPlan(parsedPlan);
    }

    return PhaseResult.continue({ ...baseData, planUpdated: changed });
  }
}

module.exports = { MarkdownPlanUpdatePhase };
