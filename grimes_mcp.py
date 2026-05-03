#!/usr/bin/env python3
"""
grimes_mcp.py — MCP server exposing Gitea/GitLab/GitHub project management tools.

Transport: stdio (newline-delimited JSON-RPC 2.0)
Protocol:  Model Context Protocol (MCP) 2024-11-05

Configuration — auto-detects Gitea, GitLab, or GitHub from env:

  Gitea:
    GITEA_URL=https://your-gitea-instance.com/owner/repo
    GITEA_TOKEN=your_personal_access_token

  GitLab:
    GITLAB_URL=https://gitlab.example.com/group/project
    GITLAB_TOKEN=your_personal_access_token

  GitHub:
    GITHUB_URL=https://github.com/owner/repo
    GITHUB_TOKEN=your_personal_access_token

  Place them in .grimes/env (in the project root) or set them as environment variables.

  Error if none or more than one are configured.

  GitHub limitations:
    - Dependencies use the sub-issues API (parent/child mapping).
    - Diamond dependencies: first add_dependency wins, subsequent ones silently
      accept 422. _get_blocks returns at most 1 issue.

opencode.json (minimal):
    {
      "mcpServers": {
        "gitea": {
          "command": "python3",
           "args": ["./grimes_mcp.py"]
        }
      }
    }
"""

import http.client
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Callable, NotRequired, TypedDict, cast
from urllib.parse import quote as url_quote

import urllib.request
import urllib.error


class _McpMilestone(TypedDict):
    id: int
    title: str
    html_url: NotRequired[str]
    description: NotRequired[str]
    due_on: NotRequired[str]


class _McpLabel(TypedDict):
    id: int
    name: str


class _McpIssue(TypedDict):
    number: int
    title: str
    state: str
    html_url: NotRequired[str]
    web_url: NotRequired[str]
    body: NotRequired[str]
    labels: NotRequired[list[_McpLabel]]


class _McpComment(TypedDict):
    body: str


class _McpLink(TypedDict):
    iid: int
    state: str
    title: NotRequired[str]
    link_type: NotRequired[str]


class _ReadyIssue(TypedDict):
    issue: _McpIssue
    open_dependents: int
    dependency_ids: list[int]


class _ToolEntry(TypedDict):
    fn: Callable[[dict[str, object]], dict[str, object]]
    schema: dict[str, object]


REFACTOR_PATTERNS: list[dict[str, str]] = [
    {
        "name": "Extract Method",
        "focus": "Long methods with distinct sections",
        "description": (
            "Look for methods over 20 lines, methods with comment-separated sections, "
            "or methods with deeply nested logic. Extract each coherent block into its "
            "own method with a name that describes what it does (not how). After "
            "extraction, the original method should read like a summary of the algorithm."
        ),
    },
    {
        "name": "Replace Magic Number with Constant",
        "focus": "Raw literals in code",
        "description": (
            "Look for raw numeric or string literals that appear more than once or "
            "represent a domain concept (timeouts, limits, thresholds, special values "
            "like -1 for errors). Replace each with a named constant at the class or "
            "module level whose name explains the value's purpose. "
            "Example: MAX_RETRIES = 3 instead of if (count > 3)."
        ),
    },
    {
        "name": "Extract Class",
        "focus": "Classes doing too much",
        "description": (
            "Look for classes with 7+ methods, classes where some methods use one "
            "group of fields while others use a completely different group, or classes "
            "with a vague 'and' in their responsibility (e.g. 'handles validation and "
            "persistence'). Create a new class for each responsibility and delegate "
            "from the original."
        ),
    },
    {
        "name": "Introduce Parameter Object",
        "focus": "Related parameter groups (data clumps)",
        "description": (
            "Look for method signatures with 3+ related parameters that tend to "
            "appear together across multiple methods (a 'data clump'). Create a data "
            "class holding the grouped fields. Replace the parameter cluster with the "
            "new object in all methods that use it."
        ),
    },
    {
        "name": "Replace Error Code with Exception",
        "focus": "Return-code error handling",
        "description": (
            "Look for functions that return -1, null, false, empty collections, or "
            "error-struct objects to indicate failure. Define specific exception or "
            "error types for each failure mode. Replace return-based signaling with "
            "throw, and update callers to catch specific exceptions."
        ),
    },
    {
        "name": "Encapsulate Collection",
        "focus": "Exposed internal collections",
        "description": (
            "Look for public List, Map, or Set fields, or getter methods that return "
            "direct references to internal mutable collections. Replace with private "
            "fields, return UnmodifiableListView or equivalent read-only views, and add "
            "explicit add/remove methods for controlled mutation."
        ),
    },
    {
        "name": "Introduce Null Object",
        "focus": "Repeated null checks",
        "description": (
            "Look for if (x != null) checks repeated 3+ times before calling methods "
            "on the same type, or default/fallback logic scattered through callers. "
            "Create a class implementing the interface with no-op or safe-default "
            "implementations. Replace null assignments with the null object instance."
        ),
    },
    {
        "name": "Consolidate Duplicate Conditional Fragments",
        "focus": "Identical code in branches",
        "description": (
            "Look for identical lines of code appearing in every branch of a "
            "conditional (if/else, switch). The duplication is the smell: the code "
            "runs regardless of the condition. Move the common code to before or after "
            "the conditional, leaving only the branch-specific logic inside."
        ),
    },
    {
        "name": "Replace Inheritance with Delegation",
        "focus": "Misused inheritance hierarchies",
        "description": (
            "Look for subclasses that inherit from a parent but override most or all "
            "methods (the parent's interface is not truly shared). The is-a relationship "
            "is wrong: it should be has-a. Replace inheritance with a field holding an "
            "instance of the former parent, and delegate method calls to it."
        ),
    },
    {
        "name": "Move Method",
        "focus": "Methods in the wrong class",
        "description": (
            "Look for methods that call more methods on class B than on their own "
            "class A, or whose primary parameter is of type B with most operations "
            "targeting that parameter. The method lives in the wrong class. Move it to "
            "class B, passing the original host as a parameter if needed."
        ),
    },
    {
        "name": "Decompose Conditional",
        "focus": "Complex boolean expressions",
        "description": (
            "Look for if statements with complex boolean expressions involving "
            "&&, ||, !, and nested parentheses that require mental evaluation to "
            "understand. Extract each sub-expression into a named method that reads "
            "like a question: isEligible(), hasValidScore(), withinDeadline()."
        ),
    },
    {
        "name": "Replace Temp with Query",
        "focus": "Unnecessary temporary variables",
        "description": (
            "Look for local variables assigned once from an expression and used only "
            "in the same method. The variable adds clutter without adding clarity. "
            "Replace with a method call that computes the value on demand, especially "
            "when the same value is needed in multiple methods."
        ),
    },
    {
        "name": "Form Template Method",
        "focus": "Repeated algorithm structure across subclasses",
        "description": (
            "Look for similar methods in sibling subclasses that follow the same "
            "sequence of steps but differ in specific details (e.g. processOrder in "
            "DomesticOrder and InternationalOrder both validate, calculate shipping, "
            "apply tax, confirm, but each step differs). Define the algorithm skeleton "
            "in the base class as a template method and make the varying steps abstract "
            "hooks."
        ),
    },
]

