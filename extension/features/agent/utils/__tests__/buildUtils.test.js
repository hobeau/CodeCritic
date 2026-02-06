const { BuildTool, detectBuildTool, parseBuildOutput, discoverBuildCommand } = require('../buildUtils');

describe('buildUtils', () => {
  describe('detectBuildTool', () => {
    it('should detect TypeScript from tsconfig.json', async () => {
      const fileExists = jest.fn().mockImplementation(path =>
        Promise.resolve(path.includes('tsconfig.json'))
      );
      
      const packageJson = {
        devDependencies: { typescript: '^5.0.0' }
      };
      
      const result = await detectBuildTool(packageJson, fileExists, '/workspace');
      expect(result).toBe(BuildTool.TYPESCRIPT);
    });

    it('should detect webpack from config file', async () => {
      const fileExists = jest.fn().mockImplementation(path =>
        Promise.resolve(path.includes('webpack.config'))
      );
      
      const packageJson = {
        devDependencies: { webpack: '^5.0.0' }
      };
      
      const result = await detectBuildTool(packageJson, fileExists, '/workspace');
      expect(result).toBe(BuildTool.WEBPACK);
    });

    it('should detect vite from config file', async () => {
      const fileExists = jest.fn().mockImplementation(path =>
        Promise.resolve(path.includes('vite.config'))
      );
      
      const packageJson = {
        devDependencies: { vite: '^4.0.0' }
      };
      
      const result = await detectBuildTool(packageJson, fileExists, '/workspace');
      expect(result).toBe(BuildTool.VITE);
    });

    it('should return "unknown" if no build tool found', async () => {
      const fileExists = jest.fn().mockResolvedValue(false);
      const packageJson = { devDependencies: {} };
      
      const result = await detectBuildTool(packageJson, fileExists, '/workspace');
      expect(result).toBe(BuildTool.UNKNOWN);
    });
  });

  describe('parseBuildOutput - TypeScript', () => {
    it('should parse successful TypeScript build', () => {
      const output = `
        Found 0 errors. Watching for file changes.
      `;
      
      const result = parseBuildOutput(output, BuildTool.TYPESCRIPT, 0);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should parse failed TypeScript build', () => {
      const output = `src/utils.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n` +
        `src/app.ts(25,10): error TS2345: Argument of type 'null' is not assignable to parameter of type 'string'.\n`;
      
      const result = parseBuildOutput(output, BuildTool.TYPESCRIPT, 1);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe('TS2322');
    });

    it('should extract error details from TypeScript', () => {
      const output = `src/utils.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n`;
      
      const result = parseBuildOutput(output, BuildTool.TYPESCRIPT, 1);
      expect(result.errors[0].file).toContain('utils.ts');
      expect(result.errors[0].code).toBe('TS2322');
    });
  });

  describe('parseBuildOutput - webpack (generic parsing)', () => {
    it('should parse successful webpack build', () => {
      const output = `
        Hash: abc123def456
        Version: webpack 5.75.0
        Time: 1234ms
        Built at: 2024-01-15 10:30:00
        
        webpack 5.75.0 compiled successfully in 1234 ms
      `;
      
      const result = parseBuildOutput(output, BuildTool.WEBPACK, 0);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should parse failed webpack build', () => {
      const output = `
        ERROR in ./src/app.js
        Module not found: Error: Can't resolve './missing-module'
        
        ERROR in ./src/utils.js 10:5
        Module parse failed: Unexpected token (10:5)
        
        webpack 5.75.0 compiled with 2 errors in 1234 ms
      `;
      
      const result = parseBuildOutput(output, BuildTool.WEBPACK, 1);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('parseBuildOutput - vite (generic parsing)', () => {
    it('should parse successful vite build', () => {
      const output = `
        vite v4.3.9 building for production...
        ✓ 42 modules transformed.
        dist/index.html                  0.45 kB
        dist/assets/index-abc123.js     25.30 kB │ gzip: 8.12 kB
        ✓ built in 1.23s
      `;
      
      const result = parseBuildOutput(output, BuildTool.VITE, 0);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should parse failed vite build', () => {
      const output = `
        vite v4.3.9 building for production...
        [vite]: Rollup failed to resolve import "./missing" from "src/app.ts".
        error during build:
        Error: Could not resolve "./missing"
      `;
      
      const result = parseBuildOutput(output, BuildTool.VITE, 1);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('discoverBuildCommand', () => {
    it('should discover npm build command', async () => {
      const packageJson = {
        scripts: {
          build: 'tsc'
        },
        devDependencies: { typescript: '^5.0.0' }
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      const fileExists = jest.fn().mockImplementation(path =>
        Promise.resolve(path.includes('tsconfig.json'))
      );
      
      const result = await discoverBuildCommand('/workspace', readFile, fileExists);
      expect(result).toEqual({
        command: 'npm run build',
        tool: BuildTool.TYPESCRIPT
      });
    });

    it('should discover direct tsc command if no build script', async () => {
      const packageJson = {
        scripts: {},
        devDependencies: { typescript: '^5.0.0' }
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      const fileExists = jest.fn().mockImplementation(path =>
        Promise.resolve(path.includes('tsconfig.json'))
      );
      
      const result = await discoverBuildCommand('/workspace', readFile, fileExists);
      expect(result).toEqual({
        command: 'npx tsc --noEmit',
        tool: BuildTool.TYPESCRIPT
      });
    });

    it('should return null if no build tool configured', async () => {
      const packageJson = {
        scripts: {},
        devDependencies: {}
      };
      
      const readFile = jest.fn().mockResolvedValue(JSON.stringify(packageJson));
      const fileExists = jest.fn().mockResolvedValue(false);
      
      const result = await discoverBuildCommand('/workspace', readFile, fileExists);
      expect(result).toBeNull();
    });

    it('should handle missing package.json', async () => {
      const readFile = jest.fn().mockRejectedValue(new Error('File not found'));
      const fileExists = jest.fn().mockResolvedValue(false);
      
      const result = await discoverBuildCommand('/workspace', readFile, fileExists);
      expect(result).toBeNull();
    });
  });
});
