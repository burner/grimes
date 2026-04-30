/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-condition, unicorn/no-useless-undefined */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import type { Mock } from "bun:test"
import type { GrimesClient, GrimesConfig, GrimesState, MessageEntry, FetchedIssue, SdkPart, ForgeResult } from "./grimes.js"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

type AnyFn = (...args: any[]) => any

function mockFn<T extends AnyFn>(impl?: T): Mock<T> {
  return mock(impl) as Mock<T>
}

const mockExecSync = mockFn<(command: string, options: Record<string, unknown>) => string>()

void mock.module("node:child_process", () => ({
  execSync: mockExecSync,
}))

const {
  parseVerdict,
  extractLastAssistantText,
  readConfig,
  readState,
  writeState,
  clearState,
  readVerifyConfig,
  disableLoop,
  runVerifyCommand,
  handleIdle,
  handleFail,
  handlePass,
  _testReset,
  PLAN_RETRY_THRESHOLD,
  forgeOk,
  forgeErr,
  loadForgeConfig,
  forgeFetch,
  normalizeState,
  buildIssueListPath,
  buildBody,
  forgeGetIssue,
  forgeGetNextIssue,
  forgeUpdateIssue,
  DEFAULT_VERIFY_TIMEOUT,
} = await import("./grimes.js")

let tempDir: string
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  _testReset()
  tempDir = await mkdtemp(path.join(tmpdir(), "grimes-test-"))
  await mkdir(path.join(tempDir, ".grimes"), { recursive: true })
  mockExecSync.mockReset()
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  await rm(tempDir, { recursive: true, force: true })
})

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2))
}

async function writeGiteaEnv(dir: string): Promise<void> {
  const grimesDir = path.join(dir, ".grimes")
  await mkdir(grimesDir, { recursive: true })
  await writeFile(path.join(grimesDir, "env"),
    "GITEA_URL=https://gitea.example.com/owner/repo\nGITEA_TOKEN=test-token\n")
}

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function jsonResponse(urlStr: string, routes: Record<string, unknown>): Response {
  for (const [pattern, data] of Object.entries(routes)) {
    if (urlStr.includes(pattern)) {
      return jsonOk(data)
    }
  }
  return new Response("not found", { status: 404 })
}

function mockFetchWithRoutes(routes: Record<string, unknown>): void {
  globalThis.fetch = mockFn((_url: string | URL | Request) => {
    return Promise.resolve(jsonResponse(String(_url), routes))
  }) as unknown as typeof fetch
}

function makeAssistantMsg(text: string, completed = true): MessageEntry {
  return {
    info: {
      id: "m",
      sessionID: "s",
      role: "assistant" as const,
      time: { created: 1, ...(completed ? { completed: 1 } : {}) },
      parentID: "",
      modelID: "test",
      providerID: "test",
      mode: "test",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "p", sessionID: "s", messageID: "m", type: "text" as const, text } satisfies SdkPart],
  }
}

function makeUserMsg(text: string): MessageEntry {
  return {
    info: {
      id: "m",
      sessionID: "s",
      role: "user" as const,
      time: { created: 1 },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: "p", sessionID: "s", messageID: "m", type: "text" as const, text } satisfies SdkPart],
  }
}

