/**
 * @jest-environment node
 */

const {
  isLikelyFileQuery,
  normalizeToolCall,
  normalizeContainerToolCall,
  describeToolCall,
  isDuplicateEdit,
  recordEdit,
  buildSearchSignature,
  formatToolResultForUi,
  limitToolOutput,
  isToolResultSuccess,
  isSearchResultMiss
} = require('../utils/toolUtils');

describe('tool utils', () => {
  describe('isLikelyFileQuery', () => {
    it.todo('should detect file paths with slashes');
    
    it.todo('should detect file names with extensions');
    
    it.todo('should reject queries with spaces');
  });
  
  describe('normalizeToolCall', () => {
    it.todo('should normalize container.* tool calls');
    
    it.todo('should convert search to locate_file for file-like queries');
    
    it.todo('should pass through standard tool calls');
  });
  
  describe('normalizeContainerToolCall', () => {
    it.todo('should map container.exec to run_command');
    
    it.todo('should handle bash -lc command arrays');
    
    it.todo('should pass through known container tools');
  });
  
  describe('isDuplicateEdit', () => {
    it.todo('should detect duplicate edits within cooldown period');
    
    it.todo('should allow edits after cooldown expires');
  });
  
  describe('recordEdit', () => {
    it.todo('should record edit with timestamp');
    
    it.todo('should limit cache size to 50 entries');
  });
  
  describe('buildSearchSignature', () => {
    it.todo('should create JSON signature from search args');
  });
  
  describe('formatToolResultForUi', () => {
    it.todo('should wrap run_command results in code fence');
    
    it.todo('should wrap read_file results in code fence if no fence present');
    
    it.todo('should preserve existing code fences');
  });
  
  describe('limitToolOutput', () => {
    it.todo('should truncate output exceeding max chars');
    
    it.todo('should preserve output under limit');
  });
  
  describe('isToolResultSuccess', () => {
    it.todo('should return true for non-error results');
    
    it.todo('should return false for results with error prefixes');
  });
  
  describe('isSearchResultMiss', () => {
    it.todo('should detect "no matches" messages');
    
    it.todo('should detect search failures');
  });
  
});
