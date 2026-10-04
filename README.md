# AutoTask

A Claude Code mod that turns the findings and action items in Claude's answers into task lists you can check off in a pane.

When Claude answers with an audit, a code review or a plan, AutoTask offers its items above the prompt. You tick the ones you want, add them to a list, and work through them, by hand or by asking Claude to.

## Install

AutoTask is a mod: a plugin made of a hooks module. It needs a Claude Code version that supports mods.

```bash
claude plugin marketplace add LordTharkon/AutoTasker
```

```bash
claude plugin install autotask@levorlabs
```

To try it without installing, clone the repository and start Claude Code with `claude --plugin-dir ./autotask`.

## What it does

- **Offers tasks from answers.** After an answer that presents findings or action items, an offer appears above the prompt with a tick box per item. Add the ticked items to an existing list, make a new list, or dismiss the offer. Nothing is added without your say.
- **"+ Add to list".** A small button above the prompt reads Claude's last answer on request, for answers the mod did not offer by itself.
- **A pane of lists.** `/autotask`, or the "☑ AutoTask" button above the prompt, opens the pane. Each list groups its open tasks by priority, with Done and Deleted sections. A task can be ticked, edited, given a priority, moved to another list, deleted and restored.
- **Per project.** Lists belong to the project folder they were made in. "Show all projects" lists every project's.
- **Settings.** Turn automatic detection off, so answers are read only when you press "+ Add to list". Rename the five priorities (Critical, High, Medium, Low, Info) to whatever you like. Optionally send your open tasks with every message; this is off by default and costs tokens on each message.
- **Usage.** The gear on a list shows what the list and the mod have cost in tokens.

## Commands

| Command | What it does |
| --- | --- |
| `/autotask` | Opens the pane |
| `/autotask new <name>` | Makes a list |
| `/autotask add <task>` | Adds a task to the list open in the pane |

## Referring to tasks in a prompt

Every list has a number, shown as `#L3`, and every task a label: the list's letter and the task's number. `A` is list 1, `B` is list 2, and so on, so `B3` is task 3 of list 2.

Name a task or a list in a prompt and Claude is given its details:

- `fix B3`
- `work through #L3`

## What Claude can do

The mod gives Claude three tools:

| Tool | What it does |
| --- | --- |
| `set_task_done` | Ticks a task done, or reopens it, with a short note on what was done |
| `set_task_deleted` | Moves a task to its list's Deleted section, or restores it, with a note on why |
| `add_task` | Offers you a follow-up it came across while working; you choose whether it is added |

Claude's notes show under the task as "Claude Notes".

## Token usage

AutoTask spends tokens on your account in three ways:

- **Reading answers.** An answer with at least three list-like lines and a word such as "fix", "issue" or "recommend" is sent to Claude Haiku to be read for tasks: one call per such answer, and one per press of "+ Add to list".
- **Task details in prompts.** When a prompt names a task or a list, its details are added to that prompt.
- **Tool descriptions.** The three tools' descriptions are part of every request.

The usage window, behind the gear on a list, shows the Haiku calls as measured and the other two as estimates.

## Where the data lives

Lists, priority names and usage totals are kept in Claude Code's plugin store on your machine. Nothing is sent anywhere but to the model, through your own Claude Code session.

## Development

```bash
claude plugin validate ./autotask
```

The source is one hooks module, `autotask/hooks/register.tsx`, and its type contract, `autotask/types/index.d.ts`. `/plugin-types` writes the Claude Code type definitions the `tsconfig.json` expects.

## Licence

MIT. See [LICENSE](LICENSE).
