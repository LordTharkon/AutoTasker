import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Offer, Severity, Task, TaskList, Usage } from '../types'

const PANE = 'autotask'
// The window a list's gear opens, with what the list and the mod have spent.
const USAGE_PANE = 'autotask-usage'
const USAGE_KEY = 'usage'
// Text added to a prompt is counted at this many characters a token.
const CHARS_PER_TOKEN = 4
const NO_USAGE: Usage = {
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  mentions: 0,
  contextTokens: 0,
}
const STORE_KEY = 'lists'
const PER_LIST_KEY = 'hasPerListNumbers'
const LIST_NUMBER_KEY = 'nextListNumber'
const MODEL = 'haiku'
// An answer needs at least this many list-like lines before it is worth a
// model call to turn it into tasks.
const MIN_LIST_LINES = 3
const MAX_ANSWER_CHARS = 12000
const MAX_TASKS = 40
const MAX_EXISTING_LISTS = 6
// The newest tasks of a list the extractor is shown, to tell what it has.
const MAX_EXISTING_TASKS = 30
// Two titles sharing this much of their words are the same task.
const SAME_TITLE_SHARE = 0.5
// The tasks of an offer listed above the prompt until "Show all" is pressed.
const FOLDED_OFFER_ROWS = 5
// An answer with none of these is not read for tasks: no model call is made.
const TASK_CUES =
  /\b(severity|critical|high|medium|low|fix|issue|finding|recommend|todo|to-do|action items?|next steps?|vulnerab|risk|bug|problem|warning|missing|should|audit|review)/i
const BAR_CELLS = 20
const BAR_PIXELS = 180
const DONE_COLOR = '#4CAF7A'
const MAX_DETAIL_CHARS = 600
// A second event on the same button this soon after the first is the same click.
const ECHO_MS = 500
// The buttons `activate` acts on, by the first word of their key.
const EVERYDAY = ['open', 'back', 'toggle', 'expand', 'trash', 'scope', 'edit', 'cancel', 'save', 'menu', 'deleted', 'done', 'restore', 'remove', 'empty', 'purge', 'purgeno', 'usage', 'closeusage', 'settings']

const lists = atom({ plugin: 'autotask', key: 'lists' } as const, [])
const openId = atom({ plugin: 'autotask', key: 'openId' } as const, '')
const expanded = atom({ plugin: 'autotask', key: 'expanded' } as const, [])
const editing = atom({ plugin: 'autotask', key: 'editing' } as const, '')
const menu = atom({ plugin: 'autotask', key: 'menu' } as const, '')
const unfolded = atom({ plugin: 'autotask', key: 'unfolded' } as const, [])
const pending = atom({ plugin: 'autotask', key: 'pending' } as const, null)
const projectRoot = atom({ plugin: 'autotask', key: 'projectRoot' } as const, '')
const purging = atom({ plugin: 'autotask', key: 'purging' } as const, '')
const usageOf = atom({ plugin: 'autotask', key: 'usageOf' } as const, '')
const totals = atom({ plugin: 'autotask', key: 'totals' } as const, NO_USAGE)
const labels = atom({ plugin: 'autotask', key: 'labels' } as const, {})
const isSettings = atom({ plugin: 'autotask', key: 'isSettings' } as const, false)
const offerOpen = atom({ plugin: 'autotask', key: 'offerOpen' } as const, false)
const unpicked = atom({ plugin: 'autotask', key: 'unpicked' } as const, [])
const lastAnswer = atom({ plugin: 'autotask', key: 'lastAnswer' } as const, '')
const showAll = atom({ plugin: 'autotask', key: 'showAll' } as const, false)

// Folders compared as Windows and macOS do: either slash, any case.
function folderKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

// Whether a list belongs to the project at `root`; one stored before lists
// had a project belongs to every project until it is given one.
function isInProject(list: TaskList, root: string): boolean {
  return list.project === undefined || folderKey(list.project) === folderKey(root)
}
let paneSurface = ''
const lastActed = new Map<string, number>()
type Field = 'title' | 'finding' | 'fix'
// What has been typed into the fields of the task being edited, not yet saved.
const drafts = new Map<Field, string>()

// Whether a pane is one of the mod's two: the task lists or the usage window.
function isOurs(requestId: string | undefined): boolean {
  return requestId === PANE || requestId === USAGE_PANE
}

// Whether `activate` acts on this button's key.
function isEveryday(element: string): boolean {
  return EVERYDAY.includes(element.split('-')[0] ?? '')
}

// True when this button was acted on within the last ECHO_MS; otherwise
// records now as its last act.
function isRepeat(element: string): boolean {
  const now = Date.now()
  if (now - (lastActed.get(element) ?? 0) < ECHO_MS) return true
  lastActed.set(element, now)

  return false
}


const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']
// Muted on purpose: severity is a dot beside plain text, never a loud label.
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#E5484D',
  high: '#F0883E',
  medium: '#D9A93A',
  low: '#5B9BD5',
  info: '#8B949E',
}
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
}
// How the tools' descriptions say a task is named.
const TASK_LABELS =
  'A task is named by its label: the letter of its list (A for L1, B for L2, AA for L27) and its number in that list, so B3 is task 3 of list L2. '
const MAX_NOTE_CHARS = 300
// What both tools say of their `note`.
const NOTE_PARAM = {
  type: 'string',
  description:
    'Always give one: one or two short plain sentences shown to the user under the task as "Claude Notes". ' +
    'For a task ticked done, what was done; for a deleted one, why it was deleted. At most 300 characters.',
}
const DONE_TOOL =
  "Ticks a task in the user's AutoTask pane done, or reopens it. " +
  TASK_LABELS +
  'Call it once you have finished and verified the work a task describes, when the user asked you to take care of that task. ' +
  'Never tick a task whose work is partial, unverified, or that you were not asked to do.'
const DELETED_TOOL =
  "Moves a task in the user's AutoTask pane to its list's Deleted section, or restores it from there. Nothing is lost: the user can restore it in the pane. " +
  TASK_LABELS +
  'Call it for a task the user decided not to do, or that no longer applies (a duplicate, superseded by another decision). ' +
  'Never use it for a task that was completed (tick that one done instead), and never on your own judgement that a task is not worth doing.'
const ADD_TOOL =
  "Offers the user a new task for one of the task lists in their AutoTask pane; they choose whether it is added. " +
  'Call it when, while working on something else, you come across a concrete follow-up that belongs with a list the user keeps and is not on it: a bug you noticed, a step the work turned out to need, a risk worth a look. ' +
  'One call per task. Never use it for the work you are doing now, for something you have already done, for vague ideas, or to restate a task a list already has.'
// What the tools' descriptions add to every request, estimated.
const TOOLS_TOKENS = Math.ceil(
  (DONE_TOOL.length + DELETED_TOOL.length + ADD_TOOL.length + 2 * NOTE_PARAM.description.length) /
    CHARS_PER_TOKEN,
)
const PENDING_KEY = 'pending'
const NO_PRIORITY = 'none'
// What the "Move to" picker shows until a list is picked.
const NO_LIST = 'no-list'
const LABELS_KEY = 'labels'
const MAX_LABEL_CHARS = 20
// The width, in cells, of the column of priority names on the settings page.
const LABEL_COLUMN = 9
// The names the person gave the priorities in Settings; one with none keeps
// SEVERITY_LABEL's.
type Labels = Partial<Record<Severity, string>>

// What a priority is called: the person's name for it, else the usual one.
function labelOf(names: Labels, severity: Severity): string {
  return names[severity] || SEVERITY_LABEL[severity]
}

function priorityOptions(names: Labels) {
  return [
    ...SEVERITIES.map(severity => ({ value: severity, label: labelOf(names, severity) })),
    { value: NO_PRIORITY, label: 'None' },
  ]
}

// The extractor's bar for an answer nobody asked it to read: findings only.
const ONLY_FINDINGS = `- Only extract when the answer's main purpose is to present findings, issues, recommendations or action items the reader would work through (a security audit, a code review, a migration plan). Reply {"name": "", "tasks": []} for any other answer, even one that contains a list or mentions follow-ups: a report of changes made or work done, an explanation, an answer to a question, a status update, steps for the reader to test something, options or questions put to the reader ("say if you want...", "tell me whether..."). When in doubt, extract nothing.`
// Its bar when the person pressed "Add to list": they want this answer's
// items, so every one a person could act on is a task. It stands in for
// ONLY_FINDINGS: said beside it, the model kept to the stricter of the two.
const EVERY_ITEM = `- The user has asked for this answer's items to be added as tasks, so extract them whatever kind of answer it is: every list item, step, suggestion, option, idea or thing to check in it that a person could act on or follow up, one task each. Feature ideas, options put to the reader and next steps all count. Only reply with no tasks when the answer holds no such item at all.`

