/**
 * Frank Grimes — an opencode plugin that autonomously processes forge issues.
 *
 * State machine: get_next_issue → plan → build → verify → (pass → close + next issue)
 *                                                  └→ fail → retry build or re-plan
 *
 * Design decisions:
 * - One opencode session per issue — plan+build+verify accumulate context so the agent
 *   remembers what it tried and why. Session is reused across all phases.
 * - MCP tools (get_next_issue, update_issue, get_issue) are called via ephemeral sessions
 *   because the plugin API has no direct MCP client. Each call creates a temp session,
 *   asks an LLM agent to invoke the tool, and parses the text response. This is slow but
 *   is the only way available.
 * - Verify commands run externally via execSync — exit codes are deterministic and don't
 *   need LLM judgment. The LLM only evaluates failures to distinguish real bugs from
 *   false positives.
 * - Issue context (body, comments, commits) is re-fetched from the forge at every phase
 *   transition so the agent sees comments humans may have added mid-loop.
 */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event, EventTuiToastShow, Message as SdkMessage, Part as SdkPart } from "@opencode-ai/sdk"
export type { Message as SdkMessage, Part as SdkPart, Session as SdkSession } from "@opencode-ai/sdk"
import { readFile, writeFile, mkdir, appendFile, unlink } from "node:fs/promises"
import path from "node:path"
import { execSync } from "node:child_process"

export type GrimesPhase = "plan" | "build" | "verify"

export interface GrimesConfig {
  enabled: boolean
  milestone_id: number | null
  create_mr: boolean
  max_retries: number
}

export interface GrimesState {
  issue_number: number
  milestone_id: number | null
  state: GrimesPhase
  session_id: string
  attempt: number
  total_build_attempts: number
  replan_count: number
}

export const DEFAULT_VERIFY_TIMEOUT = 120_000

export interface VerifyCommand {
  command: string
  timeout_ms?: number
}

export interface GrimesVerify {
  commands: Array<string | VerifyCommand>
}

export interface VerifyResult {
  command: string
  exit_code: number
  stdout: string
  stderr: string
}

export interface Verdict {
  verdict: "pass" | "fail"
  reason?: string | undefined
}

export interface ExecError extends Error {
  status?: number
  stdout?: string
  stderr?: string
}

export type GrimesClient = PluginInput["client"]

export interface MessageEntry {
  info: SdkMessage
  parts: SdkPart[]
}

// After this many total build failures across all retry cycles, abandon the current
// approach and re-plan from scratch. Separate from max_retries (which is per-cycle)
// because a single bad plan can exhaust retries without ever being questioned.
export const PLAN_RETRY_THRESHOLD = 6

const GRIMES_DEBUG = process.env["GRIMES_DEBUG"] === "1"
type DebugFn = (...args: Array<unknown>) => void
const debugFn: DebugFn = () => {}

let debug: DebugFn = debugFn

// Fire-and-forget async logger — never await or throw.
// GRIMES_DEBUG=1 enables writing to .grimes/debug.log. Never writes to stdout/stderr
// because that would pollute the MCP stdio channel.
export function initDebugLogger(directory: string): void {
  if (!GRIMES_DEBUG) {
    return
  }
  const logPath = path.join(directory, ".grimes", "debug.log")
  let dirEnsured = false
  debug = (...args: Array<unknown>): void => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    const ts = new Date().toISOString()
    const line = `[${ts}] [Grimes] ${msg}\n`
    void (async (): Promise<void> => {
      if (!dirEnsured) {
        try {
          await mkdir(path.join(directory, ".grimes"), { recursive: true })
        } catch {
          // directory creation failure is non-fatal
        }
        dirEnsured = true
      }
      try {
        await appendFile(logPath, line)
      } catch {
        // log write failure is non-fatal
      }
    })()
  }
}

export function grimesDir(directory: string): string {
  return path.join(directory, ".grimes")
}

async function ensureGrimesDir(directory: string): Promise<string> {
  const dir = grimesDir(directory)
  try { await mkdir(dir, { recursive: true }) } catch { /* non-fatal */ }
  return dir
}

export async function readConfig(directory: string): Promise<GrimesConfig | null> {
  try {
    const content = await readFile(path.join(grimesDir(directory), "loop.json"), "utf8")
    return JSON.parse(content) as GrimesConfig
  } catch {
    return null
  }
}

export async function readState(directory: string): Promise<GrimesState | null> {
  try {
    const content = await readFile(path.join(grimesDir(directory), "state.json"), "utf8")
    return JSON.parse(content) as GrimesState
  } catch {
    return null
  }
}

export async function writeState(directory: string, state: GrimesState): Promise<void> {
  const dir = await ensureGrimesDir(directory)
  await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2))
}

export async function clearState(directory: string): Promise<void> {
  try {
    await unlink(path.join(grimesDir(directory), "state.json"))
  } catch {
    // file deletion failure is non-fatal
  }
}

export async function readVerifyConfig(directory: string): Promise<GrimesVerify | null> {
  try {
    const content = await readFile(path.join(grimesDir(directory), "verify.json"), "utf8")
    return JSON.parse(content) as GrimesVerify
  } catch {
    return null
  }
}

// Overwrites loop.json with enabled:false instead of deleting it, so a human can
// re-enable by flipping the flag. Missing file = disabled, same as enabled:false.
export async function disableLoop(directory: string): Promise<void> {
  const dir = await ensureGrimesDir(directory)
  await writeFile(path.join(dir, "loop.json"), JSON.stringify({ enabled: false }, null, 2))
}

