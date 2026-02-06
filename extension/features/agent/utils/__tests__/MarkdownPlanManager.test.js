const { createEmptyPlan, buildMarkdownPlan, parseMarkdownPlan } = require('../MarkdownPlanManager');

describe('MarkdownPlanManager', () => {
  describe('parseMarkdownPlan', () => {
    it('should parse Task List lines with ids, titles, descriptions, and doneWhen', () => {
      const markdown = `
# ReAct Agent Execution Plan

## 3) Task List (patch-sized)
Each task must have "Done when …"
- [ ] **T1: Add setting** Add config
  *Done when:* setting exists
- [x] **T2: Update docs** Improve docs
  *Done when:* docs updated

## 5) Progress Log (evidence ledger)
Every ✅ should reference evidence:
`;

      const plan = parseMarkdownPlan(markdown);
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0]).toEqual({
        id: 'T1',
        checked: false,
        title: 'Add setting',
        description: 'Add config',
        doneWhen: 'setting exists'
      });
      expect(plan.tasks[1]).toEqual({
        id: 'T2',
        checked: true,
        title: 'Update docs',
        description: 'Improve docs',
        doneWhen: 'docs updated'
      });
    });

    it('should parse Progress Log entries in bullet format', () => {
      const markdown = `
# ReAct Agent Execution Plan

## 5) Progress Log (evidence ledger)
Every ✅ should reference evidence:
- \`obs-001\`: first
- \`obs-002\`: second
`;

      const plan = parseMarkdownPlan(markdown);
      expect(plan.progressLog).toEqual([
        { id: 'obs-001', entry: 'first' },
        { id: 'obs-002', entry: 'second' }
      ]);
    });
  });

  describe('round-trips', () => {
    it('should preserve tasks and progressLog when parsing a built plan', () => {
      const plan = createEmptyPlan();
      plan.header.objective = 'Do thing';
      plan.acceptanceChecks = [{ checked: false, text: 'Requested behavior implemented and verified' }];
      plan.tasks = [
        { id: 'T1', checked: false, title: 'One', description: 'First task', doneWhen: 'Done' },
        { id: 'T2', checked: true, title: 'Two', description: '', doneWhen: 'Done 2' }
      ];
      plan.progressLog = [
        { id: 'obs-001', entry: 'Did a thing' },
        { id: 'obs-002', entry: 'Did another thing' }
      ];

      const markdown = buildMarkdownPlan(plan);
      const parsed = parseMarkdownPlan(markdown);

      expect(parsed.tasks).toEqual(plan.tasks);
      expect(parsed.progressLog).toEqual(plan.progressLog);
    });
  });
});