function createMockClient(): { client: GrimesClient; prompts: Array<{ sessionId: string; agent: string | undefined; text: string }>; sessions: Map<string, MessageEntry[]> } {
  const prompts: Array<{ sessionId: string; agent: string | undefined; text: string }> = []
  const sessions = new Map<string, MessageEntry[]>()
  let nextId = 0

  const client = {
    session: {
      create: mockFn(() => {
        const id = `sess-${nextId++}`
        sessions.set(id, [])
        return Promise.resolve({
          data: {
            id,
            projectID: "test",
            directory: tempDir,
            title: "test",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
          error: undefined,
        })
      }),
      delete: mockFn(() => Promise.resolve({ data: true, error: undefined })),
      messages: mockFn(({ path: p }: { path: { id: string } }) => {
        if (!sessions.has(p.id)) {
          sessions.set(p.id, [])
        }
        return Promise.resolve({ data: sessions.get(p.id)!, error: undefined })
      }),
      promptAsync: mockFn(({ path: p, body }: { path: { id: string }; body?: { agent?: string; parts: Array<{ type: string; text: string }> } }) => {
        const text = body?.parts?.[0]?.text ?? ""
        prompts.push({ sessionId: p.id, agent: body?.agent, text })
        return Promise.resolve({ data: {}, error: undefined })
      }),
    },
    tui: {
      publish: mockFn(() => Promise.resolve({ data: true, error: undefined })),
    },
  }

  return { client: client as unknown as GrimesClient, prompts, sessions }
}

function createMockClientWithMainSession(): { client: GrimesClient; prompts: Array<{ sessionId: string; agent: string | undefined; text: string }>; sessions: Map<string, MessageEntry[]> } {
  const result = createMockClient()
  result.sessions.set("main-session", [])
  return result
}

const defaultConfig: GrimesConfig = {
  enabled: true,
  milestone_id: null,
  create_mr: false,
  max_retries: 2,
}

const defaultState: GrimesState = {
  issue_number: 5,
  milestone_id: null,
  state: "build",
  session_id: "main-session",
  attempt: 1,
  total_build_attempts: 0,
  replan_count: 0,
}

const _mockIssue: FetchedIssue = {
  number: 5,
  title: "Fix the thing",
  body: "The thing is broken",
  state: "open",
  labels: ["backend"],
  dependencies: [],
  comments: ["Please fix this soon"],
  url: "https://example.com/issues/5",
}

const forgeIssueResponse = {
  number: 5,
  title: "Fix the thing",
  state: "open",
  body: "The thing is broken",
  labels: [{ id: 1, name: "backend" }],
  html_url: "https://example.com/issues/5",
}

const forgeRoutes = {
  "/issues?state=open": [
    { number: 10, title: "New issue", state: "open", body: "Do the thing", labels: [], html_url: "https://example.com/issues/10" },
  ],
  "/issues/5": forgeIssueResponse,
  "/issues/5/comments": [{ body: "Please fix this soon" }],
  "/issues/5/dependencies": [],
  "/issues/10": { number: 10, title: "New issue", state: "open", body: "Do the thing", labels: [], html_url: "https://example.com/issues/10" },
  "/issues/10/comments": [],
  "/issues/10/dependencies": [],
  "/issues/10/blocks": [],
}

// ─── parseVerdict ────────────────────────────────────────────────────────────

describe("parseVerdict", () => {
  it("extracts pass verdict from bare JSON", () => {
    const result = parseVerdict('{"verdict":"pass","reason":"all good"}')
    expect(result).toEqual({ verdict: "pass", reason: "all good" })
  })

  it("extracts fail verdict from prose-wrapped JSON", () => {
    const result = parseVerdict('Here is my analysis:\n\n{"verdict":"fail","reason":"broken"}\n\nLet me know.')
    expect(result).toEqual({ verdict: "fail", reason: "broken" })
  })

  it("returns null for text without JSON", () => {
    expect(parseVerdict("no json here")).toBeNull()
  })

  it("returns null for null input", () => {
    expect(parseVerdict(null)).toBeNull()
  })

  it("returns null for undefined input", () => {
    expect(parseVerdict(undefined)).toBeNull()
  })

  it("returns null for JSON without verdict field", () => {
    expect(parseVerdict('{"status":"ok"}')).toBeNull()
  })

  it("returns verdict without reason", () => {
    expect(parseVerdict('{"verdict":"pass"}')).toEqual({ verdict: "pass", reason: undefined })
  })
})

// ─── extractLastAssistantText ────────────────────────────────────────────────

describe("extractLastAssistantText", () => {
  it("returns text from a single assistant message", () => {
    const messages = [makeAssistantMsg("hello")]
    expect(extractLastAssistantText(messages)).toBe("hello")
  })

  it("returns the last assistant message's text", () => {
    const messages = [makeAssistantMsg("first"), makeAssistantMsg("last")]
    expect(extractLastAssistantText(messages)).toBe("last")
  })

  it("returns null for empty array", () => {
    expect(extractLastAssistantText([])).toBeNull()
  })

  it("returns null for user-only messages", () => {
    const messages = [makeUserMsg("hello")]
    expect(extractLastAssistantText(messages)).toBeNull()
  })

  it("returns null for assistant with no text parts", () => {
    const messages: MessageEntry[] = [{
      info: {
        id: "m", sessionID: "s", role: "assistant" as const,
        time: { created: 1, completed: 1 }, parentID: "",
        modelID: "test", providerID: "test", mode: "test",
        path: { cwd: "/", root: "/" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: "p", sessionID: "s", messageID: "m", type: "tool" as const,
        callID: "c", tool: "bash", state: { status: "pending", input: {}, raw: "" },
      }],
    }]
    expect(extractLastAssistantText(messages)).toBeNull()
  })
})

// ─── file I/O ────────────────────────────────────────────────────────────────

describe("readConfig", () => {
  it("returns parsed config from loop.json", async () => {
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const result = await readConfig(tempDir)
    expect(result).toEqual(defaultConfig)
  })

  it("returns null when loop.json is missing", async () => {
    const result = await readConfig(tempDir)
    expect(result).toBeNull()
  })
})

describe("readState", () => {
  it("returns parsed state from state.json", async () => {
    await writeJson(path.join(tempDir, ".grimes", "state.json"), defaultState)
    const result = await readState(tempDir)
    expect(result).toEqual(defaultState)
  })

  it("returns null when state.json is missing", async () => {
    const result = await readState(tempDir)
    expect(result).toBeNull()
  })
})

describe("writeState + readState", () => {
  it("round-trips state through disk", async () => {
    await writeState(tempDir, defaultState)
    const result = await readState(tempDir)
    expect(result).toEqual(defaultState)
  })
})

describe("clearState", () => {
  it("removes state.json", async () => {
    await writeState(tempDir, defaultState)
    await clearState(tempDir)
    expect(await readState(tempDir)).toBeNull()
  })

  it("does not throw when state.json is missing", async () => {
    await clearState(tempDir)
  })
})

describe("readVerifyConfig", () => {
  it("returns parsed verify config", async () => {
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    const result = await readVerifyConfig(tempDir)
    expect(result).toEqual({ commands: ["echo hi"] })
  })

  it("returns null when verify.json is missing", async () => {
    expect(await readVerifyConfig(tempDir)).toBeNull()
  })

  it("parses mixed string and object commands", async () => {
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), {
      commands: [
        "echo hi",
        { command: "cargo test", timeout_ms: 300_000 },
      ],
    })
    const result = await readVerifyConfig(tempDir)
    expect(result).not.toBeNull()
    expect(result!.commands).toEqual([
      "echo hi",
      { command: "cargo test", timeout_ms: 300_000 },
    ])
  })
})