// Runs verify commands synchronously. Using execSync rather than letting the LLM run
// checks because exit codes are deterministic — all-zero always means pass, no LLM
// judgment needed. The LLM only gets involved when something fails, to decide whether
// it's a real bug or a false positive.
export function runVerifyCommand(command: string, cwd: string, timeoutMs: number = DEFAULT_VERIFY_TIMEOUT): VerifyResult {
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { command, exit_code: 0, stdout, stderr: "" }
  } catch (error: unknown) {
    const execErr = error as ExecError
    return {
      command,
      exit_code: execErr.status ?? 1,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
    }
  }
}

function normalizeVerifyEntry(entry: string | VerifyCommand): VerifyCommand {
  if (typeof entry === "string") {
    return { command: entry }
  }
  return entry
}

export function runVerifyCommands(commands: Array<string | VerifyCommand>, cwd: string): VerifyResult[] {
  return commands.map(entry => {
    const cmd = normalizeVerifyEntry(entry)
    return runVerifyCommand(cmd.command, cwd, cmd.timeout_ms ?? DEFAULT_VERIFY_TIMEOUT)
  })
}

// LLM output is unpredictable — it may wrap the JSON in prose, markdown fences, or
// both. Regex-extract the first {...} block rather than trying to parse the full text.
export function parseVerdict(text: string | null | undefined): Verdict | null {
  if (typeof text !== "string") {
    return null
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch === null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0])
    if (typeof parsed === "object" && parsed !== null && "verdict" in parsed) {
      const obj = parsed as Record<string, unknown>
      if (obj["verdict"] === "pass" || obj["verdict"] === "fail") {
        return { verdict: obj["verdict"], reason: typeof obj["reason"] === "string" ? obj["reason"] : undefined }
      }
    }
    return null
  } catch {
    return null
  }
}

export function extractLastAssistantText(messages: MessageEntry[]): string | null {
  if (!Array.isArray(messages)) {
    return null
  }
  const assistantMsg = [...messages].reverse().find(m => m.info.role === "assistant")
  if (assistantMsg === undefined) {
    return null
  }
  for (const part of [...assistantMsg.parts].reverse()) {
    if (part.type === "text" && part.text.length > 0) {
      return part.text
    }
  }
  return null
}

export async function showToast(client: GrimesClient, directory: string, message: string, variant: EventTuiToastShow["properties"]["variant"] = "info"): Promise<void> {
  try {
    void await client.tui.publish({
      query: { directory },
      body: {
        type: "tui.toast.show",
        properties: { title: "Grimes", message, variant, duration: 5000 },
      } satisfies EventTuiToastShow,
    })
  } catch {
    // toast failure is non-fatal
  }
}

async function sendPrompt(client: GrimesClient, sessionId: string, text: string, agent?: string): Promise<void> {
  const parts = [{ type: "text" as const, text }]
  await client.session.promptAsync({
    path: { id: sessionId },
    body: agent === undefined ? { parts } : { agent, parts },
  })
}

export interface FetchedIssue {
  number: number
  title: string
  body: string
  state: string
  labels: string[]
  dependencies: number[]
  comments: string[]
  url: string
}

export interface ForgeError {
  kind: "config" | "auth" | "network" | "api"
  status: number
  message: string
}

export type ForgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ForgeError }

export type ForgeBackend = "gitea" | "gitlab" | "github"

export interface ForgeConfig {
  backend: ForgeBackend
  apiBase: string
  token: string
  owner: string
  repo: string
  projectPath: string
  projectEncoded: string
}

export interface ForgeMilestone {
  id: number
  title: string
  html_url?: string
  open_issues?: number
}

export interface ForgeLabel {
  id: number
  name: string
}

export interface ForgeIssue {
  number: number
  title: string
  state: string
  html_url?: string
  web_url?: string
  body?: string
  labels?: ForgeLabel[]
}

export interface ForgeComment {
  body: string
}

export interface ForgeLink {
  iid: number
  state: string
  title?: string
  link_type?: string
}

export function forgeOk<T>(value: T): ForgeResult<T> {
  return { ok: true, value }
}

export function forgeErr<T>(kind: ForgeError["kind"], status: number, message: string): ForgeResult<T> {
  return { ok: false, error: { kind, status, message } }
}

interface BackendAdapter {
  buildUrl: (apiBase: string, owner: string, repo: string, projectEncoded: string, apiPath: string) => string
  buildHeaders: (token: string) => Record<string, string>
  commentsPath: (issueNumber: number) => string
  dependenciesPath: (issueNumber: number) => string
  blocksPath: (issueNumber: number) => string
  issueListPath: (state: string, limit: number, milestoneId?: number) => string
  statePayload: (state: string) => Record<string, string>
  milestoneKey: () => string
  updateIssueMethod: () => string
}

const GITEA_ADAPTER: BackendAdapter = {
  buildUrl(apiBase, owner, repo, _projectEncoded, apiPath) {
    return `${apiBase}/api/v1/repos/${owner}/${repo}${apiPath}`
  },
  buildHeaders(token) {
    return { "Content-Type": "application/json", "Authorization": `token ${token}`, "Accept": "application/json" }
  },
  commentsPath(issueNumber) { return `/issues/${issueNumber}/comments` },
  dependenciesPath(issueNumber) { return `/issues/${issueNumber}/dependencies` },
  blocksPath(issueNumber) { return `/issues/${issueNumber}/blocks` },
  issueListPath(state, limit, milestoneId) {
    let p = `/issues?state=${state}&limit=${limit}&type=issues`
    if (milestoneId !== undefined) { p += `&milestone_id=${milestoneId}` }
    return p
  },
  statePayload(state) { return { state } },
  milestoneKey() { return "milestone" as const },
  updateIssueMethod() { return "PATCH" },
}