const EXTRACT_SYSTEM = `You turn an AI assistant's answer into a task list. The message gives the task lists the user already has, then the answer.
Reply with one JSON object and nothing else:
{"name": string, "mergeInto": number|null, "tasks": [{"title": string, "severity": "critical"|"high"|"medium"|"low"|"info"|null, "finding": string|null, "fix": string|null}]}

${ONLY_FINDINGS}
- "name": 2-6 words in Title Case saying what the list is about; when it has a subject and a qualifier, join them with " - ". E.g. "Server Security Audit", "Task List Mod - Remaining Issues".
- "mergeInto": the number of an existing list (4 for L4) when the answer's items continue that list: the same subject, follow-ups to its tasks, or options and next steps for one of them. null when the answer is about something none of the lists cover. If the name you would give matches or nearly matches an existing list's name, the answer continues that list: set "mergeInto" to its number. Write the bare number, not "L4".
- Leave out any item an existing list already has as a task, done or not, even when worded differently. When that leaves nothing, reply {"name": "", "mergeInto": null, "tasks": []}.
- One task per line item, in the answer's order. "title": a short imperative of at most 80 characters saying what to do, e.g. "Disable SSH password login".
- "severity": the severity the answer states for the item, mapped to the nearest of the five; null when it states none.
- "finding": what the answer says is wrong or needs attention for the item, in its own words and with its specifics (versions, paths, hostnames, numbers), at most 400 characters; keep \`code\` in backticks. null when the item is only an action with nothing found behind it.
- "fix": the fix, solution or next step the answer gives for the item, in its own words, at most 300 characters; keep \`code\` in backticks. null when the answer gives none. Never invent a fix.`

const ASKED_SYSTEM = EXTRACT_SYSTEM.replace(ONLY_FINDINGS, EVERY_ITEM)

let lastId = 0
const newId = () => `${Date.now().toString(36)}-${(lastId++).toString(36)}`

function countListLines(text: string): number {
  let count = 0
  let isInFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) isInFence = !isInFence
    if (isInFence) continue
    const isItem = /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)
    const isTableRow = /^\s*\|.*\|\s*$/.test(line) && !/^[\s|:-]+$/.test(line)
    const isNumberedHeading = /^#{2,5}\s+\S*\d/.test(line)
    if (isItem || isTableRow || isNumberedHeading) count++
  }

  return count
}

function toSeverity(value: unknown): Severity | undefined {
  const word = String(value ?? '').toLowerCase()

  return SEVERITIES.find(one => one === word)
}

function toDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, MAX_DETAIL_CHARS)

  return text === '' ? undefined : text
}

function parseExtraction(
  text: string,
): { name: string; tasks: Task[]; mergeInto?: number } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: { name?: unknown; tasks?: unknown; mergeInto?: unknown }
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed.tasks)) return undefined
  const tasks: Task[] = []
  for (const item of parsed.tasks.slice(0, MAX_TASKS)) {
    const title = String(item?.title ?? '').trim().slice(0, 120)
    if (title === '') continue
    const severity = toSeverity(item?.severity)
    const finding = toDetail(item?.finding)
    const fix = toDetail(item?.fix)
    tasks.push({
      id: newId(),
      title,
      isDone: false,
      ...(severity && { severity }),
      ...(finding && { finding }),
      ...(fix && { fix }),
    })
  }
  const name = String(parsed.name ?? '').trim().slice(0, 60)
  // The digits alone: the model also writes "L4" and "#L4" for 4.
  const mergeInto = Number(String(parsed.mergeInto ?? '').replace(/\D/g, ''))

  return {
    name: name || 'Task list',
    tasks,
    ...(Number.isInteger(mergeInto) && mergeInto > 0 && { mergeInto }),
  }
}

// A list name with case, punctuation and spacing taken out, for comparing.
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// The words of a title that carry its meaning: lower case, three letters or more.
function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2))
}

// Whether two task titles say the same thing: the same once case and
// punctuation are gone, or sharing most of their words.
function isSameTitle(one: string, other: string): boolean {
  if (nameKey(one) === nameKey(other)) return true
  const a = titleWords(one)
  const b = titleWords(other)
  const shared = [...a].filter(word => b.has(word)).length
  const all = new Set([...a, ...b]).size

  return all > 0 && shared / all >= SAME_TITLE_SHARE
}

// The project's lists as the extractor reads them, to tell a follow-up to one
// of them from a new subject and to leave out tasks a list already has.
function describeExisting(all: TaskList[]): string {
  if (all.length === 0) return 'None.'

  return all
    .slice(0, MAX_EXISTING_LISTS)
    .map(
      list =>
        `L${list.number} "${list.name}":\n` +
        live(list)
          .slice(-MAX_EXISTING_TASKS)
          .map(task => `  ${task.number}. ${task.title}${task.isDone ? ' (done)' : ''}`)
          .join('\n'),
    )
    .join('\n\n')
}

// The filled and the empty run of a progress bar, drawn as two Texts.
function bar(done: number, total: number): [string, string] {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS)

  return ['━'.repeat(filled), '━'.repeat(BAR_CELLS - filled)]
}

// The same bar as a thin rounded track, for the surfaces that draw SVG.
function barSvg(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_PIXELS)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_PIXELS}" height="4" viewBox="0 0 ${BAR_PIXELS} 4">` +
    `<rect width="${BAR_PIXELS}" height="4" rx="2" fill="#808080" fill-opacity="0.3"/>` +
    `<rect width="${filled}" height="4" rx="2" fill="${DONE_COLOR}"/></svg>`
  )
}

// Where a task sorts by severity: worst first, none last.
function severityRank(task: Task): number {
  return task.severity ? SEVERITIES.indexOf(task.severity) : SEVERITIES.length
}

// Whether a task has anything to show under its row.
function hasDetail(task: Task): boolean {
  return task.finding !== undefined || task.fix !== undefined || task.note !== undefined
}

// A list's tasks less the ones in its Deleted section: what every count is of.
function live(list: TaskList): Task[] {
  return list.tasks.filter(task => !task.isDeleted)
}

function countDone(list: TaskList): number {
  return live(list).filter(task => task.isDone).length
}

// Open tasks per severity, worst first, leaving out the severities with none.
function openBySeverity(list: TaskList): { severity: Severity; tasks: Task[] }[] {
  return SEVERITIES.map(severity => ({
    severity,
    tasks: live(list).filter(task => !task.isDone && task.severity === severity),
  })).filter(group => group.tasks.length > 0)
}

// Brings in the lists as the store has them now: another session, in this
// project or another, may have changed them since this one last looked.
async function refresh($: Engine): Promise<TaskList[]> {
  const stored = await $.store.get(STORE_KEY)
  if (!Array.isArray(stored)) return read($, lists)
  await update($, lists, () => stored as TaskList[])

  return stored as TaskList[]
}

// Every change goes through here, and is made to the lists as the store holds
// them, not as this session last saw them: a second session's changes are
// kept, where writing this session's copy back would undo them.
async function change($: Engine, fn: (all: TaskList[]) => TaskList[]) {
  const changed = fn(await refresh($))
  await update($, lists, () => changed)
  await $.store.set(STORE_KEY, changed)
}

// One usage with another's counts added; either may be missing some or all.
function addUsage(held: Usage | undefined, spent: Partial<Usage> | undefined): Usage {
  const sum = { ...NO_USAGE, ...held }
  for (const [name, count] of Object.entries(spent ?? {})) {
    sum[name as keyof Usage] += Number(count) || 0
  }

  return sum
}

// The tokens a text added to a prompt comes to: an estimate from its length.
function toTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

