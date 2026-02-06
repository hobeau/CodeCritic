const { detectTestRunner, parseTestOutput, discoverTestCommand } = require('../testUtils');

describe('testUtils', () => {
  describe('detectTestRunner', () => {
    it('should detect Jest from dependencies', () => {
      const packageJson = {
        devDependencies: { jest: '^29.0.0' }
      };
      expect(detectTestRunner(packageJson)).toBe('jest');
    });

    it('should detect Mocha from dependencies', () => {
      const packageJson = {
        devDependencies: { mocha: '^10.0.0' }
      };
      expect(detectTestRunner(packageJson)).toBe('mocha');
    });

    it('should detect Vitest from dependencies', () => {
      const packageJson = {
        dependencies: { vitest: '^0.34.0' }
      };
      expect(detectTestRunner(packageJson)).toBe('vitest');
    });

    it('should return "unknown" for unknown runners', () => {
      const packageJson = {
        devDependencies: { eslint: '^8.0.0' }
      };
      expect(detectTestRunner(packageJson)).toBe('unknown');
    });
  });

  describe('parseTestOutput - Jest', () => {
    it('should parse Jest passing tests', () => {
      const output = `
        PASS  src/utils.test.js
        ✓ should add numbers (3 ms)
        ✓ should multiply numbers (2 ms)
        
        Tests: 2 passed, 2 total
        Time: 1.5s
      `;
      
      const result = parseTestOutput(output, 'jest', 0);
      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.total).toBe(2);
    });

    it('should parse Jest failing tests', () => {
      const output = `
        FAIL  src/utils.test.js
        ✓ should add numbers (3 ms)
        ✗ should multiply numbers (2 ms)
        
        Tests: 1 failed, 1 passed, 2 total
        Time: 1.5s
      `;
      
      const result = parseTestOutput(output, 'jest', 1);
      expect(result.passed).toBe(false);
      expect(result.passedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.total).toBe(2);
    });

    it('should extract failures from Jest output', () => {
      const output = `
        FAIL  src/utils.test.js
        
        ● should multiply numbers

          Expected: 10
          Received: 20
        
        Tests: 1 failed, 1 total
      `;
      
      const result = parseTestOutput(output, 'jest', 1);
      expect(Array.isArray(result.failures)).toBe(true);
      expect(result.failures[0].test).toContain('should multiply numbers');
    });
  });

  describe('parseTestOutput - Mocha', () => {
    it('should parse Mocha passing tests', () => {
      const output = `
        ✓ should add numbers
        ✓ should multiply numbers
        
        2 passing (15ms)
      `;
      
      const result = parseTestOutput(output, 'mocha', 0);
      expect(result.passed).toBe(true);
      expect(result.passedCount).toBe(2);
      expect(result.failedCount).toBe(0);
    });

    it('should parse Mocha failing tests', () => {
      const output = `
        ✓ should add numbers
        1) should multiply numbers
        
        1 passing (15ms)
        1 failing
      `;
      
      const result = parseTestOutput(output, 'mocha', 1);
      expect(result.passed).toBe(false);
      expect(result.passedCount).toBe(1);
      expect(result.failedCount).toBe(1);
    });
  });

  describe('parseTestOutput - Vitest', () => {
    it('should parse Vitest passing tests', () => {
      const output = `
        ✓ src/utils.test.ts (2)
        ✓ should add numbers
        ✓ should multiply numbers
        
        Test Files  1 passed (1)
        Tests  2 passed (2)
      `;
      
      const result = parseTestOutput(output, 'vitest', 0);
      expect(result.passed).toBe(true);
      expect(result.runner).toBe('vitest');
    });

    it('should parse Vitest failing tests', () => {
      const output = `
        ✓ src/utils.test.ts (1)
        ✗ should multiply numbers
        
        Test Files  1 failed (1)
        Tests  1 failed | 1 passed (2)
      `;
      
      const result = parseTestOutput(output, 'vitest', 1);
      expect(result.passed).toBe(false);
      expect(result.runner).toBe('vitest');
    });
  });

  describe('discoverTestCommand', () => {
    it('should discover npm test command', async () => {
      const packageJson = {
        scripts: {
          test: 'jest --coverage'
        },
        devDependencies: { jest: '^29.0.0' }
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      
      const result = await discoverTestCommand('/workspace', readFile);
      expect(result).toEqual({
        command: 'npm test',
        runner: 'jest',
        targetFiles: []
      });
    });

    it('should discover direct runner command if no test script', async () => {
      const packageJson = {
        scripts: {},
        devDependencies: { mocha: '^10.0.0' }
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      
      const result = await discoverTestCommand('/workspace', readFile);
      expect(result).toEqual({
        command: 'mocha',
        runner: 'mocha',
        targetFiles: []
      });
    });

    it('should return null if no tests configured', async () => {
      const packageJson = {
        scripts: {},
        devDependencies: {}
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      
      const result = await discoverTestCommand('/workspace', readFile);
      expect(result).toBeNull();
    });

    it('should handle missing package.json', async () => {
      const readFile = jest.fn().mockRejectedValue(new Error('File not found'));
      
      const result = await discoverTestCommand('/workspace', readFile);
      expect(result).toBeNull();
    });
  });
});