describe("disableLoop", () => {
  it("overwrites loop.json with enabled:false", async () => {
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await disableLoop(tempDir)
    const content = await readFile(path.join(tempDir, ".grimes", "loop.json"), "utf8")
    expect(JSON.parse(content)).toEqual({ enabled: false })
  })
})

// ─── runVerifyCommand ────────────────────────────────────────────────────────

describe("runVerifyCommand", () => {
  it("returns exit_code 0 on success", () => {
    mockExecSync.mockImplementationOnce(() => "ok")
    const result = runVerifyCommand("echo ok", tempDir)
    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe("ok")
    expect(result.stderr).toBe("")
  })

  it("returns non-zero exit_code on failure", () => {
    const err = new Error("failed") as Error & { status: number; stdout: string; stderr: string }
    err.status = 1
    err.stdout = "out"
    err.stderr = "err"
    mockExecSync.mockImplementationOnce(() => { throw err })
    const result = runVerifyCommand("exit 1", tempDir)
    expect(result.exit_code).toBe(1)
    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
  })

  it("defaults to exit_code 1 when status is missing", () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("boom") })
    const result = runVerifyCommand("bad", tempDir)
    expect(result.exit_code).toBe(1)
  })

  it("uses default timeout when not specified", () => {
    let capturedOpts: Record<string, unknown> = {}
    mockExecSync.mockImplementationOnce((_cmd: string, opts: Record<string, unknown>) => {
      capturedOpts = opts
      return "ok"
    })
    runVerifyCommand("echo ok", tempDir)
    expect(capturedOpts["timeout"]).toBe(DEFAULT_VERIFY_TIMEOUT)
  })

  it("uses custom timeout when specified", () => {
    let capturedOpts: Record<string, unknown> = {}
    mockExecSync.mockImplementationOnce((_cmd: string, opts: Record<string, unknown>) => {
      capturedOpts = opts
      return "ok"
    })
    runVerifyCommand("echo ok", tempDir, 30_000)
    expect(capturedOpts["timeout"]).toBe(30_000)
  })
})

// ─── forgeOk / forgeErr ──────────────────────────────────────────────────────

describe("forgeOk / forgeErr", () => {
  it("forgeOk wraps a value", () => {
    const result: ForgeResult<number> = forgeOk(42)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(42)
    }
  })

  it("forgeErr wraps an error", () => {
    const result: ForgeResult<number> = forgeErr("network", 0, "timeout")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("network")
      expect(result.error.message).toBe("timeout")
    }
  })
})

// ─── loadForgeConfig ─────────────────────────────────────────────────────────

