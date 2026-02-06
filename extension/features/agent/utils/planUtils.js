/**
 * Plan management utilities
 * Normalizes, merges, and manages plan items for planner/agent workflows
 */

/**
 * Normalize a single plan item
 * @param {*} item - Raw item (may be object or string)
 * @param {number} index - Index for generating default ID
 * @returns {object|null} Normalized item with id, text, status fields, or null if invalid
 */
function normalizePlanItem(item, index) {
  if (!item || typeof item !== 'object') {
    return { id: `plan_${index + 1}`, text: String(item || '').trim(), status: 'pending' };
  }
  const text = String(item.text || item.title || item.description || '').trim();
  if (!text) return null;
  const id = String(item.id || `plan_${index + 1}`);
  const statusRaw = String(item.status || '').toLowerCase();
  const status = statusRaw === 'done' || statusRaw === 'complete' ? 'done' : 'pending';
  return { id, text, status };
}

/**
 * Normalize an array of plan items
 * @param {Array} input - Raw plan items
 * @returns {Array} Normalized plan items
 */
function normalizePlanList(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item, index) => normalizePlanItem(item, index)).filter(Boolean);
}

/**
 * Get only pending (not done) plan items
 * @param {Array} plan - Plan list
 * @returns {Array} Pending plan items
 */
function getPendingPlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.filter((item) => item && item.status !== 'done');
}

/**
 * Merge incoming plan items with current list, preserving 'done' status
 * @param {Array} current - Current plan list
 * @param {Array} incoming - Incoming plan updates from LLM
 * @returns {Array} Merged plan list
 */
function mergePlanLists(current, incoming) {
  const next = normalizePlanList(incoming || []);
  if (!next.length) return normalizePlanList(current || []);
  const currentList = normalizePlanList(current || []);
  const currentById = new Map(currentList.map((item) => [String(item.id), item]));
  const currentByText = new Map(currentList.map((item) => [String(item.text).toLowerCase(), item]));

  const merged = next.map((item) => {
    const idKey = String(item.id);
    const textKey = String(item.text).toLowerCase();
    const existing = currentById.get(idKey) || currentByText.get(textKey);
    if (!existing) return item;
    const status = existing.status === 'done' || item.status === 'done' ? 'done' : 'pending';
    return { ...item, status };
  });

  for (const item of currentList) {
    if (item.status !== 'done') continue;
    const idKey = String(item.id);
    const textKey = String(item.text).toLowerCase();
    const exists = merged.some((entry) => String(entry.id) === idKey || String(entry.text).toLowerCase() === textKey);
    if (!exists) merged.push(item);
  }

  return merged;
}

/**
 * Build instruction text for planner mode that includes current plan status
 * @param {Array} plan - Current plan list
 * @returns {string} Instruction text for LLM, or empty string if no pending items
 */
function buildPlanInstruction(plan) {
  const pending = getPendingPlan(plan);
  if (!pending.length) {
    return '';
  }
  const list = plan.map((item, idx) => {
    const status = item.status === 'done' ? '✓' : '○';
    return `${status} ${idx + 1}. ${item.text}`;
  }).join('\n');
  const next = pending[0];
  return [
    'Current execution plan:',
    list,
    '',
    `Focus on next step: ${next.text}`,
    'Update plan with {"plan":[...]} including status changes when steps are completed.'
  ].join('\n');
}

module.exports = {
  normalizePlanItem,
  normalizePlanList,
  mergePlanLists,
  getPendingPlan,
  buildPlanInstruction
};
