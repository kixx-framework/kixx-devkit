Read the @README.md for the project overview, including what this project is and why it exists.

Developer Documentation
-----------------------
Use this documentation index to identify which linked documents are relevant to your task, then read the full text of each linked document — the index entries are summaries only. Keep the available documentation in mind as you work and review relevant documentation as your understanding of the task deepens. Avoid going off task or doing incorrect work because you did not review the relevant documentation.

### Unit Testing Guide

test/README.md

**When to use this document:** Apply this guide whenever you are writing, modifying, or reviewing unit tests. It defines the project’s test file layout and naming conventions, suite and hook patterns, assertion and mocking APIs, timeout and skipping behavior, shared conformance suites, and expectations for focused, deterministic tests.

### Code Style Guide

src/docs/code-style-guide.md

**When to use this document:** Apply this guide whenever you are writing or modifying any server-side JavaScript source file in this project. This includes:

- New functions, classes, modules, inline code comments, or any other JavaScript code you write from scratch.
- Edits to existing source files, including adding, updating, and improving inline code comments.
- Code review: Fix code style violations and update and clarify inline code comments even when not explicitly asked to.
- Deciding whether behavior belongs in a class, module, helper function, or existing object.
- Improving code structure while making a scoped feature or bug fix.
- Reviewing abstractions for responsibility ownership, encapsulation, layering, naming, or accidental complexity.

**What this document provides:** The canonical JavaScript style conventions for this project — maintaining good quality code as you work on a task, how to choose responsible owners for behavior, language standard, formatting rules, linting constraints, inline code comments, and project-specific patterns like destructuring, type detection, and private class members. Following this guide keeps code consistent throughout the codebase.

### Code Documentation Guide

src/docs/code-documentation-guide.md

**When to use this document:** Apply this guide whenever you are writing, reviewing, or improving JSDoc block comments in any JavaScript source file in this project. This includes:

- Adding documentation to new functions, classes, methods, or modules you write.
- Reviewing or updating existing documentation for accuracy and completeness.
- Deciding whether a given symbol *needs* documentation at all.
- Choosing the right JSDoc tags for a given situation.

Dependencies
------------

NEVER install dependencies without explicitly being asked to install them by the user.

If you think you need a dependency that is not already vendored, stop working on that task and ask the user to install it.

Planning Work
-------------

When the user makes a request for a new feature or significant refactoring:

Do NOT begin writing code or making changes.

FIRST: Ensure you have a conversation to elicit information from the user so that you have a complete understanding of the work to be done, tradeoffs made, etc. Pose as many questions as you need to fill in the gaps and avoid confusion.

You and the user may mutually decide that the work can be done without an implementation plan. However, if you do decide to create an Implementation plan, or the user requests one, then follow this guide:

An implementation plan is durable project state, not a disposable checklist or a copy of one agent's intended call sequence. Write it so an agent with no conversation history can understand the intended outcome, verify the completed work, and continue from the exact point where another agent stopped.

Each task must be a logical, reviewable partition of the implementation. It should produce one coherent outcome, have explicit boundaries, and be independently verifiable where practical. Prefer tasks aligned with behavior or an owned invariant over arbitrary file-by-file tasks. If a task cannot reasonably fit in one agent's context window, split it before implementation.

Use stable task IDs and record dependencies by ID.

Use this template for every implementation task:

```markdown
### Task <ID>: <outcome-oriented title>

**Status:** Not started
**Depends on:** <task IDs, or "None">
**Documentation:** <specification or document sections, or "None">

**Objective**

<Describe the observable outcome and why this task is a coherent partition of the plan. This should remain true even if the implementation details change.>

**Scope**

- In: <behavior, packages, interfaces, migrations, or documentation owned by this task>
- Out: <nearby work intentionally deferred to other task IDs>

**Design and invariants**

- <Constraints the implementation must preserve.>
- <Important API, ownership, concurrency, security, or error-handling choices.>
- <Known decisions that a later agent should not have to rediscover.>

**Expected touch points**

- `<anticipated file or package>` — <purpose of the change>

Treat this list as orientation, not permission to ignore other necessary files. Record the actual files changed in the handoff notes.

**Acceptance criteria**

- [ ] <Specific, observable behavior or artifact.>
- [ ] <Required success and failure behavior.>
- [ ] <Tests and documentation required for this task.>

**Validation**

- `<exact command>` — <what it proves>
- <Unit test coverage.>
- <Manual or integration check that cannot be expressed as a command, if any.>

**Progress and handoff**

- Completed: Nothing yet.
- Current state: Not started.
- Remaining: Everything described above.
- Decisions and discoveries: None yet.
- Actual files changed: None yet.
- Validation run: None yet.
- Blockers: None.
```

An Implementation Plan should begin with an Implementation Approach section summarizing the overall strategy and any cross-cutting concerns across the tasks.

Write implementation plans into the agents/plans/ directory.

Work Verification
-----------------

Always run the linter when you change JavaScript files for the Node.js or Cloudflare runtimes. See [Linting](#linting) below.

### Linting

Run the linter according to the instructions in the `README.md` for every JavaScript source file you changed during your task. Fix any linting errors you find for the code you have written during your task before you are done.

Helpful Tips
------------
When writing something intended for human consumption, (comment, commit message, reply to prompt) use as few words as possible. Be down to the point. Less is more.

Avoid superlatives and praise. Stop telling me I am absolutely right. Give me the cold hard truth.

Let the reader of the code breathe. Add empty lines between logical blocks of code.

### Commit Messages
When you write a commit message, follow these rules:

- Separate the subject line from the body with a single blank line.
- Limit the subject line to 50 characters (72 is the absolute hard limit).
- Capitalize the first letter of the subject line.
- Do not end the subject line with a period.
- Use the imperative mood in the subject line (e.g., "Fix bug," "Add feature," not "Fixed" or "Adds"). Test formula: It must complete the sentence: "If applied, this commit will [your subject line here]".
- Wrap the body text manually at 72 characters to prevent Git formatting issues.
- Use the body to explain what and why vs. how. Assume the code explains the how; the message must explain the context and reasoning.
- Never attribute authorship of a commit to yourself. Use the current git user instead with `git config user.name` and `git config user.email`.

### Explanatory Output

You should provide insightful explanations about how you are approaching a task and the tradeoffs you are making while remaining focused on the task. For non-trivial code changes, before and after writing code, provide brief insightful explanations about your implementation choices and your thinking supporting those choices using:

"★ Insight ─────────────────────────────────────
[2-3 key insightful points]
─────────────────────────────────────────────────"

These insights should be included in the conversation, not in the codebase. Focus on interesting insights that are specific to the codebase or the code you are writing, rather than general programming concepts. Do not wait until the end to provide insights. Provide them as you think about changes and write code.
