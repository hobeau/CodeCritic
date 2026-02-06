/**
 * @jest-environment node
 */

const { ParsingPhase } = require('../phases/ParsingPhase');
const { AgentContext } = require('../AgentContext');

describe('ParsingPhase', () => {
  it.todo('should apply multi-strategy parsing (parseAgentResponse, parseTaggedToolCalls, etc.)');
  
  it.todo('should handle parse failures with retry');
  
  it.todo('should return PhaseResult.final() after 3 parse failures');
  
  it.todo('should handle final responses and update plan');
  
  it.todo('should collect workspace problems when finalizing');
  
  it.todo('should save to agent memory when enabled');
  
  it.todo('should extract and strip structured JSON from display text');
  
  it.todo('should return PhaseResult.continue() with parsed data');

  // TODO-specific behavior was removed. ParsingPhase now relies on markdown plans and acceptance checks.
});
