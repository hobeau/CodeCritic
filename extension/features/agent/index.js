/**
 * Agent module barrel export
 * Provides clean imports for agent functionality (all modes: agent, chat, planner)
 */

// Strategies
const { AgentStrategy } = require('./AgentStrategy');
const { ChatStrategy } = require('./ChatStrategy');
const { PlannerStrategy } = require('./PlannerStrategy');

// Contexts
const { BaseContext } = require('./BaseContext');
const { AgentContext } = require('./AgentContext');
const { ChatContext } = require('./ChatContext');
const { PlannerContext } = require('./PlannerContext');

// Core
const { PhaseResult } = require('./PhaseResult');

// Shared phases
const { AgentInitializationPhase } = require('./phases/AgentInitializationPhase');
const { ChatInitializationPhase } = require('./phases/ChatInitializationPhase');
const { PlannerInitializationPhase } = require('./phases/PlannerInitializationPhase');
const { StopCheckPhase } = require('./phases/StopCheckPhase');
const { LLMCallPhase } = require('./phases/LLMCallPhase');
const { ParsingPhase } = require('./phases/ParsingPhase');
const { FinalizationPhase } = require('./phases/FinalizationPhase');

// Mode-specific phases
const { ChatPlannerToolExecutionPhase } = require('./phases/ChatPlannerToolExecutionPhase');
const { CommandParsingPhase } = require('./phases/CommandParsingPhase');
const { SmartSearchPhase } = require('./phases/SmartSearchPhase');
const { PlanUpdatePhase } = require('./phases/PlanUpdatePhase');

// Utility exports
const parsingUtils = require('./utils/parsing');
const toolUtils = require('./utils/toolUtils');
const planUtils = require('./utils/planUtils');

module.exports = {
  // Strategies
  AgentStrategy,
  ChatStrategy,
  PlannerStrategy,
  
  // Contexts
  BaseContext,
  AgentContext,
  ChatContext,
  PlannerContext,
  
  // Core
  PhaseResult,
  
  // Shared phases
  AgentInitializationPhase,
  ChatInitializationPhase,
  PlannerInitializationPhase,
  StopCheckPhase,
  LLMCallPhase,
  ParsingPhase,
  FinalizationPhase,
  
  // Mode-specific phases
  ChatPlannerToolExecutionPhase,
  CommandParsingPhase,
  SmartSearchPhase,
  PlanUpdatePhase,
  
  // Utilities
  parsingUtils,
  toolUtils,
  planUtils
};