const GITLAB_ADAPTER: BackendAdapter = {
  buildUrl(apiBase, _owner, _repo, projectEncoded, apiPath) {
    return `${apiBase}/api/v4/projects/${projectEncoded}${apiPath}`
  },
  buildHeaders(token) {
    return { "Content-Type": "application/json", "PRIVATE-TOKEN": token }
  },
  commentsPath(issueNumber) { return `/issues/${issueNumber}/notes?sort=asc&per_page=100` },
  dependenciesPath(issueNumber) { return `/issues/${issueNumber}/links` },
  blocksPath(issueNumber) { return `/issues/${issueNumber}/links` },
  issueListPath(state, limit, milestoneId) {
    const stateVal = state === "open" ? "opened" : state
    let p = `/issues?state=${stateVal}&per_page=${limit}&scope=all`
    if (milestoneId !== undefined) { p += `&milestone_id=${milestoneId}` }
    return p
  },
  statePayload(state) {
    return state === "closed" ? { state_event: "close" } : { state_event: "reopen" }
  },
  milestoneKey() { return "milestone_id" as const },
  updateIssueMethod() { return "PUT" },
}

const GITHUB_ADAPTER: BackendAdapter = {
  buildUrl(apiBase, owner, repo, _projectEncoded, apiPath) {
    return `${apiBase}/repos/${owner}/${repo}${apiPath}`
  },
  buildHeaders(token) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  },
  commentsPath(issueNumber) { return `/issues/${issueNumber}/comments` },
  dependenciesPath(issueNumber) { return `/issues/${issueNumber}/sub_issues` },
  blocksPath(issueNumber) { return `/issues/${issueNumber}/parent` },
  issueListPath(state, limit, milestoneId) {
    let p = `/issues?state=${state}&per_page=${limit}`
    if (milestoneId !== undefined) { p += `&milestone=${milestoneId}` }
    return p
  },
  statePayload(state) { return { state } },
  milestoneKey() { return "milestone" as const },
  updateIssueMethod() { return "PATCH" },
}

function getAdapter(backend: ForgeBackend): BackendAdapter {
  switch (backend) {
    case "gitlab": { return GITLAB_ADAPTER }
    case "github": { return GITHUB_ADAPTER }
    case "gitea": { return GITEA_ADAPTER }
  }
}

// ─── Config loading ──────────────────────────────────────────────────────────

// Walk up from startDir looking for a file. Returns the file path or null.
function loadEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) { continue }
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) { continue }
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