_REFACTOR_LABEL = "refactoring"
_REFACTOR_INTERVAL = 3


# ─── Config loading ─────────────────────────────────────────────────────────────


def _load_env_file(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip().strip('"').strip("'")
    return result


def _parse_repo_url(url: str) -> tuple[str, str, str] | None:
    m = re.match(r"(https?://[^/]+)/(.+?)(?:\.git)?/?$", url.strip())
    if m:
        base, path = m.group(1), m.group(2)
        parts = path.rstrip("/").split("/")
        if len(parts) >= 2:
            owner = parts[-2]
            repo = parts[-1]
            return base, owner, repo
    return None


def _parse_gitlab_project_path(url: str) -> tuple[str, str] | None:
    m = re.match(r"(https?://[^/]+)/(.+?)(?:\.git)?/?$", url.strip())
    if m:
        base = m.group(1)
        project_path = m.group(2).rstrip("/")
        return base, project_path
    return None


def _load_config() -> dict[str, str]:
    cfg: dict[str, str] = {}

    env_path = Path.cwd() / ".grimes" / "env"
    if env_path.exists():
        cfg.update(_load_env_file(env_path))

    for key in (
        "GITEA_URL",
        "GITEA_TOKEN",
        "GITLAB_URL",
        "GITLAB_TOKEN",
        "GITHUB_URL",
        "GITHUB_TOKEN",
    ):
        if os.environ.get(key):
            cfg[key] = os.environ[key]

    has_gitlab = bool(cfg.get("GITLAB_URL"))
    has_gitea = bool(cfg.get("GITEA_URL"))
    has_github = bool(cfg.get("GITHUB_URL"))

    configured = sum([has_gitlab, has_gitea, has_github])
    if configured > 1:
        parts: list[str] = []
        if has_gitea:
            parts.append("GITEA_URL")
        if has_gitlab:
            parts.append("GITLAB_URL")
        if has_github:
            parts.append("GITHUB_URL")
        raise RuntimeError(
            "Multiple backends configured: "
            + " and ".join(parts)
            + ". Please set only one."
        )

    if has_gitlab:
        cfg["BACKEND"] = "gitlab"
        gl_parsed = _parse_gitlab_project_path(cfg["GITLAB_URL"])
        if gl_parsed:
            cfg["GITLAB_API_BASE"] = gl_parsed[0]
            cfg["GITLAB_PROJECT_PATH"] = gl_parsed[1]
            cfg["GITLAB_PROJECT_ENCODED"] = url_quote(gl_parsed[1], safe="")
    elif has_github:
        cfg["BACKEND"] = "github"
        gh_parsed = _parse_repo_url(cfg["GITHUB_URL"])
        if gh_parsed:
            cfg["GITHUB_API_BASE"] = "https://api.github.com"
            cfg["GITHUB_OWNER"] = gh_parsed[1]
            cfg["GITHUB_REPO"] = gh_parsed[2]
    elif has_gitea:
        cfg["BACKEND"] = "gitea"
        url_val = cfg.get("GITEA_URL", "")
        gitea_parsed = _parse_repo_url(url_val)
        if gitea_parsed:
            cfg["GITEA_API_BASE"] = gitea_parsed[0]
            cfg["GITEA_OWNER"] = gitea_parsed[1]
            cfg["GITEA_REPO"] = gitea_parsed[2]
    else:
        raise RuntimeError(
            "No backend configured. "
            + "Set GITEA_URL, GITLAB_URL, or GITHUB_URL "
            + "(and corresponding TOKEN) "
            + "in .grimes/env or environment variables."
        )

    return cfg


# ─── API error ──────────────────────────────────────────────────────────────────


class ForgeError(Exception):
    status: int
    message: str

    def __init__(self, status: int, message: str) -> None:
        self.status = status
        self.message = message
        super().__init__(f"API {status}: {message}")


# ─── Backend-agnostic API request ──────────────────────────────────────────────


def _build_forge_request(config: dict[str, str], backend: str) -> tuple[str, dict[str, str]]:
    if backend == "gitlab":
        api_base = config.get("GITLAB_API_BASE", "")
        token = config.get("GITLAB_TOKEN", "")
        project = config.get("GITLAB_PROJECT_ENCODED", "")
        missing = [
            k for k, v in [
                ("GITLAB_URL", api_base),
                ("GITLAB_TOKEN", token),
                ("GITLAB_PROJECT_PATH", project),
            ] if not v
        ]
        if missing:
            raise ForgeError(
                0, "Missing config: " + ", ".join(missing)
                + ". Set GITLAB_URL and GITLAB_TOKEN in .grimes/env.",
            )
        url = f"{api_base}/api/v4/projects/{project}"
        headers = {"PRIVATE-TOKEN": token, "Content-Type": "application/json"}
    elif backend == "github":
        api_base = config.get("GITHUB_API_BASE", "")
        token = config.get("GITHUB_TOKEN", "")
        owner = config.get("GITHUB_OWNER", "")
        repo = config.get("GITHUB_REPO", "")
        missing = [
            k for k, v in [
                ("GITHUB_URL", api_base),
                ("GITHUB_TOKEN", token),
                ("GITHUB_OWNER", owner),
                ("GITHUB_REPO", repo),
            ] if not v
        ]
        if missing:
            raise ForgeError(
                0, "Missing config: " + ", ".join(missing)
                + ". Set GITHUB_URL and GITHUB_TOKEN in .grimes/env.",
            )
        url = f"{api_base}/repos/{owner}/{repo}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        }
    else:
        api_base = config.get("GITEA_API_BASE", "")
        token = config.get("GITEA_TOKEN", "")
        owner = config.get("GITEA_OWNER", "")
        repo = config.get("GITEA_REPO", "")
        missing = [
            k for k, v in [
                ("GITEA_URL", api_base),
                ("GITEA_TOKEN", token),
                ("GITEA_OWNER", owner),
                ("GITEA_REPO", repo),
            ] if not v
        ]
        if missing:
            raise ForgeError(0, f"Missing config: {', '.join(missing)}. Set GITEA_URL and GITEA_TOKEN in .grimes/env.")
        url = f"{api_base}/api/v1/repos/{owner}/{repo}"
        headers = {"Authorization": f"token {token}", "Content-Type": "application/json", "Accept": "application/json"}
    return url, headers


def _api_request(
    method: str,
    path: str,
    body: dict[str, str | int | list[int] | list[str] | None] | None = None,
) -> object | None:
    config = _load_config()
    backend = config.get("BACKEND", "")
    base_url, headers = _build_forge_request(config, backend if backend else "gitea")
    return _do_http(method, f"{base_url}{path}", headers, body)


def _do_http(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, str | int | list[int] | list[str] | None] | None = None,
) -> object | None:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as raw_resp:  # pyright: ignore[reportAny]
            resp = cast(http.client.HTTPResponse, raw_resp)
            raw = resp.read()
            if not raw:
                return None
            return cast(object, json.loads(raw))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        detail: str = body_text
        try:
            err_parsed = cast(dict[str, object], json.loads(body_text))
            msg_val = err_parsed.get("message")
            if isinstance(msg_val, str):
                detail = msg_val
            err_msg = err_parsed.get("error")
            if isinstance(err_msg, str):
                detail = err_msg
        except Exception:
            pass
        raise ForgeError(e.code, detail)
    except urllib.error.URLError as e:
        raise ForgeError(0, f"Network error: {e.reason}")
    except TimeoutError:
        raise ForgeError(0, "Request timed out after 30s")
    except json.JSONDecodeError as e:
        raise ForgeError(0, f"Invalid JSON response: {e}")


