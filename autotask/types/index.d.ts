export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type Task = {
  id: string
  /**
   * Its number in its list: counts from 1 and is never reused there. With the
   * list's letter (C for L3) it is the label the person refers to it by in a
   * prompt, `C2`. Absent only on a task of
   * an offered list not yet added.
   */
  number?: number
  title: string
  /** Absent on a task with no severity (most hand-made ones). */
  severity?: Severity
  /** What was found, as the answer put it (markdown); absent on a hand-made task. */
  finding?: string
  /** What to do about it (markdown); absent when the answer gave no fix. */
  fix?: string
  /**
   * What Claude said on ticking it done or deleting it: what was done, or why
   * it was deleted. Absent on a task Claude never did either to.
   */
  note?: string
  isDone: boolean
  /**
   * True on a task the person removed: it sits in the list's Deleted section,
   * out of every count, until restored or removed for good.
   */
  isDeleted?: boolean
}

/**
 * What the mod has spent: the tokens of its own Haiku calls, which are
 * measured, and of the task text it added to prompts, which is estimated.
 */
export type Usage = {
  /** The Haiku calls made to read answers for tasks. */
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The prompts that named a task or list and had its text added. */
  mentions: number
  /** The tokens that text came to, estimated from its length. */
  contextTokens: number
}

export type TaskList = {
  id: string
  /**
   * The `L3` the person refers to the whole list by in a prompt (`#L3`):
   * never reused. Absent only on a list stored before list numbers.
   */
  number?: number
  name: string
  /** `ai`: extracted from one of Claude's answers; `user`: made by hand. */
  source: 'ai' | 'user'
  createdAt: number
  tasks: Task[]
  /** The number its next task takes, so a removed task's number stays unused. */
  nextTask?: number
  /**
   * The project root of the session it was made in, absolute: the pane shows
   * a project its own lists. Absent only on an offered list not yet added.
   */
  project?: string
  /**
   * What the list has cost: the Haiku calls whose tasks it took, and the
   * prompts that named it or its tasks. On an offer, the call that found it.
   * Absent on a list that has cost nothing.
   */
  usage?: Usage
}

/**
 * A list found in one of Claude's answers and not yet added: its tasks are
 * unnumbered, and `mergeInto` is the number of the existing list they
 * continue, absent when they are a subject of their own.
 */
export type Offer = TaskList & {
  mergeInto?: number
  /** `claude`: offered by Claude through its add_task tool, not read from an answer. */
  by?: 'claude'
}

declare module 'claude-code' {
  interface PluginState {
    autotask: {
      lists: TaskList[]
      /** The list the pane shows; `""` shows the index of all lists. */
      openId: string
      /** The ids of the tasks whose finding and fix are shown under their row. */
      expanded: string[]
      /** The id of the task whose title is being edited in the pane; `""` for none. */
      editing: string
      /** The id of the task or list whose "⋯" options are shown; `""` for none. */
      menu: string
      /**
       * The Done and Deleted sections that are open, as `done-<list id>` and
       * `deleted-<list id>`; both start closed.
       */
      unfolded: string[]
      /**
       * A list found in Claude's last answer, offered above the prompt and
       * not yet added (its tasks unnumbered); `null` with nothing on offer.
       */
      pending: Offer | null
      /** The ids of the offer's tasks the person unticked: left out when it is added. */
      unpicked: string[]
      /** The names the person gave the priorities in Settings; one with none keeps the usual. */
      labels: Partial<Record<Severity, string>>
      /** Whether the pane shows the settings page in place of the lists. */
      isSettings: boolean
      /** Whether the offer above the prompt lists every task, not its first few. */
      offerOpen: boolean
      /** The session's project root, absolute; `""` until the session starts. */
      projectRoot: string
      /** The id of the deleted task being asked about removing for good; `""` for none. */
      purging: string
      /** The id of the list whose usage window is open; `""` for none. */
      usageOf: string
      /**
       * What the mod has spent in every project, the Haiku calls that offered
       * nothing among them.
       */
      totals: Usage
      /**
       * Claude's last answer of the session, which "Add to list" reads for
       * tasks; `""` before the first.
       */
      lastAnswer: string
      /** Whether the pane lists every project's lists, not this project's alone. */
      showAll: boolean
    }
  }
}