function parseRepoUrl(url: string): { base: string; owner: string; repo: string } | null {
  const m = url.trim().match(/(https?:\/\/[^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m === null) { return null }
  const base = m[1] ?? ""
  const parts = (m[2] ?? "").replace(/\/+$/, "").split("/")
  if (parts.length < 2) { return null }
  return { base, owner: parts.at(-2) ?? "", repo: parts.at(-1) ?? "" }
}

function parseGitlabProjectPath(url: string): { base: string; projectPath: string } | null {
  const m = url.trim().match(/(https?:\/\/[^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m === null) { return null }
  return { base: m[1] ?? "", projectPath: (m[2] ?? "").replace(/\/+$/, "") }
}

export async function loadForgeConfig(startDir: string): Promise<ForgeResult<ForgeConfig>> {
  const cfg: Record<string, string> = {}

  const envPath = path.join(grimesDir(startDir), "env")
  try {
    const content = await readFile(envPath, "utf8")
    Object.assign(cfg, loadEnvFile(content))
  } catch {
    // .grimes/env not found — will fall through to environment variables
  }

  for (const key of ["GITEA_URL", "GITEA_TOKEN", "GITLAB_URL", "GITLAB_TOKEN", "GITHUB_URL", "GITHUB_TOKEN"] as const) {
    const envVal = process.env[key]
    if (envVal !== undefined && envVal !== "") {
      cfg[key] = envVal
    }
  }

  const hasGitlab = (cfg["GITLAB_URL"] ?? "") !== ""
  const hasGitea = (cfg["GITEA_URL"] ?? "") !== ""
  const hasGithub = (cfg["GITHUB_URL"] ?? "") !== ""
  const configured = [hasGitlab, hasGitea, hasGithub].filter(Boolean).length

  if (configured > 1) {
    return forgeErr("config", 0, "Multiple backends configured. Set only one of GITEA_URL, GITLAB_URL, or GITHUB_URL.")
  }

  type ParsedBackend = Pick<ForgeConfig, "apiBase" | "owner" | "repo" | "projectPath" | "projectEncoded">
  const backends: Array<{ backend: ForgeBackend; urlKey: string; tokenKey: string; parse: (url: string) => ParsedBackend | null }> = [
    {
      backend: "gitlab",
      urlKey: "GITLAB_URL",
      tokenKey: "GITLAB_TOKEN",
      parse: (url) => {
        const p = parseGitlabProjectPath(url)
        if (p === null) { return null }
        return { apiBase: p.base, owner: "", repo: "", projectPath: p.projectPath, projectEncoded: encodeURIComponent(p.projectPath) }
      },
    },
    {
      backend: "github",
      urlKey: "GITHUB_URL",
      tokenKey: "GITHUB_TOKEN",
      parse: (url) => {
        const p = parseRepoUrl(url)
        if (p === null) { return null }
        return { apiBase: p.base, owner: p.owner, repo: p.repo, projectPath: "", projectEncoded: "" }
      },
    },
    {
      backend: "gitea",
      urlKey: "GITEA_URL",
      tokenKey: "GITEA_TOKEN",
      parse: (url) => {
        const p = parseRepoUrl(url)
        if (p === null) { return null }
        return { apiBase: p.base, owner: p.owner, repo: p.repo, projectPath: "", projectEncoded: "" }
      },
    },
  ]

  for (const def of backends) {
    if ((cfg[def.urlKey] ?? "") === "") { continue }
    const token = cfg[def.tokenKey] ?? ""
    if (token === "") { return forgeErr("config", 0, `${def.urlKey} is set but ${def.tokenKey} is missing.`) }
    const parsed = def.parse(cfg[def.urlKey] ?? "")
    if (parsed === null) { return forgeErr("config", 0, `Cannot parse ${def.urlKey}: ${cfg[def.urlKey] ?? ""}`) }
    return forgeOk({ backend: def.backend, token, ...parsed })
  }

  return forgeErr("config", 0, "No backend configured. Set GITEA_URL, GITLAB_URL, or GITHUB_URL in .grimes/env or environment variables.")
}

// ─── HTTP layer ──────────────────────────────────────────────────────────────

const MAX_NETWORK_RETRIES = 3
const RETRY_DELAYS = [2000, 4000, 8000]

function buildUrl(config: ForgeConfig, apiPath: string): string {
  return getAdapter(config.backend).buildUrl(config.apiBase, config.owner, config.repo, config.projectEncoded, apiPath)
}

function buildHeaders(config: ForgeConfig): Record<string, string> {
  return getAdapter(config.backend).buildHeaders(config.token)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Low-level fetch with retry. delayMs=0 skips delays (for tests).
export async function forgeFetch(
  config: ForgeConfig,
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
  delayMs = 2000,
): Promise<ForgeResult<unknown>> {
  const url = buildUrl(config, apiPath)
  const headers = buildHeaders(config)

  for (let attempt = 0; attempt < MAX_NETWORK_RETRIES; attempt++) {
    try {
      const opts: RequestInit = { method, headers }
      if (body !== undefined) {
        opts.body = JSON.stringify(body)
      }
      const resp = await fetch(url, opts)

      if (resp.status === 401 || resp.status === 403) {
        const text = await resp.text()
        return forgeErr("auth", resp.status, text)
      }

      if (resp.status >= 400) {
        const text = await resp.text()
        let detail = text
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>
          if (typeof parsed["message"] === "string") { detail = parsed["message"] }
          else if (typeof parsed["error"] === "string") { detail = parsed["error"] }
        } catch {
          // use raw text
        }
        return forgeErr("api", resp.status, detail)
      }

      const raw = await resp.text()
      if (raw.length === 0) { return forgeOk(null) }
      return forgeOk(JSON.parse(raw))
    } catch (error: unknown) {
      const isNetworkError = error instanceof TypeError || (error instanceof Error && !(error instanceof SyntaxError))
      if (!isNetworkError || attempt === MAX_NETWORK_RETRIES - 1) {
        const msg = error instanceof Error ? error.message : String(error)
        return forgeErr("network", 0, msg)
      }
      const delay = delayMs === 0 ? 0 : (RETRY_DELAYS[attempt] ?? 8000)
      if (delay > 0) { await sleep(delay) }
    }
  }

  return forgeErr("network", 0, "Max retries exceeded")
}

// ─── Backend adapters ────────────────────────────────────────────────────────

export function normalizeState(state: string): string {
  return state === "opened" ? "open" : state
}

function forgeWebUrl(issue: ForgeIssue): string {
  return issue.web_url ?? issue.html_url ?? ""
}

export function buildIssueListPath(
  backend: ForgeBackend,
  state: string,
  limit: number,
  milestoneId: number | undefined,
): string {
  return getAdapter(backend).issueListPath(state, limit, milestoneId)
}

export function buildBody(description: string, tasks: string[], tests: string[]): string {
  const lines: string[] = [
    "### Description",
    "",
    description.trim(),
    "",
    "### Tasks",
    "",
  ]
  for (const t of tasks) { lines.push(`- [ ] ${t.trim()}`) }
  lines.push("", "### Tests", "")
  for (const t of tests) { lines.push(`- [ ] ${t.trim()}`) }
  lines.push("")
  return lines.join("\n")
}

function setStatePayload(backend: ForgeBackend, state: string): Record<string, string> {
  return getAdapter(backend).statePayload(state)
}

// ─── Forge tool implementations ──────────────────────────────────────────────

async function getDependencies(config: ForgeConfig, issueNumber: number): Promise<ForgeResult<ForgeIssue[]>> {
  const apiPath = getAdapter(config.backend).dependenciesPath(issueNumber)
  const result = await forgeFetch(config, "GET", apiPath)
  if (!result.ok) { return result }

  switch (config.backend) {
    case "gitlab": {
      const links = (result.value ?? []) as ForgeLink[]
      return forgeOk(links
        .filter(l => l.link_type === "is_blocked_by" || l.link_type === "blocks")
        .map(l => ({ number: l.iid, title: l.title ?? "", state: normalizeState(l.state) }))
      )
    }
    case "github": {
      const subs = (result.value ?? []) as ForgeIssue[]
      return forgeOk(subs.map(s => ({
        number: s.number, title: s.title,
        state: normalizeState(s.state), html_url: s.html_url ?? "",
      })))
    }
    case "gitea": {
      return forgeOk((result.value ?? []) as ForgeIssue[])
    }
  }
}

async function getBlocks(config: ForgeConfig, issueNumber: number, openNumbers: Set<number>): Promise<ForgeResult<ForgeIssue[]>> {
  const apiPath = getAdapter(config.backend).blocksPath(issueNumber)
  const result = await forgeFetch(config, "GET", apiPath)
  if (!result.ok) { return result }

  switch (config.backend) {
    case "gitlab": {
      const links = (result.value ?? []) as ForgeLink[]
      return forgeOk(links
        .filter(l => l.link_type === "blocks" && openNumbers.has(l.iid))
        .map(l => ({ number: l.iid, title: l.title ?? "", state: normalizeState(l.state) }))
      )
    }
    case "github": {
      const parent = result.value as ForgeIssue
      if (openNumbers.has(parent.number)) {
        return forgeOk([{ number: parent.number, title: parent.title, state: normalizeState(parent.state) }])
      }
      return forgeOk([])
    }
    case "gitea": {
      return forgeOk((result.value ?? []) as ForgeIssue[])
    }
  }
}

async function getComments(config: ForgeConfig, issueNumber: number): Promise<ForgeComment[]> {
  const result = await forgeFetch(config, "GET", getAdapter(config.backend).commentsPath(issueNumber))
  if (result.ok && Array.isArray(result.value)) {
    return result.value as ForgeComment[]
  }
  return []
}

export async function forgeGetIssue(config: ForgeConfig, issueNumber: number): Promise<ForgeResult<FetchedIssue>> {
  const issueResult = await forgeFetch(config, "GET", `/issues/${issueNumber}`)
  if (!issueResult.ok) { return issueResult }
  const raw = issueResult.value as ForgeIssue
  const issue: ForgeIssue = { ...raw, state: normalizeState(raw.state) }

  const comments = await getComments(config, issueNumber)

  let depIds: number[] = []
  const depsResult = await getDependencies(config, issueNumber)
  if (depsResult.ok && Array.isArray(depsResult.value)) {
    depIds = depsResult.value.map(d => d.number)
  }

  return forgeOk({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    labels: (issue.labels ?? []).map(l => l.name),
    dependencies: depIds,
    comments: comments.map(c => c.body),
    url: forgeWebUrl(issue),
  })
}

export async function forgeGetNextIssue(
  config: ForgeConfig,
  milestoneId: number | undefined,
): Promise<ForgeResult<{ issue: FetchedIssue; ready_count: number; message: string } | null>> {
  const apiPath = buildIssueListPath(config.backend, "open", 50, milestoneId)
  const issuesResult = await forgeFetch(config, "GET", apiPath)
  if (!issuesResult.ok) { return issuesResult }
  const rawIssues = (issuesResult.value ?? []) as ForgeIssue[]
  const openIssues = rawIssues.map(i => ({ ...i, state: normalizeState(i.state) }))

  if (openIssues.length === 0) {
    return forgeOk(null)
  }

  const openNumbers = new Set(openIssues.map(i => i.number))
  let hasDeps = false
  const ready: Array<{ issue: ForgeIssue; openDependents: number; depIds: number[] }> = []

  for (const issue of openIssues) {
    const depsResult = await getDependencies(config, issue.number)
    const deps = (depsResult.ok && Array.isArray(depsResult.value)) ? depsResult.value : []
    if (deps.length > 0) { hasDeps = true }
    const openBlockers = deps.filter(d => d.state === "open")
    if (openBlockers.length > 0) { continue }

    const blocksResult = await getBlocks(config, issue.number, openNumbers)
    const dependents = (blocksResult.ok && Array.isArray(blocksResult.value)) ? blocksResult.value : []
    if (dependents.length > 0) { hasDeps = true }
    const depIds = dependents.map(d => d.number)
    const openDependents = depIds.filter(d => openNumbers.has(d))

    ready.push({ issue, openDependents: openDependents.length, depIds: deps.map(d => d.number) })
  }

  if (ready.length === 0) { return forgeOk(null) }

  if (hasDeps) {
    ready.sort((a, b) => {
      const depDiff = b.openDependents - a.openDependents
      return depDiff === 0 ? a.issue.number - b.issue.number : depDiff
    })
  } else {
    ready.sort((a, b) => a.issue.number - b.issue.number)
  }

  const winner = ready[0]
  if (winner === undefined) { return forgeOk(null) }

  const comments = await getComments(config, winner.issue.number)

  const fetchedIssue: FetchedIssue = {
    number: winner.issue.number,
    title: winner.issue.title,
    body: winner.issue.body ?? "",
    state: winner.issue.state,
    labels: (winner.issue.labels ?? []).map(l => l.name),
    dependencies: winner.depIds,
    comments: comments.map(c => c.body),
    url: forgeWebUrl(winner.issue),
  }

  const msg = hasDeps
    ? (winner.openDependents > 0
      ? `#${winner.issue.number} is ready to work on (${winner.openDependents} issue(s) waiting on it).`
      : `#${winner.issue.number} is ready to work on.`)
    : `#${winner.issue.number} is ready to work on (lowest issue number, no dependencies found).`

  return forgeOk({ issue: fetchedIssue, ready_count: ready.length, message: msg })
}

export async function forgeListMilestones(config: ForgeConfig): Promise<ForgeResult<ForgeMilestone[]>> {
  const result = await forgeFetch(config, "GET", "/milestones")
  if (!result.ok) { return result }
  const raw = result.value
  if (!Array.isArray(raw)) { return forgeOk([]) }
  const milestones: ForgeMilestone[] = raw.map((m: Record<string, unknown>) => ({
    id: m["id"] as number,
    title: m["title"] as string,
    html_url: (m["html_url"] ?? m["web_url"] ?? "") as string,
    open_issues: (m["open_issues"] ?? 0) as number,
  }))
  return forgeOk(milestones)
}

export async function forgeUpdateIssue(
  config: ForgeConfig,
  issueNumber: number,
  updates: {
    title?: string
    state?: string
    description?: string
    tasks?: string[]
    tests?: string[]
    milestone_id?: number
    labels?: string[]
  },
): Promise<ForgeResult<{ number: number; title: string; state: string; url: string }>> {
  const payload: Record<string, unknown> = {}
  const hasBodyFields = updates.description !== undefined || updates.tasks !== undefined || updates.tests !== undefined

  if (hasBodyFields) {
    if (updates.description === undefined || updates.description === "" || updates.tasks === undefined || updates.tasks.length === 0 || updates.tests === undefined || updates.tests.length === 0) {
      return forgeErr("api", 0, "description, tasks, and tests are all required when updating body")
    }
    payload["description"] = buildBody(updates.description, updates.tasks, updates.tests)
  }
  if (updates.title !== undefined) { payload["title"] = updates.title }
  if (updates.state !== undefined) {
    Object.assign(payload, setStatePayload(config.backend, updates.state))
  }
  if (updates.milestone_id !== undefined) {
    payload[getAdapter(config.backend).milestoneKey()] = updates.milestone_id
  }
  if (updates.labels !== undefined) { payload["labels"] = updates.labels }

  const method = getAdapter(config.backend).updateIssueMethod()
  const result = await forgeFetch(config, method, `/issues/${issueNumber}`, payload)
  if (!result.ok) { return result }
  const issue = result.value as ForgeIssue
  return forgeOk({
    number: issue.number,
    title: issue.title,
    state: normalizeState(issue.state),
    url: forgeWebUrl(issue),
  })
}

// ─── Issue context formatting ────────────────────────────────────────────────

// fetchIssueContext now loads forge config directly and calls forgeGetIssue.
// It still accepts client for backward compat but doesn't use it for forge calls.
// Why: this eliminates the callMcpTool ephemeral session overhead (~10s per call).
export async function fetchIssueContext(_client: GrimesClient, directory: string, issueNumber: number): Promise<string | null> {
  const forgeConfig = await loadForgeConfig(directory)
  if (!forgeConfig.ok) {
    debug("fetchIssueContext: config error:", forgeConfig.error.message)
    return null
  }
  const result = await forgeGetIssue(forgeConfig.value, issueNumber)
  if (!result.ok) {
    debug("fetchIssueContext: forge error:", result.error.message)
    return null
  }
  const issue = result.value

  const labelStr = issue.labels.length > 0 ? `**Labels:** ${issue.labels.join(", ")}\n` : ""
  const depStr = issue.dependencies.length > 0 ? `**Dependencies:** ${issue.dependencies.map(d => `#${String(d)}`).join(", ")}\n` : ""
  const commentSection = issue.comments.length > 0
    ? `\n### Comments\n${issue.comments.map(c => `- ${c}`).join("\n")}`
    : ""

  return [
    `## Issue #${String(issue.number)}: ${issue.title}`,
    `${labelStr}${depStr}**URL:** ${issue.url}\n**State:** ${issue.state}`,
    "",
    "### Description",
    issue.body.length > 0 ? issue.body : "(no description)",
    commentSection,
  ].filter(s => s.length > 0).join("\n")
}

export function getRecentCommits(directory: string): string {
  try {
    const stdout = execSync("git log --oneline -20", {
      cwd: directory,
      timeout: 10_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (stdout.trim().length > 0) {
      return `### Recent Commits\n${stdout.trim()}`
    }
    return ""
  } catch {
    return ""
  }
}

async function buildContextPrefix(client: GrimesClient, directory: string, issueNumber: number): Promise<string> {
  const issueCtx = await fetchIssueContext(client, directory, issueNumber)
  const commits = getRecentCommits(directory)
  const ctxBlock = [issueCtx ?? "", commits].filter(s => s.length > 0).join("\n\n")
  return ctxBlock.length > 0 ? `${ctxBlock}\n\n` : ""
}

export function resetWorkspace(directory: string): void {
  try {
    execSync("git checkout -- .", { cwd: directory, stdio: ["pipe", "pipe", "pipe"] })
    execSync("git clean -fd --exclude=.grimes", { cwd: directory, stdio: ["pipe", "pipe", "pipe"] })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    debug(`resetWorkspace: warning: ${msg}`)
  }
}

// Concurrency guard — session.idle fires for every session, but only the session
// owning the current issue should drive state machine transitions. This set prevents
// re-entrant calls from corrupting state.
const activeLoop = new Set<string>()

export async function startNewIssue(client: GrimesClient, directory: string, config: GrimesConfig, sessionId: string): Promise<void> {
  debug("startNewIssue: loading forge config")
  const forgeConfig = await loadForgeConfig(directory)
  if (!forgeConfig.ok) {
    debug("startNewIssue: config error:", forgeConfig.error.message)
    await disableLoop(directory)
    await showToast(client, directory, `Config error: ${forgeConfig.error.message}`, "error")
    return
  }

  debug("startNewIssue: calling forgeGetNextIssue")
  const milestoneId = config.milestone_id ?? undefined
  const nextResult = await forgeGetNextIssue(forgeConfig.value, milestoneId)
  if (!nextResult.ok) {
    if (nextResult.error.kind === "auth" || nextResult.error.kind === "config") {
      debug("startNewIssue: auth/config error, disabling loop:", nextResult.error.message)
      await disableLoop(directory)
      await showToast(client, directory, `Forge error: ${nextResult.error.message}`, "error")
    } else {
      debug("startNewIssue: network/api error, skipping:", nextResult.error.message)
    }
    return
  }

  if (nextResult.value === null) {
    if (config.milestone_id !== null) {
      debug("startNewIssue: no issues in milestone, trying next milestone")
      const milestonesResult = await forgeListMilestones(forgeConfig.value)
      if (milestonesResult.ok) {
        const nextMilestone = milestonesResult.value.find(m =>
          m.id !== config.milestone_id && (m.open_issues ?? 0) > 0,
        )
        if (nextMilestone !== undefined) {
          debug(`startNewIssue: switching to milestone ${nextMilestone.title} (${nextMilestone.id})`)
          config.milestone_id = nextMilestone.id
          const dir = await ensureGrimesDir(directory)
          await writeFile(path.join(dir, "loop.json"), JSON.stringify(config, null, 2))
          return startNewIssue(client, directory, config, sessionId)
        }
      }
    }
    debug("startNewIssue: no issues found anywhere, loop stays enabled")
    await showToast(client, directory, "No ready issues right now — loop idle", "info")
    return
  }

  const issueData = nextResult.value.issue
  const issueNumber = issueData.number
  const issueTitle = issueData.title
  const issueBody = issueData.body

  debug(`startNewIssue: got issue #${String(issueNumber)}: ${issueTitle}`)

  const state: GrimesState = {
    issue_number: issueNumber,
    milestone_id: config.milestone_id,
    state: "plan",
    session_id: sessionId,
    attempt: 1,
    total_build_attempts: 0,
    replan_count: 0,
  }
  await writeState(directory, state)
  debug("startNewIssue: state written, sending plan prompt...")

  await sendPrompt(client, sessionId, `You are working on issue #${String(issueNumber)}: ${issueTitle}\n\n${issueBody}\n\nRead AGENTS.md for instructions. Plan your implementation. Create a todo list and start implementing.`, "plan")
  debug("startNewIssue: plan prompt sent, fetching issue context...")

  const ctxPrefix = await buildContextPrefix(client, directory, issueNumber)
  if (ctxPrefix.length > 0) {
    await sendPrompt(client, sessionId, `Here is the current context for this issue:\n\n${ctxPrefix}`)
  }

  await showToast(client, directory, `Started issue #${String(issueNumber)}: ${issueTitle}`, "info")
}

export async function forgePostComment(config: ForgeConfig, issueNumber: number, body: string): Promise<ForgeResult<unknown>> {
  return forgeFetch(config, "POST", getAdapter(config.backend).commentsPath(issueNumber), { body })
}

async function forgeAddWontfixLabel(config: ForgeConfig, issueNumber: number): Promise<void> {
  if (config.backend === "gitlab") {
    await forgeFetch(config, "PUT", `/issues/${issueNumber}`, { add_labels: "wontfix" })
    return
  }
  const listResult = await forgeFetch(config, "GET", "/labels?limit=50")
  let labelId: number | null = null
  if (listResult.ok) {
    const labels = (listResult.value ?? []) as ForgeLabel[]
    const existing = labels.find(l => l.name === "wontfix")
    if (existing !== undefined) { labelId = existing.id }
  }
  if (labelId === null) {
    const createResult = await forgeFetch(config, "POST", "/labels", { name: "wontfix", color: "ffffff" })
    if (createResult.ok) {
      labelId = (createResult.value as ForgeLabel).id
    }
  }
  if (labelId === null) { return }

  const issueResult = await forgeFetch(config, "GET", `/issues/${issueNumber}`)
  if (!issueResult.ok) { return }
  const issue = issueResult.value as ForgeIssue
  const currentIds = (issue.labels ?? []).map(l => l.id)
  if (currentIds.includes(labelId)) { return }
  currentIds.push(labelId)

  await forgeFetch(config, "PATCH", `/issues/${issueNumber}`, { labels: currentIds })
}

async function resetAndProceed(client: GrimesClient, directory: string, state: GrimesState, config: GrimesConfig, sessionId: string): Promise<void> {
  await clearState(directory)
  resetWorkspace(directory)
  await showToast(client, directory, "Workspace reset, picking next issue", "info")
  await startNewIssue(client, directory, config, sessionId)
}

export async function handleSkipIssue(client: GrimesClient, directory: string, state: GrimesState, config: GrimesConfig, reason: string, sessionId: string): Promise<void> {
  debug(`handleSkipIssue: issue #${state.issue_number}: ${reason}`)

  const forgeConfig = await loadForgeConfig(directory)
  if (forgeConfig.ok) {
    await forgePostComment(forgeConfig.value, state.issue_number, reason)
    await forgeAddWontfixLabel(forgeConfig.value, state.issue_number)
  }

  await resetAndProceed(client, directory, state, config, sessionId)
}

export async function transitionPlanToBuild(client: GrimesClient, directory: string, state: GrimesState): Promise<void> {
  debug(`transitionPlanToBuild: issue #${String(state.issue_number)}`)
  state.state = "build"
  await writeState(directory, state)

  const ctxPrefix = await buildContextPrefix(client, directory, state.issue_number)

  await sendPrompt(client, state.session_id, `${ctxPrefix}Planning complete. Now implement the solution. Write code, edit files, and make all the changes needed to complete this issue. Commit your changes when done (refs #${String(state.issue_number)}).`, "build")
}

export async function handlePass(client: GrimesClient, directory: string, state: GrimesState, config: GrimesConfig, sessionId: string): Promise<void> {
  debug(`handlePass: issue #${String(state.issue_number)}`)

  if (config.create_mr) {
    await sendPrompt(client, state.session_id, "All tests pass. Push your branch and create a merge request using the gh CLI or git push. Then report the MR URL.")
  }

  const forgeConfig = await loadForgeConfig(directory)
  if (forgeConfig.ok) {
    const closeResult = await forgeUpdateIssue(forgeConfig.value, state.issue_number, { state: "closed" })
    if (!closeResult.ok) {
      debug("handlePass: failed to close issue:", closeResult.error.message)
    }
  } else {
    debug("handlePass: config error:", forgeConfig.error.message)
  }

  await resetAndProceed(client, directory, state, config, sessionId)
}

export async function handleFail(client: GrimesClient, directory: string, state: GrimesState, config: GrimesConfig, sessionId: string, lastAssistantText: string | null = null): Promise<void> {
  state.total_build_attempts++
  debug(`handleFail: issue #${String(state.issue_number)} attempt=${String(state.attempt)} total=${String(state.total_build_attempts)} replan_count=${String(state.replan_count)}`)

  if (state.total_build_attempts >= PLAN_RETRY_THRESHOLD) {
    if (state.replan_count >= 1) {
      debug("handleFail: second re-plan still failing, skipping issue")
      const failedPlan = lastAssistantText ?? "unknown failure"
      await handleSkipIssue(
        client, directory, state, config,
        `Grimes skipped: still failing after re-plan. Last response:\n\n${failedPlan}`,
        sessionId,
      )
      return
    }

    debug("handleFail: PLAN_RETRY_THRESHOLD reached, re-planning with context")
    state.replan_count++
    state.state = "plan"
    state.attempt = 1
    await writeState(directory, state)

    const ctxPrefix = await buildContextPrefix(client, directory, state.issue_number)

    const failedPlanBlock = lastAssistantText !== null && lastAssistantText.length > 0
      ? `\n\nThe previous approach FAILED. Here is what happened:\n${lastAssistantText}\n\nYou MUST use a completely different approach. Do NOT repeat the same strategy.`
      : ""

    await sendPrompt(client, state.session_id, `${ctxPrefix}Verification has failed ${String(state.total_build_attempts)} times.${failedPlanBlock}\n\nRe-plan: review what went wrong, reconsider your approach, and create a new plan.`, "plan")
    return
  }

  if (state.attempt >= config.max_retries) {
    debug("handleFail: max retries reached, skipping issue")
    await handleSkipIssue(
      client, directory, state, config,
      `Grimes skipped: exhausted ${String(state.attempt)} retries.`,
      sessionId,
    )
    return
  }

  state.attempt++
  state.state = "build"
  await writeState(directory, state)

  const ctxPrefix = await buildContextPrefix(client, directory, state.issue_number)

  await sendPrompt(client, state.session_id, `${ctxPrefix}Verification failed (attempt ${String(state.attempt)}/${String(config.max_retries)}). Fix the issues and try again.`, "build")
}

async function handleIdleBuild(client: GrimesClient, directory: string, state: GrimesState, _config: GrimesConfig): Promise<void> {
  const verifyConfig = await readVerifyConfig(directory)
  const commands = verifyConfig?.commands ?? []
  const results = runVerifyCommands(commands, directory)
  const allPassed = results.every(r => r.exit_code === 0)

  if (allPassed) {
    debug("handleIdle: verify commands passed, asking LLM for semantic check")
    state.state = "verify"
    await writeState(directory, state)
    const ctxPrefix = await buildContextPrefix(client, directory, state.issue_number)
    await sendPrompt(client, state.session_id, `${ctxPrefix}All verification commands passed. Before closing this issue, review the changes made during implementation and confirm they match the issue description and tasks above. Check that all required functionality was implemented.\n\nReturn JSON:\n{"verdict": "pass"|"fail", "reason": "..."}`)
  } else {
    debug("handleIdle: verify commands failed, injecting output")
    state.state = "verify"
    await writeState(directory, state)
    const failSummary = results
      .filter(r => r.exit_code !== 0)
      .map(r => `Command: ${r.command}\nExit code: ${String(r.exit_code)}\nStdout:\n${r.stdout}\nStderr:\n${r.stderr}`)
      .join("\n\n---\n\n")
    const ctxPrefix = await buildContextPrefix(client, directory, state.issue_number)
    await sendPrompt(client, state.session_id, `${ctxPrefix}Verification results:\n\n${failSummary}\n\nAnalyze these failures. If they are real issues, fix them. If they are false positives or pre-existing, explain why.\n\nReturn JSON:\n{"verdict": "pass"|"fail", "reason": "..."}`)
  }
}

async function handleIdleVerify(client: GrimesClient, directory: string, state: GrimesState, config: GrimesConfig, sessionId: string): Promise<void> {
  const result = await client.session.messages({ path: { id: state.session_id } })
  const messages: MessageEntry[] = Array.isArray(result.data) ? result.data : []
  const lastText = extractLastAssistantText(messages)
  const verdict = parseVerdict(lastText)
  await (verdict?.verdict === "pass" ? handlePass(client, directory, state, config, sessionId) : handleFail(client, directory, state, config, sessionId, lastText))
}

export async function handleIdle(client: GrimesClient, directory: string, sessionId: string): Promise<void> {
  if (activeLoop.has(sessionId)) {
    return
  }

  const config = await readConfig(directory)
  if (config === null || !config.enabled) {
    return
  }

  const state = await readState(directory)
  if (state === null) {
    debug("handleIdle: no state, starting new issue")
    activeLoop.add(sessionId)
    try {
      await startNewIssue(client, directory, config, sessionId)
    } finally {
      activeLoop.delete(sessionId)
    }
    return
  }

  state.session_id = sessionId
  await writeState(directory, state)

  activeLoop.add(sessionId)
  try {
    debug(`handleIdle: state=${state.state} issue=#${String(state.issue_number)}`)

    switch (state.state) {
      case "plan": {
        await transitionPlanToBuild(client, directory, state)
        break
      }
      case "build": {
        await handleIdleBuild(client, directory, state, config)
        break
      }
      case "verify": {
        await handleIdleVerify(client, directory, state, config, sessionId)
        break
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
    debug("handleIdle error:", msg)
  } finally {
    activeLoop.delete(sessionId)
  }
}

export function _testReset(): void {
  activeLoop.clear()
}

export const id = "grimes"

const GrimesPlugin: Plugin = async ({ client, directory }) => {
  initDebugLogger(directory)
  debug("Grimes plugin initialized")

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type !== "session.idle") {
        return
      }

      const sessionId = event.properties.sessionID
      debug(`session.idle received: ${sessionId.slice(0, 8)}`)
      await handleIdle(client, directory, sessionId)
    },
  }
}

export default { id, server: GrimesPlugin }
