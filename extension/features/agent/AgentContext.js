/**
 * AgentContext - Encapsulates all state and dependencies for agent execution
 * Provides a clean interface for phases to access state and invoke dependencies
 * Extends BaseContext with agent-specific features (deduplication, mutation tracking)
 */

const { BaseContext } = require('./BaseContext');
const { EvidenceStrength } = require('./EvidenceTypes');

class AgentContext extends BaseContext {
  /**
   * @param {object} options - Context configuration
   * @param {Array} options.baseMessages - Initial messages for UI
   * @param {Array} options.modelMessages - Messages for model context
   * @param {object} options.deps - Injected dependencies
   */
  constructor(options) {
    super({ ...options, mode: 'agent' });
    
    // Agent loop stage: explore → plan → execute
    this.stage = 'init';
    this.userRequest = null;
    this.prePlanStep = 0;
    this.prePlanMaxSteps = 0;
    this.prePlanHasSuccessfulAction = false;
    this.explorationSummary = null;
    this.explorationTruncated = false;

    // Agent-specific: Deduplication state
    this.lastCommandSignature = null;
    this.sawMutationSinceCommand = false;
    this.lastSearchSignature = null;
    this.sawSearchMiss = false;
    this.sawMutationSinceSearch = false;
    this.problemsCollected = false;
    
    // ReAct + Markdown Plan state
    this.markdownPlan = null;            // Raw markdown plan string
    this.parsedPlan = null;              // Parsed plan structure
    this.planDisplayed = false;          // Whether plan was shown to user
    this.currentPhase = null;            // Current phase (A-H)
    this.awaitingHumanInput = false;     // Paused for human response
    this.pendingQuestion = null;         // Question for human
    this.requestedFilePaths = [];        // File paths inferred from user request
    
    // ReAct + Evidence Ladder state (legacy compatibility)
    this.completionContract = null;      // Extracted completion criteria
    this.baseline = null;                // Initial test/build/diagnostic state
    this.evidenceLog = [];               // History of evidence collection
    this.currentEvidence = null;         // Latest evidence snapshot
    this.evidenceStale = true;           // Whether evidence needs refresh

    // Read-before-write gating: track file reads/writes by tool execution sequence
    this.actionSeq = 0;
    this.lastReadStepByPath = Object.create(null);
    this.lastWriteStepByPath = Object.create(null);

    // Exploration read tracking: used by ActionPolicyPhase auto-readyForPlan heuristic
    // and AgentStrategy confidence-based exploration exit
    this.readActions = Object.create(null);
  }

  /**
   * Set current agent stage (explore | plan | execute)
   * @param {string} stage
   */
  setStage(stage) {
    const nextStage = String(stage || '').trim() || 'init';
    const prevStage = this.stage;
    if (prevStage && prevStage !== nextStage) {
      this.pruneStageInstructions(nextStage);
    }
    this.stage = nextStage;
  }

  /**
   * Prune stage-specific instruction messages from prior stages.
   * Keeps messages for the current stage to avoid removing active contracts.
   * @param {string} keepStage
   */
  pruneStageInstructions(keepStage) {
    const keep = String(keepStage || '').trim() || 'init';
    const stageMarkers = {
      explore: [
        '[[STAGE:EXPLORE]]',
        'pre-plan **EXPLORATION** stage',
        'Allowed tools in exploration:',
        'Use **read/search** tools only. No code mutations. No run_command.'
      ],
      plan: [
        '[[STAGE:PLAN]]',
        'Create a concise **exploration summary**'
      ],
      execute: [
        '[[STAGE:EXECUTE]]',
        'You are now in the **EXECUTION** stage.'
      ]
    };

    const shouldRemove = (content) => {
      if (!content) return false;
      for (const [stage, markers] of Object.entries(stageMarkers)) {
        if (stage === keep) continue;
        if (markers.some((marker) => content.includes(marker))) {
          return true;
        }
      }
      return false;
    };

    this.modelMessages = this.modelMessages.filter((msg) => {
      if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return true;
      return !shouldRemove(msg.content);
    });
  }

