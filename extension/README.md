# Code Critic Notes

Review the active file or selected code with **Code Critic** (served via **Ollama**) and post **line-level** suggestions into VS Code's **Comments** panel.

## Commands
- **CodeCritic: Review File**
- **CodeCritic: Review Selection** (only shown when text is selected)
- **CodeCritic: Clear Review Comments**

## Settings
- `codeCritic.ollamaBaseUrl` (default: `http://100.96.82.48:11434/v1`)
- `codeCritic.model` (default: `devstral-small-2`)
- `codeCritic.maxChars` (default: `80000`)
- `codeCritic.instructionsFile` (default: empty)

### Custom review rules (instructions file)
Create a Markdown file (e.g. `./.codecritic/instructions.md`) and set:

```json
{
  "codeCritic.instructionsFile": "${workspaceFolder}/.codecritic/instructions.md"
}
```

The file content is appended to the system prompt under "CUSTOM REVIEW RULES".

## Notes
- Comments are **not persisted** across reloads.
- The extension asks the model for strict JSON, but also includes a JSON-extraction fallback to be resilient.