describe("loadForgeConfig", () => {
  it("returns config error when no env file exists", async () => {
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("config")
    }
  })

  it("parses gitea.env and returns ForgeConfig", async () => {
    await writeGiteaEnv(tempDir)
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.backend).toBe("gitea")
      expect(result.value.apiBase).toBe("https://gitea.example.com")
      expect(result.value.owner).toBe("owner")
      expect(result.value.repo).toBe("repo")
    }
  })

  it("returns config error for multiple backends", async () => {
    const grimesDir = path.join(tempDir, ".grimes")
    await mkdir(grimesDir, { recursive: true })
    await writeFile(path.join(grimesDir, "env"),
      "GITEA_URL=https://gitea.example.com/owner/repo\nGITEA_TOKEN=tok\nGITLAB_URL=https://gitlab.example.com/group/project\nGITLAB_TOKEN=tok\n")
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("config")
    }
  })

  it("reads .grimes/env from the given directory", async () => {
    const grimesDir = path.join(tempDir, ".grimes")
    await mkdir(grimesDir, { recursive: true })
    await writeGiteaEnv(tempDir)
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(true)
  })

  it("parses github URL", async () => {
    const grimesDir = path.join(tempDir, ".grimes")
    await mkdir(grimesDir, { recursive: true })
    await writeFile(path.join(grimesDir, "env"),
      "GITHUB_URL=https://github.com/owner/repo\nGITHUB_TOKEN=ghtok\n")
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.backend).toBe("github")
      expect(result.value.owner).toBe("owner")
      expect(result.value.repo).toBe("repo")
    }
  })

  it("parses gitlab URL with encoded project path", async () => {
    const grimesDir = path.join(tempDir, ".grimes")
    await mkdir(grimesDir, { recursive: true })
    await writeFile(path.join(grimesDir, "env"),
      "GITLAB_URL=https://gitlab.example.com/group/sub/project\nGITLAB_TOKEN=gltok\n")
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.backend).toBe("gitlab")
      expect(result.value.projectPath).toBe("group/sub/project")
    }
  })

  it("returns config error when token is missing", async () => {
    const grimesDir = path.join(tempDir, ".grimes")
    await mkdir(grimesDir, { recursive: true })
    await writeFile(path.join(grimesDir, "env"),
      "GITEA_URL=https://gitea.example.com/owner/repo\n")
    const result = await loadForgeConfig(tempDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain("TOKEN")
    }
  })
})

// ─── forgeFetch ──────────────────────────────────────────────────────────────

describe("forgeFetch", () => {
  it("returns parsed JSON on success", async () => {
    globalThis.fetch = mockFn(() => Promise.resolve(jsonOk({ id: 1, title: "test" }))) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const config = await loadForgeConfig(tempDir)
    if (!config.ok) { expect.unreachable("config should be ok"); return }
    const result = await forgeFetch(config.value, "GET", "/milestones")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as Record<string, unknown>)["id"]).toBe(1)
    }
  })

  it("returns auth error on 401", async () => {
    globalThis.fetch = mockFn(() => Promise.resolve(new Response("Unauthorized", { status: 401 }))) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const config = await loadForgeConfig(tempDir)
    if (!config.ok) {
      return
    }
    const result = await forgeFetch(config.value, "GET", "/issues")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("auth")
    }
  })

  it("retries on network error up to 3 times", async () => {
    let callCount = 0
    globalThis.fetch = mockFn(() => {
      callCount++
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const config = await loadForgeConfig(tempDir)
    if (!config.ok) {
      return
    }
    const result = await forgeFetch(config.value, "GET", "/issues", undefined, 0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("network")
    }
    expect(callCount).toBe(3)
  })

  it("returns api error on 500", async () => {
    globalThis.fetch = mockFn(() => Promise.resolve(new Response("Internal Server Error", { status: 500 }))) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const config = await loadForgeConfig(tempDir)
    if (!config.ok) {
      return
    }
    const result = await forgeFetch(config.value, "GET", "/issues")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("api")
    }
  })

  it("succeeds on retry after network error", async () => {
    let callCount = 0
    globalThis.fetch = mockFn(() => {
      callCount++
      if (callCount < 2) {
        throw new TypeError("fetch failed")
      }
      return Promise.resolve(jsonOk({ ok: true }))
    }) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const config = await loadForgeConfig(tempDir)
    if (!config.ok) {
      return
    }
    const result = await forgeFetch(config.value, "GET", "/issues", undefined, 0)
    expect(result.ok).toBe(true)
    expect(callCount).toBe(2)
  })
})

// ─── forge adapters ──────────────────────────────────────────────────────────