// A count as it is shown: 12,345.
function grouped(count: number): string {
  return String(Math.round(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Adds to what the mod has spent in all; the store holds it across sessions.
async function addTotals($: Engine, spent: Partial<Usage>) {
  const sum = addUsage((await $.store.get(USAGE_KEY)) as Usage | undefined, spent)
  await update($, totals, () => sum)
  await $.store.set(USAGE_KEY, sum)
}

// Names a priority, for every list and project; an empty name brings back the
// usual one. The store holds the names across sessions.
async function setLabel($: Engine, severity: Severity, value: string) {
  const name = value.trim().slice(0, MAX_LABEL_CHARS)
  await update($, labels, held => {
    const { [severity]: _held, ...rest } = held

    return name === '' ? rest : { ...rest, [severity]: name }
  })
  await $.store.set(LABELS_KEY, await read($, labels))
}

// Opens the usage window on a list.
async function showUsage($: Engine, listId: string) {
  await update($, usageOf, () => listId)
  await $.ui.open({ id: USAGE_PANE, title: 'AutoTask usage', focus: true, closeOnEscape: true, rows: 16 })
}

// Reads one of Claude's answers for tasks and, finding some, offers them
// above the prompt. Run off a timer once the turn has ended, so the model
// call it makes holds nothing up.
// `isAsked`: the person pressed "Add to list", so every item of the answer
// is wanted and they are told when it comes to nothing.
async function extractOffer($: Engine, answer: string, isAsked = false) {
  const root = await read($, projectRoot)
  const existing = (await refresh($)).filter(list => isInProject(list, root))
  const reply = await $.model.complete({
    model: MODEL,
    system: isAsked ? ASKED_SYSTEM : EXTRACT_SYSTEM,
    prompt:
      `Existing task lists:\n${describeExisting(existing)}\n\n` +
      `The answer:\n${answer.slice(0, MAX_ANSWER_CHARS)}`,
    maxTokens: 4000,
    timeoutMs: 20000,
  })
  // Counted whether or not it finds anything: most calls offer nothing.
  const spent = {
    calls: 1,
    input: reply.usage.input_tokens,
    output: reply.usage.output_tokens,
    cacheRead: reply.usage.cache_read_input_tokens,
    cacheWrite: reply.usage.cache_creation_input_tokens,
  }
  await addTotals($, spent)
  const found = reply.isAnswered ? parseExtraction(reply.text) : undefined
  if (!found || found.tasks.length === 0) {
    if (isAsked) {
      $.ui.toast(
        reply.isAnswered
          ? 'No items found in the last answer to add.'
          : `Could not read the last answer (${reply.reason}). Try again.`,
      )
    }

    return
  }
  // Offered, not added: the band above the prompt asks. A newer offer
  // replaces one the person never answered. A list the model named like
  // an existing one continues it, whether or not it said so.
  const target =
    existing.find(list => list.number === found.mergeInto) ??
    existing.find(list => nameKey(list.name) === nameKey(found.name))
  // The model is told to leave out what a list already has and does not
  // always: a task titled like one the project has is dropped here too.
  const held = existing.flatMap(list => live(list).map(task => task.title))
  const tasks = found.tasks.filter(task => !held.some(title => isSameTitle(title, task.title)))
  if (tasks.length === 0) {
    if (isAsked) $.ui.toast('Your lists already have every item of the last answer.')

    return
  }
  await setPending($, {
    id: newId(),
    name: found.name,
    source: 'ai',
    createdAt: Date.now(),
    tasks,
    project: root,
    // The list that takes these tasks takes the cost of finding them.
    usage: addUsage(undefined, spent),
    ...(target?.number !== undefined && { mergeInto: target.number }),
  })
  $.ui.toast(
    target
      ? `${tasks.length} new items detected for "${target.name}". Add them from above the prompt.`
      : `"${found.name}" detected: ${tasks.length} items. Add it from above the prompt.`,
  )
}

function changeList($: Engine, id: string, fn: (list: TaskList) => TaskList) {
  return change($, all => all.map(list => (list.id === id ? fn(list) : list)))
}

// Reserves the next list number; the counter lives in the store so a number
// is never handed out twice, deleted lists included.
async function takeListNumber($: Engine): Promise<number> {
  const highest = (await read($, lists)).reduce((max, list) => Math.max(max, list.number ?? 0), 0)
  const number = Math.max(Number((await $.store.get(LIST_NUMBER_KEY)) ?? 1) || 1, highest + 1)
  await $.store.set(LIST_NUMBER_KEY, number + 1)

  return number
}

async function addList($: Engine, list: TaskList) {
  const number = await takeListNumber($)
  const project = await read($, projectRoot)
  await change($, all => [{ ...list, number, project }, ...all])
  await update($, openId, () => list.id)
}

// Lists stored before lists had a project were all made in the one this mod
// was written in, which is the one running when this first loads: they join it.
async function adoptOldLists($: Engine, root: string) {
  const hasOld = (await read($, lists)).some(list => list.project === undefined)
  if (!hasOld) return
  await change($, all => all.map(list => (list.project === undefined ? { ...list, project: root } : list)))
}

// Gives every list stored before list numbers existed one, oldest first.
async function numberOldLists($: Engine) {
  const missing = [...(await read($, lists))].reverse().filter(list => list.number === undefined)
  for (const list of missing) {
    const number = await takeListNumber($)
    await changeList($, list.id, held => ({ ...held, number }))
  }
}

// Numbers a list's tasks 1, 2, 3 in order and sets where its next one starts.
function numbered(list: TaskList): TaskList {
  return {
    ...list,
    tasks: list.tasks.map((task, index) => ({ ...task, number: index + 1 })),
    nextTask: list.tasks.length + 1,
  }
}

// The next task number of a list: past every number it holds or ever held.
function nextTaskNumber(list: TaskList): number {
  return Math.max(list.nextTask ?? 1, ...list.tasks.map(task => (task.number ?? 0) + 1))
}

function addTask($: Engine, id: string, title: string) {
  return changeList($, id, list => {
    const number = nextTaskNumber(list)

    return {
      ...list,
      tasks: [...list.tasks, { id: newId(), number, title, isDone: false }],
      nextTask: number + 1,
    }
  })
}

// Once: lists stored while task numbers ran across every list are renumbered
// from 1 each.
async function renumberOldTasks($: Engine) {
  if ((await $.store.get(PER_LIST_KEY)) === true) return
  await change($, all => all.map(numbered))
  await $.store.set(PER_LIST_KEY, true)
}

// The letters a list's tasks carry: A for L1, B for L2, Z for L26, AA for L27.
function listLetters(number: number): string {
  let letters = ''
  for (let rest = number; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  }

  return letters
}

// The list number letters stand for: 2 for B, 27 for AA; any case.
function lettersNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce((sum, one) => sum * 26 + one.charCodeAt(0) - 64, 0)
}

// What a task is called, in the pane and in a prompt: B3 is task 3 of L2.
function taskLabel(list: TaskList, task: Task): string {
  return list.number === undefined || task.number === undefined
    ? ''
    : `${listLetters(list.number)}${task.number}`
}

// The task a tool call names: by its label (`task: "B3"`), or as the tools
// first took it, by list and task number (`list: 2, task: 3`).
function findTask(
  all: TaskList[],
  input: { readonly [name: string]: unknown },
): { list: TaskList; task: Task } | undefined {
  const label = /^#?([A-Za-z]{1,2})(\d+)$/.exec(String(input.task ?? '').trim())
  const listNumber = label ? lettersNumber(label[1] ?? '') : Number(input.list)
  const taskNumber = label ? Number(label[2]) : Number(input.task)
  const list = all.find(one => one.number === listNumber)
  const task = list?.tasks.find(one => one.number === taskNumber)

  return list && task ? { list, task } : undefined
}

// What the model reads about one task the prompt named by its label.
function describeTask(list: TaskList, task: Task): string {
  return [
    `Task ${taskLabel(list, task)} (task ${task.number} of task list L${list.number}, "${list.name}"): ${task.title}`,
    `Status: ${task.isDeleted ? 'deleted by the user' : task.isDone ? 'done' : 'open'}${task.severity ? `. Severity: ${task.severity}` : ''}`,
    task.finding && `Finding: ${task.finding}`,
    task.fix && `Suggested fix: ${task.fix}`,
    task.note && `Claude's note: ${task.note}`,
  ]
    .filter(Boolean)
    .join('\n')
}

// Ticks a task done or reopens it; `isDone` left out flips it. A task ticked
// done folds its finding and fix away.
async function setDone($: Engine, listId: string, taskId: string, isDone?: boolean) {
  await changeList($, listId, list => ({
    ...list,
    tasks: list.tasks.map(one =>
      one.id === taskId ? { ...one, isDone: isDone ?? !one.isDone } : one,
    ),
  }))
  const task = (await read($, lists))
    .find(list => list.id === listId)
    ?.tasks.find(one => one.id === taskId)
  if (task?.isDone) await update($, expanded, ids => ids.filter(one => one !== taskId))
}

// Puts a task in its list's Deleted section, folded shut, or takes it back out.
async function setDeleted($: Engine, listId: string, taskId: string, isDeleted: boolean) {
  await update($, editing, held => (held === taskId ? '' : held))
  await update($, menu, held => (held === taskId ? '' : held))
  await changeList($, listId, list => ({
    ...list,
    tasks: list.tasks.map(one => {
      if (one.id !== taskId) return one
      const { isDeleted: _held, ...rest } = one

      return isDeleted ? { ...rest, isDeleted } : rest
    }),
  }))
  if (isDeleted) await update($, expanded, ids => ids.filter(one => one !== taskId))
}

// Records what Claude says it did to a task, or why it deleted it: shown
// under the task as "Claude Notes". Nothing given leaves the note it had.
function setNote($: Engine, listId: string, taskId: string, value: unknown) {
  const note = toDetail(value)?.slice(0, MAX_NOTE_CHARS)
  if (note === undefined) return

  return changeList($, listId, list => ({
    ...list,
    tasks: list.tasks.map(one => (one.id === taskId ? { ...one, note } : one)),
  }))
}

// Sets the offer above the prompt, or with null takes it down; the store
// holds it too, so it outlives the session it was found in.
// Each project keeps its own, so one found in another project leaves it be.
async function setPending($: Engine, offer: Offer | null) {
  await update($, pending, () => offer)
  // Every offer starts with all its items ticked.
  await update($, unpicked, () => [])
  await update($, offerOpen, () => false)
  const key = pendingKey(await read($, projectRoot))
  if (offer) await $.store.set(key, offer)
  else await $.store.delete(key)
}

// Where the store keeps the offer of the project at `root`.
function pendingKey(root: string): string {
  return `${PENDING_KEY}:${folderKey(root)}`
}

// The list of this project already going by a name, compared loosely.
async function findNamesake($: Engine, name: string): Promise<TaskList | undefined> {
  const root = await read($, projectRoot)

  return (await read($, lists)).find(
    list => isInProject(list, root) && nameKey(list.name) === nameKey(name),
  )
}

// Makes a list by hand, unless the project has one of that name: that one is
// opened instead. Returns what to tell the person.
async function createList($: Engine, name: string): Promise<string> {
  const namesake = await findNamesake($, name)
  if (namesake) {
    await update($, openId, () => namesake.id)

    return `"${namesake.name}" already exists (#L${namesake.number}): opened it instead.`
  }
  await addList($, { id: newId(), name, source: 'user', createdAt: Date.now(), tasks: [] })

  return `Task list "${name}" created.`
}

// Moves a task to another priority, or with NO_PRIORITY to none: it then
// sits in that priority's section.
function setSeverity($: Engine, listId: string, taskId: string, value: string) {
  const severity = toSeverity(value)

  return changeList($, listId, list => ({
    ...list,
    tasks: list.tasks.map(one => {
      if (one.id !== taskId) return one
      const { severity: _held, ...rest } = one

      return severity ? { ...rest, severity } : rest
    }),
  }))
}

// Takes the pane to a list, or with "" back to the index of lists. An edit
// or "⋯" options left open are closed, unsaved: they do not outlive the view.
async function showList($: Engine, id: string) {
  drafts.clear()
  await update($, editing, () => '')
  await update($, menu, () => '')
  await update($, purging, () => '')
  await update($, isSettings, () => false)
  await update($, openId, () => id)
}

// Opens a list's Done or Deleted section, or closes it when open; `key` is
// the section's button (`done-<list>`, `deleted-<list>`).
function toggleFold($: Engine, key: string) {
  return update($, unfolded, keys =>
    keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key],
  )
}

// Shows the "⋯" options of a task or a list, or hides them when they show.
// An edit under way is closed unsaved: one thing is open at a time.
async function toggleMenu($: Engine, id: string) {
  drafts.clear()
  await update($, editing, () => '')
  await update($, menu, held => (held === id ? '' : id))
}

// Moves one task of a list, or with `taskId` left out all of them, to the end
// of another list, numbered on from that list's last; then hides the options.
// A list whose tasks all moved this way is removed.
async function moveTasks($: Engine, fromId: string, toId: string, taskId?: string) {
  await change($, all => {
    const from = all.find(one => one.id === fromId)
    const to = all.find(one => one.id === toId)
    if (!from || !to || from.id === to.id) return all
    const moved = from.tasks.filter(task => taskId === undefined || task.id === taskId)
    const first = nextTaskNumber(to)

    // A list moved whole is gone; one that gave a task up stays.
    const kept = taskId === undefined ? all.filter(one => one.id !== from.id) : all

    return kept.map(one => {
      if (one.id === from.id) return { ...one, tasks: one.tasks.filter(task => !moved.includes(task)) }
      if (one.id !== to.id) return one

      return {
        ...one,
        tasks: [...one.tasks, ...moved.map((task, index) => ({ ...task, number: first + index }))],
        nextTask: first + moved.length,
        // A list moved whole takes what it cost with it.
        ...(taskId === undefined && from.usage && { usage: addUsage(one.usage, from.usage) }),
      }
    })
  })
  await update($, menu, () => '')
  // The pane follows a list moved whole to where its tasks went.
  if (taskId === undefined) await update($, openId, held => (held === fromId ? toId : held))
}

// Opens a task's title for editing, or closes it when it is the one open.
async function toggleEditing($: Engine, taskId: string) {
  drafts.clear()
  await update($, menu, () => '')
  await update($, editing, held => (held === taskId ? '' : taskId))
}

// Saves every field typed into since the edit opened, then closes it.
async function saveEdit($: Engine, listId: string, taskId: string) {
  const typed = [...drafts]
  drafts.clear()
  for (const [name, value] of typed) await setField($, listId, taskId, name, value)
  await update($, editing, () => '')
}

// Saves what was typed for one field of a task. An empty title keeps the one it had; an empty finding or fix
// removes it.
function setField(
  $: Engine,
  listId: string,
  taskId: string,
  field: Field,
  value: string,
) {
  const text = value.trim().slice(0, field === 'title' ? 120 : MAX_DETAIL_CHARS)
  if (field === 'title' && text === '') return

  return changeList($, listId, list => ({
    ...list,
    tasks: list.tasks.map(one => {
      if (one.id !== taskId) return one
      const { [field]: _held, ...rest } = one

      return (text === '' ? rest : { ...rest, [field]: text }) as Task
    }),
  }))
}

function toggleExpanded($: Engine, taskId: string) {
  return update($, expanded, ids =>
    ids.includes(taskId) ? ids.filter(one => one !== taskId) : [...ids, taskId],
  )
}

// Takes the offer and shows the result: its tasks join the list it continues,
// numbered on from that list's last, or, `asNew` or with that list gone, it
// becomes a list of its own.
async function acceptPending($: Engine, asNew: boolean) {
  const offer = await read($, pending)
  if (!offer) return
  const skipped = await read($, unpicked)
  const picked = offer.tasks.filter(task => !skipped.includes(task.id))
  if (picked.length === 0) {
    $.ui.toast('Nothing is ticked. Tick the items to add, or Dismiss.')

    return
  }
  await setPending($, null)
  const { mergeInto, by: _by, ...list } = { ...offer, tasks: picked }
  const target = asNew ? undefined : (await read($, lists)).find(one => one.number === mergeInto)
  if (target) {
    await changeList($, target.id, held => {
      const first = nextTaskNumber(held)

      return {
        ...held,
        tasks: [...held.tasks, ...list.tasks.map((task, index) => ({ ...task, number: first + index }))],
        nextTask: first + list.tasks.length,
        ...(list.usage && { usage: addUsage(held.usage, list.usage) }),
      }
    })
    await update($, openId, () => target.id)
  } else {
    // Asked for as a list of its own under a name the project has: it takes
    // the name with the first free number after it.
    let name = list.name
    for (let copy = 2; await findNamesake($, name); copy++) name = `${list.name} (${copy})`
    await addList($, numbered({ ...list, name }))
  }
  await $.ui.open({ id: PANE, title: 'AutoTask' })
}

// Asks, then removes for good every task in a list's Deleted section.
async function emptyDeleted($: Engine, listId: string) {
  const list = (await read($, lists)).find(one => one.id === listId)
  const count = list?.tasks.filter(task => task.isDeleted).length ?? 0
  if (!list || count === 0) return
  const answer = await $.ui.ask(
    `Remove the ${count} deleted ${count === 1 ? 'task' : 'tasks'} of "${list.name}" for good?`,
    ['Remove', 'Cancel'],
  )
  if (answer !== 'Remove') return
  await changeList($, listId, held => ({ ...held, tasks: held.tasks.filter(task => !task.isDeleted) }))
  await update($, menu, () => '')
}

// Removes for good one task from a list's Deleted section. Asked in the
// pane, on the task's own row, by `purging`: the "✕" only starts the question.
async function purgeTask($: Engine, listId: string, taskId: string) {
  await update($, purging, () => '')
  await changeList($, listId, held => ({ ...held, tasks: held.tasks.filter(one => one.id !== taskId) }))
}

// Asks before deleting a whole list; anything but the Delete answer keeps it.
async function confirmDelete($: Engine, listId: string) {
  const list = (await read($, lists)).find(one => one.id === listId)
  if (!list) return
  const answer = await $.ui.ask(
    `Delete the task list "${list.name}" and its ${list.tasks.length} tasks?`,
    ['Delete', 'Cancel'],
  )
  if (answer !== 'Delete') return
  await change($, all => all.filter(one => one.id !== listId))
  // Asked from inside the list, the pane falls back to the index of lists.
  await update($, openId, held => (held === listId ? '' : held))
}

// Does what a press on one of the pane's everyday buttons does, by the
// button's key (`open-<list>`, `back`, `toggle-<task>`, `expand-<task>`,
// `trash-<list>`, which only asks); false for any other key, the ones that
// delete without asking among them.
async function activate($: Engine, element: string): Promise<boolean> {
  const dash = element.indexOf('-')
  const kind = dash < 0 ? element : element.slice(0, dash)
  const id = dash < 0 ? '' : element.slice(dash + 1)

  if (kind === 'open') await showList($, id)
  else if (kind === 'back') await showList($, '')
  else if (kind === 'toggle') await setDone($, await read($, openId), id)
  else if (kind === 'scope') await update($, showAll, held => !held)
  else if (kind === 'expand') await toggleExpanded($, id)
  else if (kind === 'edit' || kind === 'cancel') await toggleEditing($, id)
  else if (kind === 'menu') await toggleMenu($, id)
  else if (kind === 'deleted' || kind === 'done') await toggleFold($, element)
  else if (kind === 'remove') await setDeleted($, await read($, openId), id, true)
  else if (kind === 'restore') await setDeleted($, await read($, openId), id, false)
  else if (kind === 'save') await saveEdit($, await read($, openId), id)
  else if (kind === 'trash') await confirmDelete($, id)
  else if (kind === 'empty') await emptyDeleted($, id)
  // Only asks: the row's own Remove button, left out of here, does the removing.
  else if (kind === 'purge') await update($, purging, () => id)
  else if (kind === 'purgeno') await update($, purging, () => '')
  else if (kind === 'usage') await showUsage($, id)
  else if (kind === 'settings') await update($, isSettings, () => true)
  else if (kind === 'closeusage') await $.ui.close({ id: USAGE_PANE })
  else return false

  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'autotask',
      description: 'Open the AutoTask pane (also: /autotask new <name>, /autotask add <task>)',
    })
    await refresh($)
    await addTotals($, {})
    const named = await $.store.get(LABELS_KEY)
    if (named && typeof named === 'object') await update($, labels, () => named as Labels)
    const root = await $.session.root()
    await update($, projectRoot, () => root)
    await adoptOldLists($, root)
    await renumberOldTasks($)
    await numberOldLists($)
    // An offer nobody answered before its session closed, if it was this
    // project's, is offered again.
    // One saved when every project shared a single slot moves to its own.
    const shared = (await $.store.get(PENDING_KEY)) as Offer | undefined
    if (shared && Array.isArray(shared.tasks) && shared.project !== undefined) {
      await $.store.set(pendingKey(shared.project), shared)
      await $.store.delete(PENDING_KEY)
    }
    const offered = (await $.store.get(pendingKey(root))) as Offer | undefined
    if (offered && Array.isArray(offered.tasks)) {
      await update($, pending, held => held ?? offered)
    }
    await $.tool.register({
      name: 'set_task_done',
      description: DONE_TOOL,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task label, e.g. "B3"' },
          note: NOTE_PARAM,
          done: { type: 'boolean', description: 'true ticks it done (the default), false reopens it' },
        },
        required: ['task'],
      },
    })

    await $.tool.register({
      name: 'add_task',
      description: ADD_TOOL,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short imperative saying what to do, at most 80 characters' },
          list: {
            type: 'string',
            description: 'The list it belongs on, e.g. "L3". Leave out when it fits none of the lists: it is offered as a new list.',
          },
          name: {
            type: 'string',
            description: 'With no `list`: 2-6 words in Title Case naming the new list.',
          },
          severity: { type: 'string', enum: [...SEVERITIES], description: 'How severe it is, when that is clear' },
          finding: { type: 'string', description: 'What you found that needs attention, with its specifics; at most 400 characters' },
          fix: { type: 'string', description: 'What to do about it, when you know; at most 300 characters' },
        },
        required: ['title'],
      },
    })

    await $.tool.register({
      name: 'set_task_deleted',
      description: DELETED_TOOL,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task label, e.g. "B3"' },
          note: NOTE_PARAM,
          deleted: { type: 'boolean', description: 'true deletes it (the default), false restores it' },
        },
        required: ['task'],
      },
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__autotask__set_task_deleted' }, async ($, e) => {
    const isDeleted = e.deleted !== false
    const found = findTask(await refresh($), e)
    if (!found) return { deny: `No task ${String(e.task)} in the AutoTask pane.` }
    const { list, task } = found

    await setDeleted($, list.id, task.id, isDeleted)
    await setNote($, list.id, task.id, e.note)

    return {
      result: `${taskLabel(list, task)} "${task.title}" is now ${isDeleted ? 'in the Deleted section' : 'restored'}.`,
    }
  })

  // A task Claude came across while working. Offered above the prompt like
  // one read from an answer, never added outright: the person decides. Several
  // in a row for the same list gather into the one offer.
  on('tool.call', { tool: 'mcp__autotask__add_task' }, async ($, e) => {
    const title = String(e.title ?? '').trim().slice(0, 120)
    if (title === '') return { deny: 'Give the task a title.' }
    const root = await read($, projectRoot)
    const all = (await refresh($)).filter(list => isInProject(list, root))
    const target = all.find(list => list.number === Number(String(e.list ?? '').replace(/\D/g, '')))
    const name = target?.name ?? (String(e.name ?? '').trim().slice(0, 60) || 'Follow-ups')
    const held = await read($, pending)
    // The same offer goes on gathering: Claude's, and for the same list.
    const isSameOffer =
      held?.by === 'claude' &&
      held.mergeInto === target?.number &&
      (target !== undefined || nameKey(held.name) === nameKey(name))

    for (const list of all) {
      const twin = live(list).find(task => isSameTitle(task.title, title))
      if (twin) return { result: `Not offered: ${taskLabel(list, twin)} "${twin.title}" of L${list.number} is already this task.` }
    }
    if (isSameOffer && held.tasks.some(task => isSameTitle(task.title, title))) {
      return { result: `"${title}" is already on offer to the user above the prompt.` }
    }

    const severity = toSeverity(e.severity)
    const finding = toDetail(e.finding)
    const fix = toDetail(e.fix)
    const task: Task = {
      id: newId(),
      title,
      isDone: false,
      ...(severity && { severity }),
      ...(finding && { finding }),
      ...(fix && { fix }),
    }
    await setPending(
      $,
      isSameOffer
        ? { ...held, tasks: [...held.tasks, task] }
        : {
            id: newId(),
            name,
            source: 'ai',
            by: 'claude',
            createdAt: Date.now(),
            tasks: [task],
            project: root,
            ...(target?.number !== undefined && { mergeInto: target.number }),
          },
    )
    $.ui.toast(
      target
        ? `Claude detected a new related task for "${target.name}". Add it from above the prompt.`
        : `Claude detected a new task. Add it from above the prompt.`,
    )

    return {
      result:
        `Offered to the user above the prompt, for ${target ? `L${target.number} "${target.name}"` : `a new list "${name}"`}. ` +
        'It is on no list until they accept it, so do not refer to it by a label or say it was added.',
    }
  })

  on('tool.call', { tool: 'mcp__autotask__set_task_done' }, async ($, e) => {
    const isDone = e.done !== false
    const found = findTask(await refresh($), e)
    if (!found) return { deny: `No task ${String(e.task)} in the AutoTask pane.` }
    const { list, task } = found

    await setDone($, list.id, task.id, isDone)
    await setNote($, list.id, task.id, e.note)

    return { result: `${taskLabel(list, task)} "${task.title}" is now ${isDone ? 'done' : 'open'}.` }
  })

  // "work through #L3", "fix B2": the model gets every task of list 3, or
  // task 2 of list 2, beside the prompt as typed. A label is the list's
  // letters and the task's number, so it names one task wherever it is said.
  on('prompt.submit', async ($, e, next) => {
    // `#L4` alone names a whole list: a plain `L4` is a task label, task 4 of
    // L12, or a cache level or a load balancer.
    const wholeLists = new Set(
      [...e.text.matchAll(/(?<![\w-])#L(\d+)\b(?!-)/gi)].map(match => Number(match[1])),
    )
    // `B3`, `b3` and `#B3`; and the `L2-3` and `#L2-T3` tasks went by before.
    const exact = new Set([
      ...[...e.text.matchAll(/(?<![\w-])(#?)([A-Za-z]{1,2})(\d+)\b(?!-)/g)]
        .filter(match => !(match[1] === '#' && match[2]?.toUpperCase() === 'L'))
        .map(match => `${lettersNumber(match[2] ?? '')}-${Number(match[3])}`),
      ...[...e.text.matchAll(/(?<![\w-])#?L(\d+)-#?T?(\d+)\b/gi)].map(
        match => `${Number(match[1])}-${Number(match[2])}`,
      ),
    ])
    if (wholeLists.size === 0 && exact.size === 0) return next(e)

    const all = await refresh($)

    // The characters each list named in the prompt adds to it, by list id.
    const added = new Map<string, number>()
    const found = all.flatMap(list => {
      const isWhole = list.number !== undefined && wholeLists.has(list.number)
      const described = list.tasks
        .filter(task => isWhole || exact.has(`${list.number}-${task.number}`))
        .map(task => describeTask(list, task))
      const texts = isWhole
        ? [`Task list L${list.number}, "${list.name}", ${list.tasks.length} tasks:`, ...described]
        : described
      if (texts.length > 0) added.set(list.id, texts.join('\n\n').length)

      return texts
    })
    if (found.length === 0) return next(e)

    const note =
      `The user's AutoTask pane (the AutoTask mod) holds numbered task lists (#L3) whose tasks are labelled by the list's letter and their own number (C2 is task 2 of L3). ` +
      `The prompt's references match these, which is most likely what they refer to. ` +
      `Once you have finished and verified a task the user asked you to do, tick it with the mcp__autotask__set_task_done tool; ` +
      `a task the user decided against goes to the list's Deleted section with mcp__autotask__set_task_deleted. ` +
      `Give either tool a short note saying what was done or why it was deleted; the pane shows it under the task. ` +
      `A follow-up you come across that belongs on one of these lists and is not on it is offered to the user with mcp__autotask__add_task.\n\n` +
      found.join('\n\n')

    await change($, held =>
      held.map(list => {
        const chars = added.get(list.id)

        return chars === undefined
          ? list
          : { ...list, usage: addUsage(list.usage, { mentions: 1, contextTokens: toTokens(chars) }) }
      }),
    )
    await addTotals($, { mentions: 1, contextTokens: toTokens(note.length) })

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'autotask' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const text = rest.join(' ')
    await refresh($)
    await $.ui.open({ id: PANE, title: 'AutoTask' })

    if (verb === 'new') {
      return { text: await createList($, text || 'Untitled list') }
    }
    if (verb === 'add') {
      const id = await read($, openId)
      const list = (await read($, lists)).find(one => one.id === id)
      if (text === '') return { text: 'Usage: /autotask add <task>' }
      if (!list) return { text: 'Open a list in the AutoTask pane first, or make one with /autotask new <name>.' }
      await addTask($, list.id, text)

      return { text: `Added to "${list.name}": ${text}` }
    }

    return { text: 'AutoTask pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    // Two free checks before any model call: enough list lines, and a word
    // that findings and action items carry and a plain explanation rarely does.
    const answer = e.answer
    // Kept for "Add to list", which reads it whatever the checks below say.
    await update($, lastAnswer, () => answer)
    if (countListLines(answer) < MIN_LIST_LINES || !TASK_CUES.test(answer)) return done

    // Off a timer, not awaited: the turn ends now and the offer follows.
    $.clock.after(0, () => extractOffer($, answer))

    return done
  })

  // The desktop app spends a first click on moving the pane's focus ring to
  // the button and only presses on a second. So there, the ring landing on one
  // of the pane's everyday buttons acts as its press. The destructive buttons
  // are left out and keep their two clicks; so is the terminal, where the ring
  // moves by Tab and the arrows and must not press what it passes.
  //
  // One click can raise the focus move and a press, in either order, and each
  // would act: `isRepeat`, asked as each event arrives and before anything is
  // awaited, lets the first through and drops the other.
  on('ui.focus', async ($, e, next) => {
    const element =
      paneSurface === 'desktop' && isOurs(e.requestId) && e.origin.kind === 'person'
        ? e.element
        : undefined
    const isFirst = element !== undefined && isEveryday(element) && !isRepeat(element)
    const moved = await next(e)
    if (isFirst && element !== undefined && moved.deny === undefined) await activate($, element)

    return moved
  })

  on('ui.press', ($, e, next) => {
    if (!isOurs(e.requestId)) return next(e)

    return isRepeat(e.element) ? { element: e.element } : next(e)
  })

  // The always-there way in: one button above the prompt, with what is left to do.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const root = await read($, projectRoot)
    const all = (await read($, lists)).filter(list => isInProject(list, root))
    const openCount = all.reduce((sum, list) => sum + live(list).length - countDone(list), 0)
    const offer = await read($, pending)
    const answer = await read($, lastAnswer)
    const names = await read($, labels)
    const target = offer ? all.find(list => list.number === offer.mergeInto) : undefined
    const skipped = await read($, unpicked)
    const isOfferOpen = await read($, offerOpen)
    const pickedCount = offer ? offer.tasks.filter(task => !skipped.includes(task.id)).length : 0
    const items = offer
      ? pickedCount === offer.tasks.length
        ? `${pickedCount} ${pickedCount === 1 ? 'item' : 'items'}`
        : `${pickedCount} of ${offer.tasks.length} items ticked`
      : ''

    // The offer in a line, and what to do with it.
    const offerButtons = offer && (
          <Box flexDirection="row" gap={2}>
            {offer.by === 'claude' ? (
              // Offered by Claude through its add_task tool, not read from an answer.
              <Text>
                Claude detected {offer.tasks.length === 1 ? 'a new related task' : `${offer.tasks.length} new related tasks`}
                {target ? ` for “${target.name}”` : ` · new list “${offer.name}”`}
                {pickedCount !== offer.tasks.length && <Text dimColor> · {pickedCount} ticked</Text>}
              </Text>
            ) : target ? (
              <Text>
                {items} detected for “{target.name}”
              </Text>
            ) : (
              <Text>
                “{offer.name}” detected
                <Text dimColor> · {items}</Text>
              </Text>
            )}
            {target && (
              <Button
                key="offer-merge"
                variant="primary"
                label={`Add to #L${target.number}`}
                onPress={() => acceptPending($, false)}
              />
            )}
            <Button
              key="offer-add"
              variant={target ? 'secondary' : 'primary'}
              label={target ? 'New list' : 'Add to task list'}
              onPress={() => acceptPending($, true)}
            />
            <Button key="offer-dismiss" label="Dismiss" onPress={() => setPending($, null)} />
          </Box>
    )

    return (
      <Box flexDirection="column">
        {offer && offerButtons}
        {offer && (
          // What would be added, worst first, so the choice is made seeing it.
          // Under the buttons, and folded to a few rows until asked for: the
          // band is cut off at the bottom when it grows past its room, and a
          // long offer must not take the buttons with it.
          <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
            {[...offer.tasks]
              .sort((a, b) => severityRank(a) - severityRank(b))
              .slice(0, isOfferOpen ? offer.tasks.length : FOLDED_OFFER_ROWS)
              .map(task => (
                // A box to tick: an item unticked is left out of what is added.
                <Box flexDirection="row" gap={1}>
                  <Button
                    key={`pick-${task.id}`}
                    plain
                    label={skipped.includes(task.id) ? '☐' : '☑'}
                    onPress={() =>
                      update($, unpicked, ids =>
                        ids.includes(task.id) ? ids.filter(one => one !== task.id) : [...ids, task.id],
                      )
                    }
                  />
                  <Text wrap="truncate-end" dimColor={skipped.includes(task.id)}>
                    <Text color={task.severity ? SEVERITY_COLOR[task.severity] : undefined} dimColor={!task.severity}>
                      ●{' '}
                    </Text>
                    {task.title}
                    {task.severity && <Text dimColor> · {labelOf(names, task.severity).toLowerCase()}</Text>}
                  </Text>
                </Box>
              ))}
            {offer.tasks.length > FOLDED_OFFER_ROWS && (
              <Box flexDirection="row">
                <Button
                  key="offer-fold"
                  plain
                  dimColor
                  label={
                    isOfferOpen
                      ? '▾ Show fewer'
                      : `▸ Show all ${offer.tasks.length} (${offer.tasks.length - FOLDED_OFFER_ROWS} more, added unless unticked)`
                  }
                  onPress={() => update($, offerOpen, held => !held)}
                />
              </Box>
            )}
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          <Button
            key="open-tasks"
            plain
            dimColor={openCount === 0}
            label={openCount > 0 ? `☑ AutoTask (${openCount} open)` : '☑ AutoTask'}
            onPress={() => refresh($).then(() => $.ui.open({ id: PANE, title: 'AutoTask' }))}
          />
          {answer !== '' && !offer && (
            // For an answer the mod did not offer by itself: read on request.
            <Button
              key="add-answer"
              plain
              dimColor
              label="+ Add to list"
              onPress={() => {
                $.ui.toast('Reading the last answer for tasks…')
                // Off a timer, not awaited: the press returns now and the offer follows.
                $.clock.after(0, () => extractOffer($, answer, true))
              }}
            />
          )}
        </Box>
      </Box>
    )
  })

  // The window a list's gear opens: what the list has cost, then the mod in
  // all. The Haiku counts are the API's own; the context counts are estimates.
  on('ui.render', { component: 'Pane', requestId: USAGE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const id = await read($, usageOf)
    const list = (await read($, lists)).find(one => one.id === id)
    const spent = addUsage(list?.usage, undefined)
    const all = await read($, totals)

    const line = (label: string, value: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Text dimColor>{label}</Text>
        <Text>{value}</Text>
      </Box>
    )
    const haiku = (one: Usage) => [
      line('Calls', grouped(one.calls)),
      line('Input tokens', grouped(one.input + one.cacheRead + one.cacheWrite)),
      line('Output tokens', grouped(one.output)),
    ]
    const context = (one: Usage) => [
      line('Prompts that named a task', grouped(one.mentions)),
      line('Tokens added', `~${grouped(one.contextTokens)}`),
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text bold>{list ? list.name : 'List not found'}</Text>
          {list?.number !== undefined && <Text dimColor> · #L{list.number}</Text>}
        </Text>
        <Box flexDirection="column">
          <Text bold>Haiku · finding this list's tasks</Text>
          {haiku(spent)}
        </Box>
        <Box flexDirection="column">
          <Text bold>Context added to prompts · estimated</Text>
          {context(spent)}
        </Box>
        <Box flexDirection="column">
          <Text bold>AutoTask in all, every project</Text>
          {haiku(all)}
          {context(all)}
          {line('Tool descriptions, every request', `~${grouped(TOOLS_TOKENS)}`)}
        </Box>
        <Text dimColor wrap="wrap">
          Haiku counts are measured, and in all include the answers read that offered nothing. Context is
          estimated at {CHARS_PER_TOKEN} characters a token.
        </Text>
        <Box flexDirection="row">
          <Button key="closeusage" role="dismiss" label="Close" onPress={() => $.ui.close({ id: USAGE_PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const all = await read($, lists)
    const id = await read($, openId)
    const shown = await read($, expanded)
    paneSurface = e.surface
    // The pane's width in cells, for padding a label into a full-width target.
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 40
    const list = all.find(one => one.id === id)
    const root = await read($, projectRoot)
    const isEveryProject = await read($, showAll)
    const inScope = isEveryProject ? all : all.filter(one => isInProject(one, root))
    // Finished lists sink below the ones with work left, each group in its order.
    const isFinished = (one: TaskList) => live(one).length > 0 && countDone(one) === live(one).length
    const visible = [...inScope.filter(one => !isFinished(one)), ...inScope.filter(isFinished)]
    const editingId = await read($, editing)
    const menuId = await read($, menu)
    const names = await read($, labels)
    const purgingId = await read($, purging)

    const Svg ='Svg' in ui ? ui.Svg : undefined

    // What is still open, worst first: a colored dot and a quiet count each.
    const chips = (one: TaskList) =>
      openBySeverity(one).map(group => (
        <Text>
          <Text color={SEVERITY_COLOR[group.severity]}>● </Text>
          <Text dimColor>
            {group.tasks.length} {labelOf(names, group.severity).toLowerCase()}
          </Text>
        </Text>
      ))

    const progress = (one: TaskList) => {
      const total = live(one).length
      const doneCount = countDone(one)
      const [filled, empty] = bar(doneCount, total)
      const isAllDone = total > 0 && doneCount === total

      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          {Svg ? (
            <Svg source={barSvg(doneCount, total)} alt={`${doneCount} of ${total} done`} />
          ) : (
            <Text>
              <Text color={DONE_COLOR}>{filled}</Text>
              <Text dimColor>{empty}</Text>
            </Text>
          )}
          <Text color={isAllDone ? DONE_COLOR : undefined} dimColor={!isAllDone}>
            {isAllDone ? 'All done' : `${doneCount} of ${total} done`}
          </Text>
        </Box>
      )
    }

    // The settings page, for the whole mod: what each priority is called.
    if (await read($, isSettings)) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row">
            <Button key="back-settings" plain dimColor label="‹ All lists" onPress={() => showList($, '')} />
          </Box>
          <Text bold>Settings</Text>
          <Box flexDirection="column">
            <Text bold>Priority names</Text>
            <Text dimColor wrap="wrap">
              What each priority is called in every list and project. Type a name and press Enter; an empty name
              brings back the usual one.
            </Text>
          </Box>
          {!Input && <Text dimColor>Names cannot be typed on this surface.</Text>}
          {SEVERITIES.map(severity => (
            <Box key={`name-${severity}`} flexDirection="row" gap={1} alignItems="center">
              <Text color={SEVERITY_COLOR[severity]}>●</Text>
              {/* One width for every name, so the fields line up in a column. */}
              <Box width={LABEL_COLUMN} flexShrink={0}>
                <Text>{SEVERITY_LABEL[severity]}</Text>
              </Box>
              {Input ? (
                <Input
                  key={`label-${severity}`}
                  placeholder={SEVERITY_LABEL[severity]}
                  value={names[severity] ?? ''}
                  submitLabel="save"
                  onSubmit={value => setLabel($, severity, value)}
                />
              ) : (
                <Text>{labelOf(names, severity)}</Text>
              )}
            </Box>
          ))}
          <Box flexDirection="row">
            <Button
              key="resetnames"
              label="Reset all names"
              onPress={() => update($, labels, () => ({})).then(() => $.store.delete(LABELS_KEY))}
            />
          </Box>
        </Box>
      )
    }

    if (!list) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text>
              <Text bold>AutoTask</Text>
              <Text dimColor>
                {' '}
                · {isEveryProject ? 'all projects' : folderName(root)} · {visible.length}
              </Text>
            </Text>
            <Box flexDirection="row" gap={2}>
              <Button
                key="scope"
                plain
                dimColor
                label={isEveryProject ? 'Show this project' : `Show all projects (${all.length})`}
                onPress={() => update($, showAll, held => !held)}
              />
              <Button
                key="settings"
                plain
                dimColor
                label="Settings"
                onPress={() => update($, isSettings, () => true)}
              />
            </Box>
          </Box>
          {visible.length === 0 && (
            <Box borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor>
                {all.length === 0
                  ? 'No lists yet. One is offered when Claude answers with findings or action items.'
                  : 'No lists for this project yet. Your other projects have some.'}
              </Text>
            </Box>
          )}
          {visible.map(one => (
            <Box
              key={`card-${one.id}`}
              flexDirection="column"
              borderStyle="round"
              borderDimColor
              hover={{ borderDimColor: false }}
              paddingX={1}
            >
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Button
                    key={`open-${one.id}`}
                    plain
                    label={one.name + ' '.repeat(Math.max(0, columns - one.name.length - 18))}
                    onPress={() => showList($, one.id)}
                  />
                </Box>
                <Text dimColor>
                  {isEveryProject && one.project ? `${folderName(one.project)} · ` : ''}
                  {one.number !== undefined ? `#L${one.number} · ` : ''}
                  {one.source === 'ai' ? 'From Claude' : 'Yours'}
                </Text>
              </Box>
              {progress(one)}
              <Box flexDirection="row" justifyContent="space-between" gap={2}>
                <Box flexDirection="row" gap={2} flexWrap="wrap" flexShrink={1}>
                  {chips(one)}
                </Box>
                <Box flexDirection="row" gap={2}>
                  <Button
                    key={`usage-${one.id}`}
                    plain
                    dimColor
                    label="⚙"
                    onPress={() => showUsage($, one.id)}
                  />
                  <Button
                    key={`trash-${one.id}`}
                    plain
                    dimColor
                    label="Delete"
                    onPress={() => confirmDelete($, one.id)}
                  />
                </Box>
              </Box>
            </Box>
          ))}
          {Input && (
            <Box marginTop={1} paddingBottom={1}>
              <Input
                key="new-list"
                label="New list"
                placeholder="name"
                value=""
                submitLabel="create"
                onSubmit={value => {
                  const name = value.trim()
                  if (name === '') return
                  return createList($, name).then(said => $.ui.toast(said))
                }}
              />
            </Box>
          )}
        </Box>
      )
    }

    const toggle = (task: Task) => setDone($, list.id, task.id)

    const detail = (label: string, text: string) => (
      <Box flexDirection="column">
        <Text dimColor>{label}</Text>
        <Markdown text={text} />
      </Box>
    )

    // The "⋯" options of a task: its priority and the list to move it to. Of
    // the whole list, with no task: the list to move every task to, and
    // emptying its Deleted section.
    const others = inScope.filter(one => one.id !== list.id)
    const options = (task?: Task) => (
      <Box flexDirection="row" gap={2} flexWrap="wrap" paddingLeft={task ? 4 : 0} paddingBottom={task ? 1 : 0}>
        {task && Select && (
          <Select
            key={`priority-${task.id}`}
            label="Priority"
            options={priorityOptions(names)}
            value={task.severity ?? NO_PRIORITY}
            onSelect={value => setSeverity($, list.id, task.id, value)}
          />
        )}
        {!task && list.tasks.some(one => one.isDeleted) && (
          <Button key={`empty-${list.id}`} label="Empty Deleted" onPress={() => emptyDeleted($, list.id)} />
        )}
        {others.length === 0 || !Select ? (
          <Text dimColor>No other list to move to.</Text>
        ) : (
          <Select
            key={`move-${task?.id ?? list.id}`}
            label={task ? 'Move to' : 'Move all tasks to'}
            options={[
              { value: NO_LIST, label: 'Choose a list…' },
              ...others.map(one => ({ value: one.id, label: `#L${one.number} ${one.name}` })),
            ]}
            value={NO_LIST}
            onSelect={value => {
              if (value !== NO_LIST) return moveTasks($, list.id, value, task?.id)
            }}
          />
        )}
      </Box>
    )

    // One field of the task being edited: its name above a text box holding
    // what the task has. Typing is kept as a draft for Save; Enter saves all.
    const field = (task: Task, name: Field, label: string, placeholder: string) =>
      Input && (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Input
            key={`${name}-${task.id}`}
            placeholder={placeholder}
            value={task[name] ?? ''}
            submitLabel="↵"
            onInput={value => {
              drafts.set(name, value)
            }}
            onSubmit={value => {
              drafts.set(name, value)

              return saveEdit($, list.id, task.id)
            }}
          />
        </Box>
      )

    // One task: a chevron that opens its finding and fix beneath it, the
    // check, the title, and a remove control that shows while the pointer is
    // on the row. Its section already says how severe it is.
    const row = (task: Task) => {
      const isShown = shown.includes(task.id)
      const isEdited = editingId === task.id

      return (
        <Box key={`row-${task.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {hasDetail(task) ? (
              <Button
                key={`expand-${task.id}`}
                plain
                dimColor
                label={isShown ? '▾' : '▸'}
                onPress={() => toggleExpanded($, task.id)}
              />
            ) : (
              <Text> </Text>
            )}
            <Button
              key={`toggle-${task.id}`}
              plain
              dimColor
              label={task.isDone ? '✓' : '○'}
              onPress={() => toggle(task)}
            />
            <Text dimColor>{taskLabel(list, task)}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor={task.isDone} strikethrough={task.isDone} wrap="wrap">
                {task.title}
              </Text>
            </Box>
            <Box display="none" hover={{ display: 'flex' }} flexDirection="row" gap={1}>
              {Input && !isEdited && (
                <Button
                  key={`edit-${task.id}`}
                  plain
                  dimColor
                  label="✎"
                  onPress={() => toggleEditing($, task.id)}
                />
              )}
              <Button
                key={`menu-${task.id}`}
                plain
                dimColor
                label="⋯"
                onPress={() => toggleMenu($, task.id)}
              />
              <Button
                key={`remove-${task.id}`}
                plain
                dimColor
                label="✕"
                onPress={() => setDeleted($, list.id, task.id, true)}
              />
            </Box>
          </Box>
          {menuId === task.id && options(task)}
          {isEdited && Input && (
            <Box flexDirection="column" gap={1} paddingLeft={4} paddingBottom={1}>
              {field(task, 'title', 'Title', 'what needs doing')}
              {field(task, 'finding', 'Finding', 'what is wrong')}
              {field(task, 'fix', 'Fix', 'what to do about it')}
              <Box flexDirection="row" gap={2}>
                <Button
                  key={`save-${task.id}`}
                  variant="primary"
                  label="Save"
                  onPress={() => saveEdit($, list.id, task.id)}
                />
                <Button key={`cancel-${task.id}`} label="Cancel" onPress={() => toggleEditing($, task.id)} />
              </Box>
            </Box>
          )}
          {isShown && !isEdited && (
            <Box flexDirection="column" gap={1} paddingLeft={4} paddingBottom={1}>
              {task.note !== undefined && detail('Claude Notes', task.note)}
              {task.finding !== undefined && detail('Finding', task.finding)}
              {task.fix !== undefined && detail('Fix', task.fix)}
            </Box>
          )}
        </Box>
      )
    }

    const section = (title: string, color: string | undefined, tasks: Task[]) => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={color} dimColor={color === undefined}>
            ●
          </Text>
          <Text dimColor>
            {title} · {tasks.length}
          </Text>
        </Box>
        {tasks.map(row)}
      </Box>
    )

    const unrated = live(list).filter(task => !task.isDone && !task.severity)
    const finished = live(list).filter(task => task.isDone)
    const removed = list.tasks.filter(task => task.isDeleted)
    const open = await read($, unfolded)
    const isRemovedShown = open.includes(`deleted-${list.id}`)
    const isFinishedShown = open.includes(`done-${list.id}`)
    const detailed = live(list)
      .filter(hasDetail)
      .map(task => task.id)
    const isAllShown = detailed.length > 0 && detailed.every(one => shown.includes(one))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row">
          <Button key="back-top" plain dimColor label="‹ All lists" onPress={() => showList($, '')} />
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text bold>{list.name}</Text>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                {list.number !== undefined ? `#L${list.number} · ` : ''}
                {list.source === 'ai' ? 'From Claude' : 'Yours'}
              </Text>
              <Button key={`usage-${list.id}`} plain dimColor label="⚙" onPress={() => showUsage($, list.id)} />
              <Button key={`menu-${list.id}`} plain dimColor label="⋯" onPress={() => toggleMenu($, list.id)} />
            </Box>
          </Box>
          {progress(list)}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {chips(list)}
          </Box>
          {menuId === list.id && options()}
        </Box>
        {list.tasks.length === 0 && <Text dimColor>No tasks yet.</Text>}
        {openBySeverity(list).map(group =>
          section(labelOf(names, group.severity), SEVERITY_COLOR[group.severity], group.tasks),
        )}
        {unrated.length > 0 && section(list.source === 'ai' ? 'Other' : 'To do', undefined, unrated)}
        {finished.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button
                key={`done-${list.id}`}
                plain
                dimColor
                label={`${isFinishedShown ? '▾' : '▸'} Done · ${finished.length}`}
                onPress={() => toggleFold($, `done-${list.id}`)}
              />
            </Box>
            {isFinishedShown && finished.map(row)}
          </Box>
        )}
        {removed.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Button
                key={`deleted-${list.id}`}
                plain
                dimColor
                label={`${isRemovedShown ? '▾' : '▸'} Deleted · ${removed.length}`}
                onPress={() => toggleFold($, `deleted-${list.id}`)}
              />
            </Box>
            {isRemovedShown &&
              removed.map(task => (
                <Box key={`gone-${task.id}`} flexDirection="column" paddingLeft={2}>
                <Box flexDirection="row" gap={1} alignItems="flex-start">
                  <Text dimColor>{taskLabel(list, task)}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text dimColor strikethrough wrap="wrap">
                      {task.title}
                    </Text>
                  </Box>
                  <Box display="none" hover={{ display: 'flex' }} flexDirection="row" gap={1}>
                    <Button
                      key={`restore-${task.id}`}
                      plain
                      dimColor
                      label="Restore"
                      onPress={() => setDeleted($, list.id, task.id, false)}
                    />
                    <Button
                      key={`purge-${task.id}`}
                      plain
                      dimColor
                      label="✕"
                      onPress={() => update($, purging, () => task.id)}
                    />
                  </Box>
                </Box>
                {purgingId === task.id && (
                  <Box flexDirection="row" gap={2} alignItems="center" paddingLeft={taskLabel(list, task).length + 1}>
                    <Text>Remove for good?</Text>
                    <Button
                      key={`purgeyes-${task.id}`}
                      variant="primary"
                      label="Remove"
                      onPress={() => purgeTask($, list.id, task.id)}
                    />
                    <Button
                      key={`purgeno-${task.id}`}
                      label="Cancel"
                      onPress={() => update($, purging, () => '')}
                    />
                  </Box>
                )}
                {task.note !== undefined && (
                  // Under the title, clear of the label, so the label stays
                  // beside the line it names.
                  <Box paddingLeft={taskLabel(list, task).length + 1}>
                    <Text dimColor italic wrap="wrap">
                      ↳ {task.note}
                    </Text>
                  </Box>
                )}
                </Box>
              ))}
          </Box>
        )}
        {Input && (
          <Box marginTop={1}>
            <Input
              key="new-task"
              label="Add task"
              placeholder="what needs doing"
              value=""
              submitLabel="add"
              onSubmit={value => {
                const title = value.trim()
                if (title !== '') return addTask($, list.id, title)
              }}
            />
          </Box>
        )}
        <Box flexDirection="row" gap={2}>
          {detailed.length > 0 && (
            <Button
              key="all-details"
              label={isAllShown ? 'Collapse all' : 'Expand all'}
              onPress={() =>
                update($, expanded, ids =>
                  isAllShown
                    ? ids.filter(one => !detailed.includes(one))
                    : [...new Set([...ids, ...detailed])],
                )
              }
            />
          )}
          <Button
            key={`trash-${list.id}`}
            label="Delete list"
            dimColor
            onPress={() => confirmDelete($, list.id)}
          />
        </Box>
      </Box>
    )
  })
}