  /**
   * Initialize pre-plan exploration budget and state
   * @param {number} maxSteps
   */
  initializePrePlan(maxSteps) {
    const raw = Number(maxSteps || 0);
    this.prePlanMaxSteps = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.floor(raw))) : 3;
    this.prePlanStep = 0;
    this.prePlanHasSuccessfulAction = false;
    this.explorationTruncated = false;
  }

  incrementPrePlanStep() {
    this.prePlanStep += 1;
    return this.prePlanStep;
  }

  markPrePlanSuccessfulAction() {
    this.prePlanHasSuccessfulAction = true;
  }

  setUserRequest(text) {
    const raw = typeof text === 'string' ? text : String(text || '');
    this.userRequest = raw;
  }

  incrementActionSeq() {
    this.actionSeq += 1;
    return this.actionSeq;
  }

  normalizeTrackedPath(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/');
    return normalized.replace(/^\.\//, '');
  }

  recordFileRead(path) {
    const key = this.normalizeTrackedPath(path);
    if (!key) return;
    this.lastReadStepByPath[key] = this.actionSeq;
    this.readActions[key] = this.actionSeq;
  }

  recordFileWrite(path) {
    const key = this.normalizeTrackedPath(path);
    if (!key) return;
    this.lastWriteStepByPath[key] = this.actionSeq;
  }

  /**
   * Returns true if the file has been read since the last successful write.
   * If the file has never been written, a prior read is still required.
   * @param {string} path
   * @returns {boolean}
   */
  hasReadSinceLastWrite(path) {
    const key = this.normalizeTrackedPath(path);
    if (!key) return false;
    const lastRead = this.lastReadStepByPath[key];
    if (!Number.isFinite(lastRead)) return false;
    const lastWrite = this.lastWriteStepByPath[key];
    if (!Number.isFinite(lastWrite)) return true;
    return lastRead > lastWrite;
  }

  /**
   * Set the markdown plan and parse it
   * @param {string} markdown - Raw markdown plan
   */
  setMarkdownPlan(markdown) {
    const { parseMarkdownPlan } = require('./utils/MarkdownPlanManager');
    this.markdownPlan = markdown;
    this.parsedPlan = parseMarkdownPlan(markdown);
  }

  /**
   * Get the parsed plan structure
   * @returns {object} Parsed plan
   */
  getParsedPlan() {
    return this.parsedPlan;
  }

  /**
   * Update the parsed plan and regenerate markdown
   * @param {object} updatedPlan - Updated plan structure
   */
  updateParsedPlan(updatedPlan) {
    const { buildMarkdownPlan } = require('./utils/MarkdownPlanManager');
    this.parsedPlan = updatedPlan;
    this.markdownPlan = buildMarkdownPlan(updatedPlan);
    
    // Sync to chatState for UI rendering
    const chatState = this.getChatState();
    if (chatState) {
      chatState.markdownPlan = this.markdownPlan;
    }
  }

  /**
   * Mark that the plan was displayed to the user
   */
  markPlanDisplayed() {
    this.planDisplayed = true;
  }

  /**
   * Set current execution phase (A-H)
   * @param {string} phase - Phase identifier
   */
  setCurrentPhase(phase) {
    this.currentPhase = phase;
  }

  /**
   * Set awaiting human input state with question
   * @param {string} question - Question for human
   */
  setAwaitingHumanInput(question) {
    this.awaitingHumanInput = true;
    this.pendingQuestion = question;
  }

  /**
   * Clear awaiting human input state
   */
  clearAwaitingHumanInput() {
    this.awaitingHumanInput = false;
    this.pendingQuestion = null;
  }

  /**
   * Track command signature for deduplication
   * @param {string} signature - Command signature
   */
  trackCommandSignature(signature) {
    this.lastCommandSignature = signature;
    this.sawMutationSinceCommand = false;
  }

  /**
   * Mark that a mutation occurred
   */
  markMutation() {
    this.sawMutationSinceCommand = true;
    this.sawMutationSinceSearch = true;
    this.evidenceStale = true;  // Evidence needs refresh after mutations
  }

  /**
   * Check if command is duplicate (same command without mutations)
   * @param {string} signature - Command signature
   * @returns {boolean}
   */
  isDuplicateCommand(signature) {
    return this.lastCommandSignature === signature && !this.sawMutationSinceCommand;
  }

  /**
   * Track search signature for deduplication
   * @param {string} signature - Search signature
   * @param {boolean} wasMiss - Whether search had no results
   */
  trackSearchSignature(signature, wasMiss) {
    this.lastSearchSignature = signature;
    this.sawSearchMiss = wasMiss;
    this.sawMutationSinceSearch = false;
  }

  /**
   * Check if search is duplicate (same search without mutations)
   * @param {string} signature - Search signature
   * @returns {boolean}
   */
  isDuplicateSearch(signature) {
    return this.lastSearchSignature === signature && !this.sawMutationSinceSearch && this.sawSearchMiss;
  }

  /**
   * Mark that workspace problems were collected
   */
  markProblemsCollected() {
    this.problemsCollected = true;
  }

  /**
   * Check if workspace problems were already collected
   * @returns {boolean}
   */
  wereProblemsCollected() {
    return this.problemsCollected;
  }

  /**
   * Mark evidence as stale (needs refresh)
   */
  markEvidenceStale() {
    this.evidenceStale = true;
  }

  /**
   * Record evidence in log and set as current
   * @param {object} evidence - Evidence snapshot
   */
  recordEvidence(evidence) {
    this.currentEvidence = evidence;
    this.evidenceStale = false;
    this.evidenceLog.push({
      step: this.step,
      timestamp: Date.now(),
      ...evidence
    });
  }

  /**
   * Get evidence strength based on current evidence
   * @returns {number} EvidenceStrength level
   */
  getEvidenceStrength() {
    if (!this.currentEvidence) return EvidenceStrength.NONE;
    
    const { tests, build, diagnostics } = this.currentEvidence;
    
    // Strongest: tests pass + build succeeds + diagnostics clean
    if (tests?.passed && build?.success && diagnostics?.clean) {
      return EvidenceStrength.STRONGEST;
    }
    
    // Strong: tests pass + diagnostics clean
    if (tests?.passed && diagnostics?.clean) {
      return EvidenceStrength.STRONG;
    }
    
    // Medium: build succeeds or diagnostics clean
    if (build?.success || diagnostics?.clean) {
      return EvidenceStrength.MEDIUM;
    }
    
    // Weak: some evidence collected but not conclusive
    if (tests || build || diagnostics) {
      return EvidenceStrength.WEAK;
    }
    
    return EvidenceStrength.NONE;
  }

  /**
   * Set completion contract
   * @param {object} contract - Completion contract
   */
  setContract(contract) {
    this.completionContract = contract;
  }

  /**
   * Set baseline state
   * @param {object} baseline - Baseline snapshot
   */
  setBaseline(baseline) {
    this.baseline = baseline;
  }

  /**
   * Get a summary object for the current context state (for debugging/logging)
   * @returns {object} Context summary
   */
  getSummary() {
    return {
      ...super.getSummary(),
      stage: this.stage,
      prePlanStep: this.prePlanStep,
      prePlanMaxSteps: this.prePlanMaxSteps,
      actionSeq: this.actionSeq,
      explorationTruncated: this.explorationTruncated,
      problemsCollected: this.problemsCollected,
      hasContract: !!this.completionContract,
      hasBaseline: !!this.baseline,
      hasPlan: !!this.markdownPlan,
      planDisplayed: this.planDisplayed,
      currentPhase: this.currentPhase,
      awaitingHumanInput: this.awaitingHumanInput,
      evidenceStrength: this.getEvidenceStrength(),
      evidenceStale: this.evidenceStale
    };
  }
}

module.exports = { AgentContext };
