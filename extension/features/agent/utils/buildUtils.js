/**
 * buildUtils - Build discovery and result parsing utilities
 */

const path = require('path');

/**
 * Build tool types
 */
const BuildTool = {
  NPM_BUILD: 'npm-build',
  TYPESCRIPT: 'typescript',
  WEBPACK: 'webpack',
  VITE: 'vite',
  ROLLUP: 'rollup',
  PARCEL: 'parcel',
  UNKNOWN: 'unknown'
};

/**
 * Detect build tool from package.json and config files
 * @param {object} packageJson - Parsed package.json
 * @param {Function} fileExists - File existence checker
 * @param {string} workspaceRoot - Workspace root path
 * @returns {Promise<string>} BuildTool type
 */
async function detectBuildTool(packageJson, fileExists, workspaceRoot) {
  if (!packageJson || typeof packageJson !== 'object') {
    return BuildTool.UNKNOWN;
  }
  
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  
  // Check for TypeScript
  if (deps.typescript || await fileExists(path.join(workspaceRoot, 'tsconfig.json'))) {
    return BuildTool.TYPESCRIPT;
  }
  
  // Check for bundlers
  if (deps.webpack || await fileExists(path.join(workspaceRoot, 'webpack.config.js'))) {
    return BuildTool.WEBPACK;
  }
  
  if (deps.vite || await fileExists(path.join(workspaceRoot, 'vite.config.js'))) {
    return BuildTool.VITE;
  }
  
  if (deps.rollup || await fileExists(path.join(workspaceRoot, 'rollup.config.js'))) {
    return BuildTool.ROLLUP;
  }
  
  if (deps.parcel) {
    return BuildTool.PARCEL;
  }
  
  // Check for npm build script
  const scripts = packageJson.scripts || {};
  if (scripts.build) {
    return BuildTool.NPM_BUILD;
  }
  
  return BuildTool.UNKNOWN;
}

/**
 * Discover build command from package.json or workspace
 * @param {string} workspaceRoot - Workspace root path
 * @param {Function} readFile - File reader function
 * @param {Function} fileExists - File existence checker
 * @returns {Promise<object|null>} { command, tool } or null
 */
async function discoverBuildCommand(workspaceRoot, readFile, fileExists) {
  try {
    // Read package.json
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath));
    
    // Check for build script
    const scripts = packageJson.scripts || {};
    if (scripts.build) {
      const tool = await detectBuildTool(packageJson, fileExists, workspaceRoot);
      return {
        command: 'npm run build',
        tool
      };
    }
    
    // Check for TypeScript
    if (await fileExists(path.join(workspaceRoot, 'tsconfig.json'))) {
      return {
        command: 'npx tsc --noEmit',
        tool: BuildTool.TYPESCRIPT
      };
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse TypeScript compiler output
 * @param {string} output - Compiler output
 * @param {number} exitCode - Process exit code
 * @returns {object} Build result
 */
function parseTypeScriptOutput(output, exitCode) {
  const result = {
    tool: BuildTool.TYPESCRIPT,
    success: exitCode === 0,
    errors: [],
    warnings: [],
    summary: '',
    exitCode
  };
  
  // Parse TypeScript errors: "file.ts(10,5): error TS2322: ..."
  const errorMatches = output.matchAll(/([^\s:]+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*?)(?=\n[^\s]|\n$)/g);
  
  for (const match of errorMatches) {
    const [, file, line, col, severity, code, message] = match;
    const entry = {
      file,
      line: parseInt(line, 10),
      column: parseInt(col, 10),
      code,
      message: message.trim()
    };
    
    if (severity === 'error') {
      result.errors.push(entry);
    } else {
      result.warnings.push(entry);
    }
  }
  
  result.summary = result.success
    ? 'Build succeeded'
    : `Build failed with ${result.errors.length} errors`;
  
  return result;
}

/**
 * Parse generic build output
 * @param {string} output - Build output
 * @param {number} exitCode - Process exit code
 * @returns {object} Build result
 */
function parseGenericBuildOutput(output, exitCode) {
  const result = {
    tool: BuildTool.UNKNOWN,
    success: exitCode === 0,
    errors: [],
    warnings: [],
    summary: exitCode === 0 ? 'Build succeeded' : 'Build failed',
    exitCode,
    rawOutput: output.substring(0, 1000)
  };
  
  // Try to extract error lines (lines containing "error" or "Error")
  const lines = output.split('\n');
  for (const line of lines) {
    if (/\berror\b/i.test(line)) {
      result.errors.push({ message: line.trim().substring(0, 200) });
      if (result.errors.length >= 10) break;
    }
  }
  
  return result;
}

/**
 * Parse build output based on tool
 * @param {string} output - Build command output
 * @param {string} tool - Build tool type
 * @param {number} exitCode - Process exit code
 * @returns {object} Parsed build result
 */
function parseBuildOutput(output, tool = BuildTool.UNKNOWN, exitCode = 0) {
  const outputStr = String(output || '');
  
  switch (tool) {
    case BuildTool.TYPESCRIPT:
      return parseTypeScriptOutput(outputStr, exitCode);
    default:
      return parseGenericBuildOutput(outputStr, exitCode);
  }
}

/**
 * Format build result for UI display
 * @param {object} buildResult - Parsed build result
 * @returns {string} Formatted message
 */
function formatBuildResultForUi(buildResult) {
  if (!buildResult) return 'No build results available';
  
  const { success, errors, warnings, summary } = buildResult;
  
  let message = `**Build Result**: ${summary}\n`;
  
  if (errors && errors.length > 0) {
    message += `- Errors: ${errors.length}\n`;
    message += '\n**Errors**:\n';
    errors.slice(0, 5).forEach(e => {
      if (e.file) {
        message += `- ${e.file}:${e.line}: ${e.message}\n`;
      } else {
        message += `- ${e.message}\n`;
      }
    });
    if (errors.length > 5) {
      message += `- ... and ${errors.length - 5} more\n`;
    }
  }
  
  if (warnings && warnings.length > 0) {
    message += `- Warnings: ${warnings.length}\n`;
  }
  
  return message;
}

module.exports = {
  BuildTool,
  detectBuildTool,
  discoverBuildCommand,
  parseBuildOutput,
  formatBuildResultForUi,
  parseTypeScriptOutput
};
