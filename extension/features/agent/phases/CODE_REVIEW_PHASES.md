# Code Review Phases

This document explains the two new code review phases added to the Agent mode workflow.

## Overview

Both phases run **after parsing** but **before tool execution** to review and validate code changes before they are applied to files. This implements the "reflection pattern" from AI agent research, where the agent critiques its own work before taking action.

## Phase 1: ReflectionPhase (Self-Review)

**Purpose**: Automated self-critique of proposed code changes.

**When it runs**:
- Only in Agent mode
- Only when tool calls include code mutations (`edit_file`, `write_file`, etc.)
- Only for code files (`.js`, `.py`, `.java`, etc.)
- Only for substantial changes (>50 characters)

**What it does**:
1. Extracts all code mutation tool calls from the parsed response
2. Sends them back to the LLM with a prompt asking for critical review
3. Checks for:
   - Syntax errors or typos
   - Logic bugs or incorrect algorithms
   - Missing error handling or edge cases
   - Security vulnerabilities
   - Performance issues

**Possible outcomes**:
- ✅ **Approved**: Code looks good, proceed to next phase
- 🔄 **Revised**: Issues found, tool calls replaced with corrected version
- ⚠️ **Warning**: Issues noted but no fix available, warning shown but continues

**Example**:
```
Agent proposes: edit_file with new function
↓
ReflectionPhase: "This function doesn't handle null inputs"
↓
Revised tool call with null check added
↓
Proceeds to InstructionReviewPhase
```

## Phase 2: InstructionReviewPhase (Custom Rules)

**Purpose**: Validate code against project-specific guidelines.

**When it runs**:
- Only in Agent mode
- Only when `codeCritic.codeReviewInstructionFile` setting is configured
- Only when instruction file exists and is readable
- Only for same code mutations as ReflectionPhase

**Configuration**:

Add to VS Code settings:
```json
{
  "codeCritic.codeReviewInstructionFile": "${workspaceFolder}/.codecritic/code-rules.md"
}
```

Or leave empty to skip this phase entirely.

**What it does**:
1. Loads the custom instruction file
2. Extracts all code mutation tool calls
3. Sends code + instructions to LLM for validation
4. Checks code follows:
   - Naming conventions
   - Code structure requirements
   - Documentation standards
   - Project-specific patterns

**Possible outcomes**:
- ✅ **Approved**: Code follows all guidelines, proceed
- 🔄 **Corrected**: Guideline violations found, tool calls replaced with compliant version
- ⚠️ **Violation**: Issues detected but no fix available, warning shown but continues

**Example**:
```
Instruction file says: "Functions must have JSDoc comments"
Agent proposes: function without JSDoc
↓
InstructionReviewPhase: "Missing JSDoc comment"
↓
Revised tool call with JSDoc added
↓
Proceeds to SingleActionExecutionPhase
```

## Phase Order

In Agent mode, these phases run **after parsing** (and after `ActionPolicyPhase` enforces single-action + read-before-write), but **before** the single tool call is executed:

1. StopCheckPhase
2. LLMCallPhase
3. ParsingPhase
4. MarkdownPlanUpdatePhase
5. ActionPolicyPhase
6. **→ ReflectionPhase** (self-review)
7. **→ InstructionReviewPhase** (custom rules)
8. SingleActionExecutionPhase

## Benefits

### Proactive vs. Reactive
- **Before**: Code written → Applied to files → Errors detected → Fix errors
- **Now**: Code written → Reviewed → Issues fixed → Applied to files

### Catches Issues Early
- Syntax errors before compilation
- Logic bugs before execution
- Guideline violations before review
- Security issues before deployment

### Customizable
- ReflectionPhase provides baseline code quality checks
- InstructionReviewPhase adds project-specific validation
- Can enable/disable custom review by setting path

## Implementation Details

### Loop Prevention
Both phases use flags to prevent infinite loops:
- `context.isInReflection` - Prevents nested self-review
- `context.isInCustomReview` - Prevents nested custom review

### Error Handling
If either phase fails (LLM error, file read error, etc.):
- Warning message shown to user
- Original tool calls preserved
- Execution continues normally

This fail-safe approach ensures reviews enhance quality without blocking progress.

### Performance
- Phases only run for code mutations (not reads/searches)
- Skip if no code changes detected
- InstructionReviewPhase skips if no instruction file configured
- Adds 1-2 LLM calls per code change (depending on configuration)

## Example Instruction File

See `.codecritic/code-rules.example.md` for a template. Customize it for your project:

```markdown
# Project Code Rules

## Naming Conventions
- Functions: camelCase
- Classes: PascalCase
- Constants: UPPER_SNAKE_CASE

## Error Handling
- Always validate inputs
- Use try-catch for risky operations

## Documentation
- All public functions need JSDoc
```

## Disable/Enable

### Disable Self-Review
Cannot be disabled individually, but will automatically skip if no code mutations.

### Disable Custom Review
Set to empty string in settings:
```json
{
  "codeCritic.codeReviewInstructionFile": ""
}
```

### Disable Both
Both phases automatically skip in Chat and Planner modes. They only run in Agent mode.

## Research Background

These phases implement the "Reflection Pattern" identified in AI agent research:

> "By having the agent review its own output before execution, we can catch errors that automated testing might miss, leading to higher quality code generation." - ByteByteGo AI Agentic Patterns, 2025

The dual-phase approach (self-review + custom rules) provides both general quality checks and project-specific validation.