describe("forge adapters", () => {
  it("normalizeState converts opened to open", () => {
    expect(normalizeState("opened")).toBe("open")
    expect(normalizeState("open")).toBe("open")
    expect(normalizeState("closed")).toBe("closed")
  })

  it("buildIssueListPath returns correct path per backend", () => {
    expect(buildIssueListPath("gitea", "open", 50, undefined)).toContain("type=issues")
    expect(buildIssueListPath("gitlab", "open", 50, undefined)).toContain("state=opened")
    expect(buildIssueListPath("github", "open", 50, undefined)).toContain("state=open")
    expect(buildIssueListPath("gitea", "open", 50, 3)).toContain("milestone_id=3")
  })

  it("buildBody creates markdown with description, tasks, tests", () => {
    const body = buildBody("Do the thing", ["step 1", "step 2"], ["test foo — bar"])
    expect(body).toContain("### Description")
    expect(body).toContain("Do the thing")
    expect(body).toContain("- [ ] step 1")
    expect(body).toContain("### Tests")
    expect(body).toContain("- [ ] test foo — bar")
  })
})

// ─── forgeGetIssue ───────────────────────────────────────────────────────────

describe("forgeGetIssue", () => {
  it("fetches issue with comments and dependencies", async () => {
    globalThis.fetch = mockFn((_url: string | URL | Request) => {
      const urlStr = String(_url)
      if (urlStr.includes("/issues/5") && !urlStr.includes("/comments") && !urlStr.includes("/dependencies")) {
        return Promise.resolve(jsonOk(forgeIssueResponse))
      }
      if (urlStr.includes("/comments")) {
        return Promise.resolve(jsonOk([{ body: "comment1" }]))
      }
      if (urlStr.includes("/dependencies")) {
        return Promise.resolve(jsonOk([]))
      }
      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as unknown as typeof fetch

    await writeGiteaEnv(tempDir)
    const cfg = await loadForgeConfig(tempDir)
    if (!cfg.ok) {
      expect.unreachable("config failed")
      return
    }
    const result = await forgeGetIssue(cfg.value, 5)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.number).toBe(5)
      expect(result.value.comments).toEqual(["comment1"])
      expect(result.value.labels).toEqual(["backend"])
    }
  })

  it("returns auth error on 401", async () => {
    globalThis.fetch = mockFn(() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch
    await writeGiteaEnv(tempDir)
    const cfg = await loadForgeConfig(tempDir)
    if (!cfg.ok) {
      return
    }
    const result = await forgeGetIssue(cfg.value, 5)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("auth")
    }
  })
})

// ─── forgeGetNextIssue ───────────────────────────────────────────────────────

describe("forgeGetNextIssue", () => {
  it("returns null when no open issues exist", async () => {
    mockFetchWithRoutes({ "/issues?state=open": [] })
    await writeGiteaEnv(tempDir)
    const cfg = await loadForgeConfig(tempDir)
    if (!cfg.ok) {
      return
    }
    const result = await forgeGetNextIssue(cfg.value, undefined)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBeNull()
    }
  })

  it("returns first unblocked issue sorted by number", async () => {
    mockFetchWithRoutes({
      "/issues?state=open": [
        { number: 10, title: "First", state: "open", body: "", labels: [] },
        { number: 20, title: "Second", state: "open", body: "", labels: [] },
      ],
      "/issues/10/dependencies": [],
      "/issues/10/blocks": [],
      "/issues/20/dependencies": [],
      "/issues/20/blocks": [],
      "/issues/10/comments": [],
    })
    await writeGiteaEnv(tempDir)
    const cfg = await loadForgeConfig(tempDir)
    if (!cfg.ok) {
      return
    }
    const result = await forgeGetNextIssue(cfg.value, undefined)
    expect(result.ok).toBe(true)
    if (result.ok && result.value !== null) {
      expect(result.value.issue.number).toBe(10)
    }
  })
})

// ─── forgeUpdateIssue ────────────────────────────────────────────────────────

describe("forgeUpdateIssue", () => {
  it("closes an issue", async () => {
    mockFetchWithRoutes({
      "/issues/5": { number: 5, title: "Fix", state: "closed", html_url: "https://example.com/issues/5" },
    })
    await writeGiteaEnv(tempDir)
    const cfg = await loadForgeConfig(tempDir)
    if (!cfg.ok) {
      return
    }
    const result = await forgeUpdateIssue(cfg.value, 5, { state: "closed" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state).toBe("closed")
    }
  })
})

// ─── handleFail ──────────────────────────────────────────────────────────────