# ─── Backend adapters ──────────────────────────────────────────────────────────


def _backend() -> str:
    return _load_config().get("BACKEND", "gitea")


def _milestone_key() -> str:
    return "milestone_id" if _backend() == "gitlab" else "milestone"


def _issue_id(issue: _McpIssue) -> int:
    return issue["number"]


def _state_param(value: str) -> str:
    if _backend() == "gitlab":
        if value == "open":
            return "opened"
        if value == "closed":
            return "closed"
    return value


def _set_state_payload(value: str) -> dict[str, str]:
    if _backend() == "gitlab":
        if value == "closed":
            return {"state_event": "close"}
        if value == "open":
            return {"state_event": "reopen"}
    return {"state": value}


def _list_issues_path(state: str, limit: int, milestone_id: int | None) -> str:
    if _backend() == "gitlab":
        s = _state_param(state)
        p = f"/issues?state={s}&per_page={limit}&scope=all"
        if milestone_id is not None:
            p += f"&milestone_id={milestone_id}"
        return p
    if _backend() == "github":
        p = f"/issues?state={state}&per_page={limit}"
        if milestone_id is not None:
            p += f"&milestone={milestone_id}"
        return p
    p = f"/issues?state={state}&limit={limit}&type=issues"
    if milestone_id is not None:
        p += f"&milestone={milestone_id}"
    return p


def _github_issue_db_id(issue_number: int) -> int:
    raw = _api_request("GET", f"/issues/{issue_number}")
    if raw is None:
        raise ForgeError(404, f"Issue #{issue_number} not found")
    issue_data = cast(dict[str, object], raw)
    db_id = issue_data.get("id")
    if not isinstance(db_id, int):
        raise ForgeError(
            0, f"Could not determine database ID for issue #{issue_number}"
        )
    return db_id


