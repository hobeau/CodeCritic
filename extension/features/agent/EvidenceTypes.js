/**
 * EvidenceTypes - Evidence strength levels for ReAct completion detection
 */

/**
 * Evidence strength levels (hierarchical)
 * Higher values indicate stronger evidence of task completion
 */
const EvidenceStrength = {
  NONE: 0,        // No evidence collected
  WEAK: 1,        // Code review only, "looks good"
  MEDIUM: 2,      // Builds succeed, diagnostics clean
  STRONG: 3,      // Tests pass + diagnostics clean
  STRONGEST: 4    // Full suite + diff review + repro works
};

/**
 * Evidence type categories
 */
const EvidenceType = {
  TEST: 'test',
  BUILD: 'build',
  DIAGNOSTIC: 'diagnostic',
  REPRO: 'repro',
  DIFF: 'diff'
};

/**
 * Get human-readable label for evidence strength
 * @param {number} strength - Evidence strength level
 * @returns {string}
 */
function getStrengthLabel(strength) {
  switch (strength) {
    case EvidenceStrength.NONE: return 'None';
    case EvidenceStrength.WEAK: return 'Weak';
    case EvidenceStrength.MEDIUM: return 'Medium';
    case EvidenceStrength.STRONG: return 'Strong';
    case EvidenceStrength.STRONGEST: return 'Strongest';
    default: return 'Unknown';
  }
}

/**
 * Check if evidence strength meets minimum requirement
 * @param {number} current - Current evidence strength
 * @param {number} required - Required minimum strength
 * @returns {boolean}
 */
function meetsRequirement(current, required) {
  return current >= required;
}

module.exports = {
  EvidenceStrength,
  EvidenceType,
  getStrengthLabel,
  meetsRequirement
};