describe("handleFail", () => {
  it("retries build when under max_retries", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    const state: GrimesState = { ...defaultState, attempt: 1, total_build_attempts: 1 }
    await handleFail(client as GrimesClient, tempDir, state, defaultConfig, "main-session")
    expect(state.attempt).toBe(2)
    expect(state.state).toBe("build")
    const buildPrompt = prompts.find(p => p.agent === "build")
    expect(buildPrompt).toBeDefined()
    expect(buildPrompt!.text).toContain("attempt 2/2")
  })

  it("disables loop when attempt reaches max_retries", async () => {
    const { client } = createMockClient()
    const state: GrimesState = { ...defaultState, attempt: 2, total_build_attempts: 3 }
    await handleFail(client as GrimesClient, tempDir, state, defaultConfig, "main-session")
    const config = await readConfig(tempDir)
    expect(config?.enabled).toBe(false)
    const savedState = await readState(tempDir)
    expect(savedState).toBeNull()
  })

  it("re-plans when total_build_attempts hits PLAN_RETRY_THRESHOLD", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    const state: GrimesState = { ...defaultState, attempt: 1, total_build_attempts: PLAN_RETRY_THRESHOLD - 1 }
    await handleFail(client as GrimesClient, tempDir, state, defaultConfig, "main-session")
    expect(state.state).toBe("plan")
    expect(state.attempt).toBe(1)
    const planPrompt = prompts.find(p => p.agent === "plan")
    expect(planPrompt).toBeDefined()
    expect(planPrompt!.text).toContain("Re-plan")
  })
})

// ─── handlePass ──────────────────────────────────────────────────────────────