def _create_dependency(issue_number: int, blocked_by: int) -> None:
    backend = _backend()
    if backend == "gitlab":
        config = _load_config()
        project = config.get("GITLAB_PROJECT_ENCODED", "")
        _ = _api_request(
            "POST",
            f"/issues/{issue_number}/links?target_project_id={project}"
            + f"&target_issue_iid={blocked_by}&link_type=is_blocked_by",
        )
    elif backend == "github":
        sub_issue_db_id = _github_issue_db_id(blocked_by)
        try:
            _ = _api_request(
                "POST",
                f"/issues/{issue_number}/sub_issues",
                {"sub_issue_id": sub_issue_db_id},
            )
        except ForgeError as e:
            if e.status != 422:
                raise
    else:
        config = _load_config()
        _ = _api_request(
            "POST",
            f"/issues/{issue_number}/dependencies",
            {
                "index": blocked_by,
                "owner": config["GITEA_OWNER"],
                "repo": config["GITEA_REPO"],
            },
        )


def _get_dependencies(issue_number: int) -> list[_McpIssue]:
    backend = _backend()
    if backend == "gitlab":
        links = cast(
            list[_McpLink],
            _api_request("GET", f"/issues/{issue_number}/links") or [],
        )
        result: list[_McpIssue] = []
        for lnk in links:
            lt = lnk.get("link_type", "")
            if lt in ("is_blocked_by", "blocks"):
                result.append(
                    {
                        "number": lnk["iid"],
                        "title": lnk.get("title", ""),
                        "state": _normalize_state(lnk["state"]),
                    }
                )
        return result
    if backend == "github":
        subs = cast(
            list[_McpIssue],
            _api_request("GET", f"/issues/{issue_number}/sub_issues") or [],
        )
        return [
            {
                "number": s["number"],
                "title": s.get("title", ""),
                "state": s.get("state", "open"),
                "html_url": s.get("html_url", ""),
            }
            for s in subs
        ]
    return cast(
        list[_McpIssue],
        _api_request("GET", f"/issues/{issue_number}/dependencies") or [],
    )


def _get_blocks(issue_number: int, open_numbers: set[int]) -> list[_McpIssue]:
    backend = _backend()
    if backend == "gitlab":
        links = cast(
            list[_McpLink],
            _api_request("GET", f"/issues/{issue_number}/links") or [],
        )
        result: list[_McpIssue] = []
        for lnk in links:
            lt = lnk.get("link_type", "")
            iid = lnk["iid"]
            if lt == "blocks" and iid in open_numbers:
                result.append(
                    {
                        "number": iid,
                        "title": lnk.get("title", ""),
                        "state": _normalize_state(lnk["state"]),
                    }
                )
        return result
    if backend == "github":
        try:
            raw = _api_request("GET", f"/issues/{issue_number}/parent")
        except ForgeError:
            return []
        if raw is None:
            return []
        parent = cast(_McpIssue, raw)
        parent_num = parent["number"]
        if parent_num in open_numbers:
            return [
                {
                    "number": parent_num,
                    "title": parent.get("title", ""),
                    "state": parent.get("state", "open"),
                }
            ]
        return []
    return cast(
        list[_McpIssue],
        _api_request("GET", f"/issues/{issue_number}/blocks") or [],
    )


def _get_comments(issue_number: int) -> list[_McpComment]:
    if _backend() == "gitlab":
        path = f"/issues/{issue_number}/notes?sort=asc&per_page=100"
    else:
        path = f"/issues/{issue_number}/comments"
    return cast(list[_McpComment], _api_request("GET", path) or [])


def _normalize_state(state: str) -> str:
    if state == "opened":
        return "open"
    return state


def _normalize_issue(raw: _McpIssue) -> _McpIssue:
    if _backend() == "gitlab":
        raw["state"] = _normalize_state(raw["state"])
    return raw


def _web_url(issue: _McpIssue) -> str:
    return issue.get("web_url", issue.get("html_url", ""))


# ─── Refactor issue helpers ─────────────────────────────────────────────────────


def _has_refactor_label(issue: _McpIssue) -> bool:
    return any(
        lbl.get("name") == _REFACTOR_LABEL
        for lbl in issue.get("labels", [])
    )


def _fetch_milestone_issues(milestone_id: int) -> list[_McpIssue]:
    path = _list_issues_path("all", 100, milestone_id)
    raw = _api_request("GET", path)
    if not isinstance(raw, list):
        return []
    return [_normalize_issue(i) for i in cast(list[_McpIssue], raw)]


def _count_milestone_issues(milestone_id: int) -> tuple[int, int]:
    issues = _fetch_milestone_issues(milestone_id)
    refactor_count = sum(1 for i in issues if _has_refactor_label(i))
    feature_count = len(issues) - refactor_count
    return feature_count, refactor_count


