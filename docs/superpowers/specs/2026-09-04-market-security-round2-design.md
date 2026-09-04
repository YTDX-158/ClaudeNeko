# ClaudeNeko Market Security Round 2 Design

## Scope and delivery

Implement the six items in `ClaudeNeko第二批修复任务单_20260904.md` on branch
`codex-fixes-round2-20260904`, based directly on `main@44225c4`. Each item is an
independent commit with a focused Node test that is observed failing before the
production change. The branch is pushed for Claude review but is not merged.

The round is split into four bounded units: configuration durability, remote
access security, complete-export integrity, and media-task persistence.

## 1. Configuration durability

`configService` will distinguish a missing file from an unreadable or malformed
file. A missing file is an empty starting configuration. Invalid JSON and other
read failures throw a typed `ConfigFileError`; write routes translate malformed
configuration into an explicit conflict response and do not restart PTYs.

Every successful replacement is written to a uniquely named temporary file in
the target directory, flushed by closing the file, and renamed over the target.
Before replacement, the currently valid file is copied into a three-generation
rotation: `.bak.1`, `.bak.2`, and `.bak.3`. Backup or replacement failure aborts
the save instead of falling back to an in-place write. Existing top-level fields,
hooks, permissions, and unrelated `env` members are preserved by merge.

## 2. Remote access security

### Local-only logs

The proxy deny policy will explicitly contain `/api/log` and
`/api/log/download`. The business-side local check remains defense in depth, but
the proxy is the authority that prevents an authenticated remote device from
reaching these endpoints.

### WebSocket revocation

The proxy will track both downstream and upstream sockets for every upgraded
connection and expose an idempotent `disconnectAll()`. The terminal channel will
also track connections marked by the proxy as remote and expose
`disconnectRemoteClients()`. A private loopback marker header is used only for
connection classification; it does not grant access.

The remote manager owns both disconnect operations. `stop()` disconnects first
and then closes the proxy and tunnel. Pair-code regeneration clears persisted
sessions and calls the same disconnect operation. Local desktop WebSockets are
not disconnected when remote credentials rotate.

### Pair endpoint CSRF and rate limiting

Rendering the pairing page issues a random, short-lived nonce bound to a source
key. JavaScript submits it in a custom header. `POST /pair` requires JSON, an
Origin whose host exactly matches the request Host, and a valid unused nonce.
Cross-site simple-form requests and requests without the nonce are rejected
without counting as code guesses.

Rate limiting has two layers: five failed code guesses per source in 60 seconds,
and fifty failed guesses globally in 60 seconds. The source key prefers
Cloudflare's connecting-IP header, then the first forwarded address, then the
socket address. Lock checks run before request-body reading. A consumed nonce is
replaced in each failed response so the legitimate page can retry without a
reload. Existing authenticated traffic is unaffected by pair-attempt locks.

## 3. Complete-export integrity

Export-all uses an all-or-nothing preparation step. More than 200 sessions is
rejected with HTTP 413 before messages are read. If serialized session data
exceeds 500 MiB, preparation aborts and returns 413 without constructing or
returning a partial archive. Only a complete set reaches `createZip`.

The web client replaces anchor navigation with `fetch`. It displays the server's
error on non-2xx responses and downloads the ZIP blob only after a successful
response. A successful response includes `X-ClaudeNeko-Export-Complete: true`.

## 4. Media-task persistence

`gen_tasks.json` becomes a recovery queue rather than a task-object dump.
Persistence includes only running tasks and only the fields required to resume:
status, timestamp, resolution, model, ratio, and duration. Credentials, endpoint
URLs, prompts, session IDs, query promises, locks, ownership, errors, and retry
metadata are never serialized.

On startup, terminal tasks, expired running tasks, malformed entries, tasks
beyond the single-task concurrency limit, and tasks whose model no longer has a
configured credential are removed by rewriting the file. A valid running task is
rehydrated in memory with the current model configuration's endpoint and key,
then claimed normally. When a task reaches a terminal state it disappears from
disk immediately, while its in-memory public status remains available for the
existing retention period.

## Error handling and compatibility

- Configuration corruption preserves the original bytes and surfaces a specific
  response instead of silently treating the file as empty.
- Socket disconnection is idempotent and tolerates already-closed connections.
- Pair security responses do not reveal whether a code was correct.
- Export errors name the violated limit and never emit a ZIP response.
- Unrecoverable persisted media tasks are dropped with a warning; no secret is
  written while attempting recovery.

## Verification

Focused tests cover malformed configuration preservation and backup rotation,
remote log denial, proxy and terminal socket cleanup, credential regeneration,
same-origin/nonce validation and dual rate limits, all-or-nothing export limits
and client error handling, and sanitized task persistence/restart cleanup.
Completion additionally requires the full Node suite, Vite production build,
syntax checks for every server JavaScript file, `git diff --check`, and a clean
worktree.