describe("handlePass", () => {
  it("closes issue via forge and clears state", async () => {
    mockFetchWithRoutes({
      "/issues/5": { number: 5, title: "Fix", state: "closed", html_url: "https://example.com/issues/5" },
      "/issues?state=open": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts: _prompts } = createMockClient()
    const state: GrimesState = { ...defaultState }
    await handlePass(client as GrimesClient, tempDir, state, defaultConfig, "main-session")
    // Should have closed the issue (forgeUpdateIssue was called via fetch)
    const savedState = await readState(tempDir)
    expect(savedState).toBeNull()
  })

  it("prompts for MR when create_mr is true", async () => {
    mockFetchWithRoutes({
      "/issues/5": { number: 5, title: "Fix", state: "closed", html_url: "https://example.com/issues/5" },
      "/issues?state=open": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    const configWithMr: GrimesConfig = { ...defaultConfig, create_mr: true }
    await handlePass(client as GrimesClient, tempDir, { ...defaultState }, configWithMr, "main-session")
    const mrPrompt = prompts.find(p => p.text.includes("merge request"))
    expect(mrPrompt).toBeDefined()
  })
})

// ─── handleIdle ──────────────────────────────────────────────────────────────

describe("handleIdle", () => {
  it("returns early when config is disabled", async () => {
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), { ...defaultConfig, enabled: false })
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    expect(prompts.length).toBe(0)
  })

  it("returns early when config is missing", async () => {
    const { client, prompts } = createMockClient()
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    expect(prompts.length).toBe(0)
  })

  it("starts a new issue when no state exists", async () => {
    mockFetchWithRoutes(forgeRoutes)
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    mockExecSync.mockImplementation(() => "abc123 commit msg")
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const state = await readState(tempDir)
    expect(state).not.toBeNull()
    expect(state!.issue_number).toBe(10)
    expect(state!.state).toBe("plan")
    const planPrompt = prompts.find(p => p.agent === "plan")
    expect(planPrompt).toBeDefined()
  })

  it("transitions plan to build", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [{ body: "comment" }],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    const state: GrimesState = { ...defaultState, state: "plan" }
    await writeState(tempDir, state)
    mockExecSync.mockImplementation(() => "abc123 commit msg")
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState?.state).toBe("build")
    const buildPrompt = prompts.find(p => p.agent === "build")
    expect(buildPrompt).toBeDefined()
  })

  it("runs verify commands and transitions to verify state when all exit 0", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    await writeState(tempDir, defaultState)
    mockExecSync.mockImplementation(() => "ok")
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState?.state).toBe("verify")
    const semanticPrompt = prompts.find(p => p.text.includes("All verification commands passed"))
    expect(semanticPrompt).toBeDefined()
    expect(semanticPrompt!.text).toContain("match the issue description")
  })

  it("enters verify state when commands fail", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["bash check.sh"] })
    await writeState(tempDir, defaultState)
    const err = new Error("fail") as Error & { status: number; stdout: string; stderr: string }
    err.status = 1
    err.stdout = "error output"
    err.stderr = "stderr output"
    mockExecSync.mockImplementation(() => { throw err })
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState?.state).toBe("verify")
    const verifyPrompt = prompts.find(p => p.text.includes("Verification results"))
    expect(verifyPrompt).toBeDefined()
  })

  it("handles verify state with pass verdict", async () => {
    mockFetchWithRoutes({
      "/issues/5": { number: 5, title: "Fix", state: "closed", html_url: "https://example.com/issues/5" },
      "/issues?state=open": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts: _prompts, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const state: GrimesState = { ...defaultState, state: "verify" }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"pass","reason":"all fixed"}'))
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    // handlePass clears state after closing
    const savedState = await readState(tempDir)
    expect(savedState).toBeNull()
  })

  it("handles verify state with fail verdict", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    const state: GrimesState = { ...defaultState, state: "verify", attempt: 1 }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"fail","reason":"still broken"}'))
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState?.attempt).toBe(2)
    expect(savedState?.state).toBe("build")
  })

  it("adopts new session when session id differs", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    await writeState(tempDir, { ...defaultState, state: "plan", session_id: "other-session" })
    mockExecSync.mockImplementation(() => "abc123 commit msg")
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    // Should have adopted main-session and transitioned plan→build
    const savedState = await readState(tempDir)
    expect(savedState?.session_id).toBe("main-session")
    expect(savedState?.state).toBe("build")
    const buildPrompt = prompts.find(p => p.agent === "build")
    expect(buildPrompt).toBeDefined()
  })

  it("skips issue with wontfix when max retries exhausted", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
      "/issues/5/blocks": [],
      "/labels": [],
      "/issues?state=open": [
        { number: 10, title: "Next issue", state: "open", body: "Do stuff", labels: [], html_url: "https://example.com/issues/10" },
      ],
      "/issues/10": { number: 10, title: "Next issue", state: "open", body: "Do stuff", labels: [], html_url: "https://example.com/issues/10" },
      "/issues/10/comments": [],
      "/issues/10/dependencies": [],
      "/issues/10/blocks": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const state: GrimesState = { ...defaultState, state: "verify", attempt: 2 }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"fail","reason":"still broken"}'))
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState).not.toBeNull()
    expect(savedState!.issue_number).toBe(10)
    expect(savedState!.state).toBe("plan")
    const config = await readConfig(tempDir)
    expect(config?.enabled).toBe(true)
  })

  it("skips issue on second re-plan with comment containing failed plan", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
      "/issues/5/blocks": [],
      "/labels": [],
      "/issues?state=open": [
        { number: 10, title: "Next issue", state: "open", body: "Do stuff", labels: [], html_url: "https://example.com/issues/10" },
      ],
      "/issues/10": { number: 10, title: "Next issue", state: "open", body: "Do stuff", labels: [], html_url: "https://example.com/issues/10" },
      "/issues/10/comments": [],
      "/issues/10/dependencies": [],
      "/issues/10/blocks": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts: _prompts, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const state: GrimesState = { ...defaultState, state: "verify", attempt: 1, total_build_attempts: PLAN_RETRY_THRESHOLD, replan_count: 1 }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"fail","reason":"same error again"}'))
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState).not.toBeNull()
    expect(savedState!.issue_number).toBe(10)
    const config = await readConfig(tempDir)
    expect(config?.enabled).toBe(true)
  })

  it("includes failed plan in re-plan prompt on first re-plan", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
      "/issues/5/blocks": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    const state: GrimesState = { ...defaultState, state: "verify", attempt: 1, total_build_attempts: PLAN_RETRY_THRESHOLD, replan_count: 0 }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"fail","reason":"the old approach did not work"}'))
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState?.state).toBe("plan")
    expect(savedState?.replan_count).toBe(1)
    const planPrompt = prompts.find(p => p.agent === "plan")
    expect(planPrompt).toBeDefined()
    expect(planPrompt!.text).toContain("previous approach FAILED")
    expect(planPrompt!.text).toContain("the old approach did not work")
    expect(planPrompt!.text).toContain("completely different approach")
  })

  it("chains to next milestone when current is exhausted", async () => {
    globalThis.fetch = mockFn((_url: string | URL | Request) => {
      const urlStr = String(_url)
      if (urlStr.includes("/milestones")) {
        return Promise.resolve(jsonOk([
          { id: 1, title: "Done", open_issues: 0 },
          { id: 2, title: "Next", open_issues: 5 },
        ]))
      }
      if (urlStr.includes("milestone=1") || urlStr.includes("milestone_id=1")) {
        return Promise.resolve(jsonOk([]))
      }
      if (urlStr.includes("/issues/99")) {
        return Promise.resolve(jsonOk({ number: 99, title: "Next milestone issue", state: "open", body: "do it", labels: [], html_url: "https://example.com/issues/99" }))
      }
      if (urlStr.includes("/issues/99/comments")) {
        return Promise.resolve(jsonOk([]))
      }
      if (urlStr.includes("/issues/99/dependencies")) {
        return Promise.resolve(jsonOk([]))
      }
      if (urlStr.includes("/issues/99/blocks")) {
        return Promise.resolve(jsonOk([]))
      }
      if (urlStr.includes("milestone=2") || urlStr.includes("milestone_id=2")) {
        return Promise.resolve(jsonOk([
          { number: 99, title: "Next milestone issue", state: "open", body: "do it", labels: [], html_url: "https://example.com/issues/99" },
        ]))
      }
      if (urlStr.includes("/issues?state=open")) {
        return Promise.resolve(jsonOk([]))
      }
      return Promise.resolve(jsonOk([]))
    }) as unknown as typeof fetch

    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), { ...defaultConfig, milestone_id: 1 })
    await writeJson(path.join(tempDir, ".grimes", "verify.json"), { commands: ["echo hi"] })
    mockExecSync.mockImplementation(() => "abc123 commit msg")
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState).not.toBeNull()
    expect(savedState!.issue_number).toBe(99)
    expect(savedState!.milestone_id).toBe(2)
    const savedConfig = await readConfig(tempDir)
    expect(savedConfig?.milestone_id).toBe(2)
    const planPrompt = prompts.find(p => p.agent === "plan")
    expect(planPrompt).toBeDefined()
  })

  it("stays enabled when no milestones have issues", async () => {
    mockFetchWithRoutes({
      "/milestones": [
        { id: 1, title: "Done", open_issues: 0 },
        { id: 2, title: "Also done", open_issues: 0 },
      ],
      "/issues?state=open": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, prompts } = createMockClient()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), { ...defaultConfig, milestone_id: 1 })
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    const savedState = await readState(tempDir)
    expect(savedState).toBeNull()
    const config = await readConfig(tempDir)
    expect(config?.enabled).toBe(true)
    expect(prompts.length).toBe(0)
  })

  it("resets workspace on pass before starting next issue", async () => {
    mockFetchWithRoutes({
      "/issues/5": { number: 5, title: "Fix", state: "closed", html_url: "https://example.com/issues/5" },
      "/issues?state=open": [
        { number: 10, title: "Next", state: "open", body: "Do it", labels: [], html_url: "https://example.com/issues/10" },
      ],
      "/issues/10": { number: 10, title: "Next", state: "open", body: "Do it", labels: [], html_url: "https://example.com/issues/10" },
      "/issues/10/comments": [],
      "/issues/10/dependencies": [],
      "/issues/10/blocks": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const state: GrimesState = { ...defaultState, state: "verify" }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"pass","reason":"all fixed"}'))
    const checkoutCalls: string[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git checkout") || cmd.includes("git clean")) {
        checkoutCalls.push(cmd)
      }
      return "ok"
    })
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    expect(checkoutCalls.some(c => c.includes("git checkout -- ."))).toBe(true)
    expect(checkoutCalls.some(c => c.includes("git clean -fd"))).toBe(true)
  })

  it("resets workspace on skip before starting next issue", async () => {
    mockFetchWithRoutes({
      "/issues/5": forgeIssueResponse,
      "/issues/5/comments": [],
      "/issues/5/dependencies": [],
      "/issues/5/blocks": [],
      "/labels": [],
      "/issues?state=open": [
        { number: 10, title: "Next", state: "open", body: "Do it", labels: [], html_url: "https://example.com/issues/10" },
      ],
      "/issues/10": { number: 10, title: "Next", state: "open", body: "Do it", labels: [], html_url: "https://example.com/issues/10" },
      "/issues/10/comments": [],
      "/issues/10/dependencies": [],
      "/issues/10/blocks": [],
    })
    await writeGiteaEnv(tempDir)
    const { client, sessions } = createMockClientWithMainSession()
    await writeJson(path.join(tempDir, ".grimes", "loop.json"), defaultConfig)
    const state: GrimesState = { ...defaultState, state: "verify", attempt: 2 }
    await writeState(tempDir, state)
    const msgs = sessions.get("main-session")!
    msgs.push(makeAssistantMsg('{"verdict":"fail","reason":"still broken"}'))
    const checkoutCalls: string[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git checkout") || cmd.includes("git clean")) {
        checkoutCalls.push(cmd)
      }
      return "ok"
    })
    await handleIdle(client as GrimesClient, tempDir, "main-session")
    expect(checkoutCalls.some(c => c.includes("git checkout -- ."))).toBe(true)
    expect(checkoutCalls.some(c => c.includes("git clean -fd"))).toBe(true)
  })
})