def _build_refactor_body() -> str:
    lines: list[str] = []
    lines.append("### Description")
    lines.append("")
    lines.append("Scan recently-added code for ALL applicable patterns below and apply any")
    lines.append("that clearly improve the code. Behavior must be preserved.")
    lines.append("")
    lines.append("Pattern catalog:")
    lines.append("| # | Pattern | What to look for |")
    lines.append("|---|---------|-------------------|")
    for idx, pat in enumerate(REFACTOR_PATTERNS):
        p_name = pat["name"]
        p_focus = pat["focus"]
        assert isinstance(p_name, str)
        assert isinstance(p_focus, str)
        lines.append(f"| {idx} | {p_name} | {p_focus} |")
    lines.append("")
    lines.append("Details:")
    lines.append("")
    for idx, pat in enumerate(REFACTOR_PATTERNS):
        p_name = pat["name"]
        p_desc = pat["description"]
        assert isinstance(p_name, str)
        assert isinstance(p_desc, str)
        lines.append(f"{idx}. **{p_name}** — {p_desc}")
        lines.append("")
    lines.append("### Tasks")
    lines.append("")
    lines.append("* Scan recently-added code for all refactoring patterns and identify which apply")
    lines.append("* Apply all applicable patterns found")
    lines.append("* Run full test suite to confirm no behavior change")
    lines.append("")
    lines.append("### Tests")
    lines.append("")
    lines.append("* All existing tests pass unchanged after refactoring")
    lines.append("")
    return "\n".join(lines)


def _create_refactor_issue(milestone_id: int) -> dict[str, object]:
    title = "Refactor: Code quality sweep"
    body = _build_refactor_body()
    label_vals = _resolve_labels([_REFACTOR_LABEL])

    payload: dict[str, str | int | list[int] | list[str] | None] = {
        "title": title,
        "body": body,
    }
    payload[_milestone_key()] = milestone_id
    if label_vals:
        payload["labels"] = label_vals

    issue = cast(_McpIssue, _api_request("POST", "/issues", payload))
    return _issue_result_dict(issue)


# ─── Tool implementations ──────────────────────────────────────────────────────


def tool_list_milestones(_args: dict[str, object]) -> dict[str, object]:
    milestones = cast(
        list[_McpMilestone],
        _api_request("GET", "/milestones?state=open&limit=50") or [],
    )
    return {
        "milestones": [
            {"id": m["id"], "title": m["title"], "url": m.get("html_url", "")}
            for m in milestones
        ]
    }


def tool_create_milestone(args: dict[str, object]) -> dict[str, object]:
    title = args["title"]
    assert isinstance(title, str)

    existing = cast(
        list[_McpMilestone],
        _api_request("GET", "/milestones?state=open&limit=50") or [],
    )
    for m in existing:
        if m["title"] == title:
            return {
                "id": m["id"],
                "title": m["title"],
                "url": m.get("html_url", ""),
                "reused": True,
            }

    payload: dict[str, str | int | list[int] | list[str] | None] = {"title": title}
    if "description" in args:
        desc = args["description"]
        assert isinstance(desc, str)
        payload["description"] = desc
    if "due_date" in args:
        dd = args["due_date"]
        assert isinstance(dd, str)
        if _backend() == "gitlab":
            payload["due_date"] = dd
        else:
            payload["due_on"] = f"{dd}T00:00:00Z"

    m = cast(_McpMilestone, _api_request("POST", "/milestones", payload))
    return {
        "id": m["id"],
        "title": m["title"],
        "url": m.get("html_url", ""),
        "reused": False,
    }


MAX_TASKS = 3


def _resolve_labels(label_names: list[str]) -> list[int] | list[str]:
    if not label_names:
        return []
    if _backend() in ("gitlab", "github"):
        return label_names
    existing = cast(list[_McpLabel], _api_request("GET", "/labels?limit=50") or [])
    label_map: dict[str, int] = {lbl["name"]: lbl["id"] for lbl in existing}
    ids: list[int] = []
    for name in label_names:
        if name in label_map:
            ids.append(label_map[name])
        else:
            new_lbl = cast(
                _McpLabel,
                _api_request("POST", "/labels", {"name": name, "color": "#0075ca"}),
            )
            ids.append(new_lbl["id"])
    return ids


def _build_body(description: str, tasks: list[str], tests: list[str]) -> str:
    lines: list[str] = []
    lines.append("### Description")
    lines.append("")
    lines.append(description.strip())
    lines.append("")
    lines.append("### Tasks")
    lines.append("")
    for t in tasks:
        lines.append(f"- [ ] {t.strip()}")
    lines.append("")
    lines.append("### Tests")
    lines.append("")
    for t in tests:
        lines.append(f"- [ ] {t.strip()}")
    lines.append("")
    return "\n".join(lines)


def _validate_body_fields(
    description: str,
    tasks: list[str],
    tests: list[str],
    desc_msg: str = "description is required and must not be empty.",
) -> None:
    if not description:
        raise ValueError(desc_msg)
    if not tasks:
        raise ValueError("tasks must contain at least one item.")
    if len(tasks) > MAX_TASKS:
        raise ValueError(
            f"tasks has {len(tasks)} items but the maximum is {MAX_TASKS}. "
            + "Split this into multiple issues."
        )
    if not tests:
        raise ValueError(
            "tests must contain at least one item. "
            + "Every issue must have at least one named test case in the project test suite."
        )


def _extract_body_args(args: dict[str, object]) -> tuple[str, list[str], list[str]]:
    raw_desc = args.get("description", "")
    description = raw_desc.strip() if isinstance(raw_desc, str) else ""
    raw_tasks = args.get("tasks", [])
    tasks = cast(list[str], raw_tasks) if isinstance(raw_tasks, list) else []
    raw_tests = args.get("tests", [])
    tests = cast(list[str], raw_tests) if isinstance(raw_tests, list) else []
    return description, tasks, tests


def _issue_result_dict(issue: _McpIssue) -> dict[str, object]:
    normalized = _normalize_issue(issue)
    return {
        "number": _issue_id(normalized),
        "title": normalized["title"],
        "url": _web_url(normalized),
    }


