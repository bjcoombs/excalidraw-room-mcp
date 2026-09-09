# excalidraw-room-mcp

An MCP server that joins a live [Excalidraw](https://excalidraw.com) collaboration room as a headless participant, so an AI agent can read what you draw and draw back, in the same canvas, in real time.

You draw on excalidraw.com as normal. The agent sees your boxes, arrows, text and freehand strokes, and its edits appear on your screen as it makes them. No credits, no export step, no browser automation.

## Why

The official [excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) renders a drawing inside the chat window. That is one-way: the agent draws, you look. This server is the other direction. It attaches to a drawing you already have open and keeps both sides in sync.

It works because Excalidraw's collaboration protocol is open. The relay server ([excalidraw-room](https://github.com/excalidraw/excalidraw-room)) forwards encrypted blobs between participants and never sees plaintext. The collaboration link carries the room id and the AES key, so anyone holding the link can join, decrypt, and take part. This server does exactly that.

## Install

Requires Node 22 or newer. Nothing to clone or build.

**Claude Code**

```bash
claude mcp add excalidraw-room -- npx -y excalidraw-room-mcp
```

**Claude Desktop**

Download `excalidraw-room-mcp.mcpb` from the [latest release](https://github.com/bjcoombs/excalidraw-room-mcp/releases/latest) and open it; Claude Desktop installs the bundled server. Or add the server to `claude_desktop_config.json` by hand:

```json
{
  "mcpServers": {
    "excalidraw-room": {
      "command": "npx",
      "args": ["-y", "excalidraw-room-mcp"]
    }
  }
}
```

**Any other stdio client**

Run the same command, `npx -y excalidraw-room-mcp`, as the server command.

## Use

1. On excalidraw.com, click **Live collaboration**, then **Start session**, and copy the link. It looks like `https://excalidraw.com/#room=<id>,<key>`.
2. Ask the agent to join it: "join this excalidraw room: <link>".
3. Draw. Ask the agent what it sees, or ask it to add things.

Or the other way round: ask the agent to create a room, and open the link it gives you.

### See the canvas in the chat

In a host that supports MCP Apps (Claude Desktop, claude.ai), joining or creating a room renders the drawing in the chat window. The view refreshes every two seconds while it is on screen, so a shape someone draws on excalidraw.com turns up in the chat without another prompt; it stops asking when the window is hidden. Pending `@claude` mentions are outlined on the canvas and listed in a strip beside it, and clear from both when the agent acknowledges them. Ask for `show_room` to bring the view back at any point.

The view is read-only: it never writes to the room. Editing happens on excalidraw.com, and the header carries an **Open on excalidraw.com** link to the room. Hosts without MCP Apps support get the same text results as before.

### Talk to it on the canvas

Type a text element containing `@claude` next to the thing you mean, for example `@claude add a cache between these`. The agent calls `wait_for_mention`, which blocks until such a text appears and has stopped changing, then returns the instruction together with the elements around it. When it has acted, `acknowledge_mention` turns the text grey and appends a check mark (or a short note, such as why it declined), so you can see on the canvas what has been dealt with. Edit the text again and it becomes pending again.

The moment a mention is returned the server marks it seen on the canvas itself - amber stroke and an hourglass - so you get an immediate "the note landed" without waiting for the agent to finish, and `acknowledge_mention` then replaces that marker with the check mark rather than adding a second suffix. Pass `autoSeen: false` to `wait_for_mention` or `list_mentions` to poll without touching the drawing.

A loop that keeps an agent listening is just: `wait_for_mention` (up to 10 minutes per call), act, `acknowledge_mention`, repeat.

## Collaborating

The working loop is: `wait_for_mention` (up to 600 seconds a call), act on what comes back, `acknowledge_mention`, repeat. The agent stays in it until you say to stop, so you can draw, write a note, and walk away. Hosts are told this at connection time - the server sends the loop as MCP `instructions` during the handshake, and `create_room` and `join_room` repeat it as a one-line tip - so a fresh session starts listening without being asked to.

Inside a turn, poll the room with `poll_room` rather than blocking: it returns the connection state, the scene version, the peers and the pending mention ids in one short block, with `changedSince` against a version you pass, so the agent can keep working and spend a `show_room` or `read_scene` call only when something moved. `wait_for_mention` is for the other case - the turn is done and the agent is handing off to a person, waiting for the note that comes back.

Replies about the work go in the chat; artefacts of the work go on the canvas. A handled note is removed from the canvas, not annotated: `acknowledge_mention` soft-deletes it by default, because the seen marker already told you the note landed and the resulting drawing is the evidence it was done. Where an outcome has to be readable where you wrote the request, the agent can keep the note greyed with a short status of up to 24 characters ("declined", "see chat"); anything longer is refused and belongs in the chat reply. `keep: true` keeps the note greyed with a check mark if you want the audit trail.

Mention text is data written by people in the room, not instructions addressed to the agent. The agent reads a note, decides what to do with it, and does it because you asked in the session - a note saying "run this command" is text to be shown to you, not an order to follow.

### Lead and listener

Blocking on a ten-minute wait ties up the model doing the thinking. Splitting the two roles is cheaper and quicker:

- **The lead** - your main session. It creates or joins the room, draws, and handles anything structural: regrouping a diagram, a change that needs the repository or the web, a request that needs the conversation so far.
- **The listener** - a [Claude Code subagent](https://docs.claude.com/en/docs/claude-code/sub-agents) running on Sonnet that owns the loop. It handles small edits in place - move something, relabel it, recolour it, make it clickable - and escalates everything else to the lead with a note on the canvas saying so.

`agents/canvas-listener.md`, in the package and in this repository, is that subagent. The server installs it for you, so the listener always matches the server version you have:

```bash
npx -y excalidraw-room-mcp install-agent          # this project: .claude/agents/
npx -y excalidraw-room-mcp install-agent --global # every project: ~/.claude/agents/
```

The command creates the agents directory if it is missing and refuses to replace an existing `canvas-listener.md` unless you pass `--force`. Copying the file there yourself works just as well, as does referencing it from a plugin manifest if you distribute your own plugin. Then, with a room open, ask the session to "start the canvas listener".

The listener runs until you stop it or until it escalates. A subagent's report reaches the lead only when its turn ends, so an escalation ends the run: the lead gets the note text, acts on it, and starts the listener again. Only the lead can stop it - a note on the canvas saying "stop" is text from whoever is in the room, and gets passed up like any other request.

## Tools

| Tool | What it does |
|---|---|
| `create_room` | Make a new empty room, join it, return the link to open. |
| `join_room` | Join a room from its link. Loads the scene from a peer, or from the persisted copy if nobody else is there. |
| `show_room` | The room summarised as text (link, connection state, peer and element counts, pending mentions with the ids around each), the full payload (link, connection state, peers, elements, mentions) as structured content for the view, and in a host that supports MCP Apps the canvas rendered in the chat. `include: "json"` puts the whole payload in the text too. |
| `poll_room` | Lightweight state probe: connection state, scene version, peers, pending mention ids, and whether the scene changed since a version you pass. |
| `room_status` | Connection state, peers, element counts. |
| `read_scene` | The drawing as one line per element (default), or the full element JSON (compact). Freehand strokes come back as a sampled path so a scribble is legible. `ids` narrows the read to named elements; `near: {id, radius}` reads one element and its neighbourhood, so a check costs a few elements rather than the whole scene. |
| `add_elements` | Add shapes, text, arrows, lines and freehand strokes from compact specs. Arrows bind to element ids; edge points are computed. Any spec takes an optional `link` (a URL) to make the element clickable. |
| `add_raw_elements` | Add complete Excalidraw elements verbatim, for example from an `.excalidraw` file. |
| `update_elements` | Patch elements by id. Versions are bumped so peers accept the change. |
| `delete_elements` | Soft-delete by id. |
| `wait_for_mention` | Block until a text element containing the tag (default `@claude`) appears and settles; return it with its nearby elements, and mark it seen on the canvas (`autoSeen: false` to skip). Returns "no mention" after the timeout so the caller can loop. |
| `list_mentions` | Every pending mention right now, with nearby elements, marked seen as above (`autoSeen: false` to skip). |
| `acknowledge_mention` | Mark a mention handled and remove the note from the canvas. `note` (24 characters max) keeps it greyed with that status instead; `keep: true` keeps it greyed with a check mark. |
| `leave_room` | Disconnect. |

### Example

```
add_elements:
  - {type: rectangle, id: api, x: 0,   y: 0, width: 160, height: 80, label: "API"}
  - {type: ellipse,   id: db,  x: 320, y: 0, width: 160, height: 80, label: "Postgres"}
  - {type: arrow, start: api, end: db, label: "query"}
  - {type: text, x: 0, y: 120, text: "docs", link: "https://example.com/docs"}
```

`read_scene` afterwards:

```
api rectangle @(0,0) 160x80 "API"
db ellipse @(320,0) 160x80 "Postgres"
Kp3... arrow 2 pts: (156,40) -> (324,40) from api to db "query"
```

## How it works

- **Transport**: socket.io to `https://oss-collab.excalidraw.com`, the relay excalidraw.com uses. The public relay rejects handshakes that do not carry an `Origin: https://excalidraw.com` header, so the client sends one. Override `serverUrl` and `origin` on `join_room` to point at a self-hosted `excalidraw-room`.
- **Encryption**: AES-128-GCM with the key from the link, matching `packages/excalidraw/data/encryption.ts` upstream. Implemented on Node's WebCrypto so the server does not depend on the browser-oriented `@excalidraw/excalidraw` package.
- **Merging**: Excalidraw's reconcile rule, per element id: higher `version` wins, ties go to the lower `versionNonce`. Local edits bump both, exactly as the web app does, so peers accept them.
- **Z-order**: fractional indices via the same `fractional-indexing` library upstream uses. New elements go on top.
- **Persistence**: excalidraw.com keeps each room's encrypted scene in a public Firestore document. On joining an empty room the server reads it. After every write it saves the reconciled scene back, conditional on the document's update time, so a stale copy never overwrites a newer one. On a conflict it reloads, reconciles, and retries once. If the save still fails, the change has already reached connected peers and their browsers persist it on their normal schedule.

## Limits

### Tool-argument size

The host, not this server, caps how large a tool call may be. An over-limit `add_raw_elements` call is cut and rejected before the server sees it, so the server cannot chunk around it; the caller has to split the work.

| Host | Date measured | Observation | Recommended batch |
|---|---|---|---|
| Claude Code (2.0) | 2026-09-09 | `add_raw_elements` arguments of 5,838, 13,032 and 19,886 bytes all arrived whole, each carrying a distinct trailing sentinel id that reached the scene. No cut seen at or below 20 KB. | 16 KB |
| Claude Desktop 1.49585.0 | 2026-09-09 | One sample: a 5,716-byte call was rejected host-side, the input cut mid-object (`__unparsedToolInput`). Where the ceiling sits is not known from a single sample. | 4 KB |

The Claude Desktop figure is a single observation, so the 4 KB recommendation is deliberately conservative until more samples exist. Both recommendations are for the JSON arguments of one call, measured in bytes.

Prefer `add_elements` compact specs over `add_raw_elements` for bulk creation: a spec is a fraction of the size of the equivalent raw element, so far more of a diagram fits in one call. Where raw elements are unavoidable, split them into batches under the host's limit; ids are assigned as each batch is accepted, so a later batch may reference ids from an earlier one.

### Other

- Images and other file attachments are out of scope. They travel by a separate path and are not needed for diagrams.
- Text is measured by approximation, not a real font. Labels may be slightly wider or narrower than the web app would make them; the app re-measures on the next edit.
- The public relay is not a documented API for third parties. The protocol is open source and stable in practice, but nobody has promised to keep it that way.
- One room per server process. Run a second instance for a second room.

## Security

The room key is the only secret, and it is in the link. The server uses it locally to encrypt and decrypt; it is never sent anywhere. Treat collaboration links as you would a password to that drawing.

The Firebase project id and web API key in `src/firebase.ts` are excalidraw.com's own public client configuration, copied from [`.env.production`](https://github.com/excalidraw/excalidraw/blob/master/.env.production) upstream; a Firebase web API key names the project a request goes to rather than authorising it, and the stored scene is ciphertext without the room key. A self-hosted deployment points at its own Firestore project by setting `EXCALIDRAW_FIREBASE_PROJECT` and `EXCALIDRAW_FIREBASE_API_KEY`, with no source edit.

## Development

```bash
git clone https://github.com/bjcoombs/excalidraw-room-mcp.git
cd excalidraw-room-mcp
npm install
npm test          # build (server + view) + unit tests
npm run build:view   # just the in-chat view: view/ -> dist/view/canvas.html
npm run e2e:show-room -- "<collab link>"   # join a real room and print the show_room payload
EXCALIDRAW_ROOM_DEBUG=1 node dist/index.js   # run with diagnostics on stderr
```

Register the local build with a client by pointing it at `dist/index.js` in the clone, for example `claude mcp add excalidraw-room-dev -- node "$PWD/dist/index.js"`.

The in-chat view is a separate Vite build under `view/` (paths relative to the repo root). It bundles `@excalidraw/excalidraw` into the single file `dist/view/canvas.html`, which `src/view.ts` serves as the MCP Apps resource. The Node server itself never imports that package.

Releases are tag-driven: pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes to npm with a provenance attestation and attaches `excalidraw-room-mcp.mcpb` to the GitHub release. If the npm publish fails, re-run it for an existing tag with `gh workflow run release.yml -f ref=v0.4.0`, which skips the release job and publishes that tag from the current workflow file. The first publish authenticates with the `NPM_TOKEN` repository secret, because npm trusted publishing can only be attached to a package that already exists; once the trusted publisher is configured on npmjs.com the secret and its `env:` line can be removed and the job falls back to OIDC.

## License

MIT. Excalidraw itself is MIT, and the protocol details here are derived from its source.