def tool_create_issue(args: dict[str, object]) -> dict[str, object]:
    title = args["title"]
    assert isinstance(title, str)
    raw_mid = args.get("milestone_id")
    milestone_id = raw_mid if isinstance(raw_mid, int) else None
    description, tasks, tests = _extract_body_args(args)
    raw_labels = args.get("labels", [])
    label_names = cast(list[str], raw_labels) if isinstance(raw_labels, list) else []

    _validate_body_fields(description, tasks, tests)

    body = _build_body(description, tasks, tests)
    label_vals = _resolve_labels(label_names)

    payload: dict[str, str | int | list[int] | list[str] | None] = {
        "title": title,
        "body": body,
    }
    if milestone_id is not None:
        payload[_milestone_key()] = milestone_id
    if label_vals:
        payload["labels"] = label_vals

    issue = cast(_McpIssue, _api_request("POST", "/issues", payload))
    result: dict[str, object] = _issue_result_dict(issue)

    is_refactor = _REFACTOR_LABEL in label_names
    if not is_refactor and milestone_id is not None:
        feature_count, _refactor_count = _count_milestone_issues(milestone_id)
        raw_is_last = args.get("is_last", False)
        is_last = raw_is_last if isinstance(raw_is_last, bool) else False
        needs_interval_refactor = feature_count > 0 and feature_count % _REFACTOR_INTERVAL == 0
        needs_tail_refactor = is_last and not needs_interval_refactor
        if needs_interval_refactor or needs_tail_refactor:
            ref_result = _create_refactor_issue(milestone_id)
            result["refactor_issue"] = ref_result

    return result


def tool_add_dependency(args: dict[str, object]) -> dict[str, object]:
    issue_number = args["issue_number"]
    assert isinstance(issue_number, int)
    blocked_by = args["blocked_by"]
    assert isinstance(blocked_by, int)

    _create_dependency(issue_number, blocked_by)
    time.sleep(0.1)
    return {"issue": issue_number, "blocked_by": blocked_by, "linked": True}


def tool_list_issues(args: dict[str, object]) -> dict[str, object]:
    raw_state = args.get("state", "open")
    state = raw_state if isinstance(raw_state, str) else "open"
    raw_limit = args.get("limit", 50)
    limit = raw_limit if isinstance(raw_limit, int) else 50
    milestone_id: int | None = None
    if "milestone_id" in args:
        mid = args["milestone_id"]
        assert isinstance(mid, int)
        milestone_id = mid

    path = _list_issues_path(state, limit, milestone_id)
    issues = cast(list[_McpIssue], _api_request("GET", path) or [])
    return {
        "issues": [
            {
                "number": _issue_id(_normalize_issue(i)),
                "title": i["title"],
                "state": _normalize_issue(i)["state"],
                "url": _web_url(i),
            }
            for i in issues
        ]
    }


def tool_update_issue(args: dict[str, object]) -> dict[str, object]:
    issue_number = args["issue_number"]
    assert isinstance(issue_number, int)
    payload: dict[str, str | int | list[int] | list[str] | None] = {}

    has_body_fields = any(k in args for k in ("description", "tasks", "tests"))

    if has_body_fields:
        description, tasks, tests = _extract_body_args(args)

        _validate_body_fields(description, tasks, tests, "description is required when updating the issue body.")

        payload["description"] = _build_body(description, tasks, tests)

    if "title" in args:
        t = args["title"]
        assert isinstance(t, str)
        payload["title"] = t
    if "state" in args:
        s = args["state"]
        assert isinstance(s, str)
        if s not in ("open", "closed"):
            raise ValueError(f"state must be 'open' or 'closed', got {s!r}")
        payload.update(_set_state_payload(s))
    if "milestone_id" in args:
        mid = args["milestone_id"]
        assert isinstance(mid, int)
        payload[_milestone_key()] = mid
    if "labels" in args:
        raw_lbl = args["labels"]
        lbl_list = cast(list[str], raw_lbl) if isinstance(raw_lbl, list) else []
        payload["labels"] = _resolve_labels(lbl_list)

    if not payload:
        raise ValueError(
            "Nothing to update. Pass at least one of: "
            + "description+tasks+tests, title, state, milestone_id, labels."
        )

    method = "PUT" if _backend() == "gitlab" else "PATCH"
    issue = cast(_McpIssue, _api_request(method, f"/issues/{issue_number}", payload))
    result_dict = _issue_result_dict(issue)
    result_dict["state"] = _normalize_issue(issue)["state"]
    return result_dict


def tool_get_issue(args: dict[str, object]) -> dict[str, object]:
    raw_num = args.get("issue_number")
    if not isinstance(raw_num, int):
        raise ValueError("issue_number is required and must be an integer.")
    issue_number = raw_num

    issue = _normalize_issue(
        cast(_McpIssue, _api_request("GET", f"/issues/{issue_number}"))
    )

    try:
        raw_comments = _get_comments(issue_number)
    except ForgeError:
        raw_comments = []

    try:
        deps = _get_dependencies(issue_number)
    except ForgeError:
        deps = []

    return {
        "number": _issue_id(issue),
        "title": issue["title"],
        "url": _web_url(issue),
        "body": issue.get("body", ""),
        "state": issue["state"],
        "labels": [lbl["name"] for lbl in issue.get("labels", [])],
        "dependencies": [_issue_id(d) for d in deps],
        "comments": [c["body"] for c in raw_comments],
    }


def tool_get_next_issue(args: dict[str, object]) -> dict[str, object]:
    raw_mid = args.get("milestone_id")
    milestone_id = raw_mid if isinstance(raw_mid, int) else None
    path = _list_issues_path("open", 50, milestone_id)
    raw_issues = cast(list[_McpIssue], _api_request("GET", path) or [])

    open_issues = [_normalize_issue(i) for i in raw_issues]

    if not open_issues:
        return {"next_issue": None, "message": "No open issues found."}

    open_numbers: set[int] = {_issue_id(i) for i in open_issues}

    has_deps: bool = False
    ready: list[_ReadyIssue] = []
    for issue in open_issues:
        n = _issue_id(issue)
        try:
            deps = _get_dependencies(n)
        except ForgeError:
            deps = []
        if deps:
            has_deps = True
        open_blockers = [d for d in deps if d.get("state") == "open"]
        if not open_blockers:
            try:
                dependents = _get_blocks(n, open_numbers)
            except ForgeError:
                dependents = []
            if dependents:
                has_deps = True
            dep_ids = [_issue_id(d) for d in dependents]
            open_dependents = [d for d in dep_ids if d in open_numbers]
            ready.append(
                {
                    "issue": issue,
                    "open_dependents": len(open_dependents),
                    "dependency_ids": [_issue_id(d) for d in deps],
                }
            )

    if not ready:
        return {
            "next_issue": None,
            "message": "All open issues are currently blocked. "
            + "Check for dependency cycles.",
        }

    if not has_deps:
        ready.sort(key=lambda x: _issue_id(x["issue"]))
    else:
        ready.sort(key=lambda x: (-x["open_dependents"], _issue_id(x["issue"])))

    winner_entry = ready[0]
    winner = winner_entry["issue"]

    try:
        raw_comments = _get_comments(_issue_id(winner))
    except ForgeError:
        raw_comments = []

    wid = _issue_id(winner)
    return {
        "next_issue": {
            "number": wid,
            "title": winner["title"],
            "url": _web_url(winner),
            "body": winner.get("body", ""),
            "labels": [lbl["name"] for lbl in winner.get("labels", [])],
            "dependencies": winner_entry["dependency_ids"],
            "comments": [c["body"] for c in raw_comments],
        },
        "ready_count": len(ready),
        "message": (
            f"#{wid} is ready to work on (lowest issue number, no dependencies found)."
            if not has_deps
            else (
                f"#{wid} is ready to work on "
                + f"({winner_entry['open_dependents']} issue(s) waiting on it)."
                if winner_entry["open_dependents"] > 0
                else f"#{wid} is ready to work on."
            )
        ),
    }


# ─── Tool registry ─────────────────────────────────────────────────────────────

TOOLS: dict[str, _ToolEntry] = {
    "list_milestones": {
        "fn": tool_list_milestones,
        "schema": {
            "name": "list_milestones",
            "description": "List all open milestones in the configured repository.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    "create_milestone": {
        "fn": tool_create_milestone,
        "schema": {
            "name": "create_milestone",
            "description": (
                "Create a milestone in the repository. "
                "If a milestone with the same title already exists, "
                "returns it instead of creating a duplicate. "
                "Returns the milestone ID needed for create_issue calls."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Milestone title"},
                    "description": {
                        "type": "string",
                        "description": "Optional milestone description",
                    },
                    "due_date": {
                        "type": "string",
                        "description": "Optional due date, format YYYY-MM-DD",
                    },
                },
                "required": ["title"],
            },
        },
    },
    "create_issue": {
        "fn": tool_create_issue,
        "schema": {
            "name": "create_issue",
            "description": (
                "Create an issue in the repository and optionally attach it to a milestone. "
                "The body is built from structured fields — there is no free-form body. "
                "tasks is hard-limited to 3 items; the call is rejected if you pass more. "
                "tests must reference named test cases in the project test suite. "
                "Labels are created automatically if they do not exist. "
                "Returns the issue number needed for add_dependency calls. "
                "When a milestone_id is provided, after every 3 non-refactoring issues "
                "in that milestone a refactoring issue is automatically created that scans "
                "for all 15 applicable patterns. "
                "Additionally, if is_last is true, a refactor issue is created for the tail "
                "of the dependency chain. "
                "Wire dependencies as: last_feature -> refactor_issue -> next_feature."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Issue title"},
                    "milestone_id": {
                        "type": "integer",
                        "description": "Milestone ID from create_milestone. Omit to create without a milestone.",
                    },
                    "description": {
                        "type": "string",
                        "description": "One paragraph: the goal and how you will know it is done",
                    },
                    "tasks": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 3,
                        "minItems": 1,
                        "description": (
                            "Implementation steps — maximum 3. "
                            "Split into multiple issues if more are needed."
                        ),
                    },
                    "tests": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "description": (
                            "Named test cases in the project test suite. "
                            "Format: 'path/to/test_file::test_name — "
                            "what behaviour this proves'. "
                            "Must include at least one failure/error case."
                        ),
                    },
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional label names",
                    },
                    "is_last": {
                        "type": "boolean",
                        "description": (
                            "Set to true when this is the last issue in a dependency chain. "
                            "Creates a trailing refactor issue. "
                            "Example: A->B->C->Refactor->D(is_last=true)->Refactor."
                        ),
                    },
                },
                "required": ["title", "description", "tasks", "tests"],
            },
        },
    },
    "add_dependency": {
        "fn": tool_add_dependency,
        "schema": {
            "name": "add_dependency",
            "description": (
                "Mark an issue as blocked by another issue. "
                "Call this after all issues are created to wire up the dependency chain. "
                "The blocked issue cannot be closed until the blocker is closed."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": {
                        "type": "integer",
                        "description": "The issue that is blocked",
                    },
                    "blocked_by": {
                        "type": "integer",
                        "description": "The issue that blocks it",
                    },
                },
                "required": ["issue_number", "blocked_by"],
            },
        },
    },
    "list_issues": {
        "fn": tool_list_issues,
        "schema": {
            "name": "list_issues",
            "description": "List issues in the repository, "
            + "optionally filtered by milestone and state.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "milestone_id": {
                        "type": "integer",
                        "description": "Filter by milestone ID",
                    },
                    "state": {
                        "type": "string",
                        "description": "open, closed, or all (default: open)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 50)",
                    },
                },
                "required": [],
            },
        },
    },
    "update_issue": {
        "fn": tool_update_issue,
        "schema": {
            "name": "update_issue",
            "description": (
                "Update an existing issue. "
                + "To update the body, supply description + tasks + tests together "
                + "— all three are required when updating body content. "
                + "tasks is still limited to 3 items. "
                + "title, state, milestone_id, and labels can be updated independently. "
                + "Use state='closed' to close, state='open' to reopen."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": {
                        "type": "integer",
                        "description": "The issue number to update",
                    },
                    "description": {
                        "type": "string",
                        "description": "Replacement description (requires tasks + tests too)",
                    },
                    "tasks": {
                        "type": "array",
                        "items": {"type": "string"},
                        "maxItems": 3,
                        "minItems": 1,
                        "description": (
                            "Replacement task list — maximum 3 "
                            "(requires description + tests too)"
                        ),
                    },
                    "tests": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "description": "Replacement test list (requires description + tasks too)",
                    },
                    "title": {"type": "string", "description": "New title"},
                    "state": {"type": "string", "description": "'open' or 'closed'"},
                    "milestone_id": {
                        "type": "integer",
                        "description": "Reassign to this milestone ID",
                    },
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Replace all labels (use [] to clear)",
                    },
                },
                "required": ["issue_number"],
            },
        },
    },
    "get_next_issue": {
        "fn": tool_get_next_issue,
        "schema": {
            "name": "get_next_issue",
            "description": (
                "Return the next issue to work on. "
                "Finds open issues whose blockers are all closed (i.e. ready to start). "
                "Among those, returns the one that unblocks the most downstream work first. "
                "If milestone_id is omitted, searches all open issues across milestones."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "milestone_id": {
                        "type": "integer",
                        "description": "Restrict to a specific milestone",
                    },
                },
                "required": [],
            },
        },
    },
    "get_issue": {
        "fn": tool_get_issue,
        "schema": {
            "name": "get_issue",
            "description": (
                "Fetch a single issue by number with full details: "
                "body, comments, labels, dependencies, and URL. "
                "Use this to get the current state of an issue at any time."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "issue_number": {
                        "type": "integer",
                        "description": "The issue number to fetch",
                    },
                },
                "required": ["issue_number"],
            },
        },
    },
}


# ─── MCP JSON-RPC protocol ─────────────────────────────────────────────────────


def send(obj: dict[str, object]) -> None:
    _ = sys.stdout.write(json.dumps(obj) + "\n")
    _ = sys.stdout.flush()


def send_error(req_id: object | None, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def _send_tool_result(req_id: object | None, text: str, is_error: bool = False) -> None:
    send({"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}})


def handle(msg: dict[str, object]) -> None:
    raw_method = msg.get("method", "")
    method = raw_method if isinstance(raw_method, str) else ""
    req_id = msg.get("id")
    raw_params = msg.get("params", {})
    params = cast(dict[str, object], raw_params) if isinstance(raw_params, dict) else {}

    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "forge-mcp", "version": "1.1.0"},
                },
            }
        )

    elif method == "notifications/initialized":
        pass

    elif method == "ping":
        send({"jsonrpc": "2.0", "id": req_id, "result": {}})

    elif method == "tools/list":
        send(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": [t["schema"] for t in TOOLS.values()]},
            }
        )

    elif method == "tools/call":
        raw_name = params.get("name", "")
        tool_name = raw_name if isinstance(raw_name, str) else ""
        raw_args = params.get("arguments", {})
        tool_args = (
            cast(dict[str, object], raw_args) if isinstance(raw_args, dict) else {}
        )

        if tool_name not in TOOLS:
            send_error(req_id, -32601, f"Unknown tool: {tool_name}")
            return

        try:
            result = TOOLS[tool_name]["fn"](tool_args)
            _send_tool_result(req_id, json.dumps(result, indent=2))
        except ForgeError as e:
            _send_tool_result(req_id, f"API error {e.status}: {e.message}", is_error=True)
        except ValueError as e:
            _send_tool_result(req_id, f"Validation error: {e}", is_error=True)
        except Exception:
            _send_tool_result(req_id, f"Internal error: {traceback.format_exc()}", is_error=True)

    elif req_id is not None:
        send_error(req_id, -32601, f"Method not found: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            raw_msg = cast(object, json.loads(line))
            msg = cast(dict[str, object], raw_msg) if isinstance(raw_msg, dict) else {}
        except json.JSONDecodeError as e:
            send_error(None, -32700, f"Parse error: {e}")
            continue
        try:
            handle(msg)
        except Exception as e:
            req_id: object | None = msg.get("id")
            send_error(req_id, -32603, f"Internal error: {e}")


if __name__ == "__main__":
    main()
