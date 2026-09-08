# excalidraw-room-mcp

An MCP server that joins a live [Excalidraw](https://excalidraw.com) collaboration room as a headless participant, so an AI agent can read what you draw and draw back, in the same canvas, in real time.

You draw on excalidraw.com as normal. The agent sees your boxes, arrows, text and freehand strokes, and its edits appear on your screen as it makes them. No credits, no export step, no browser automation.

## Why

The official [excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) renders a drawing inside the chat window. That is one-way: the agent draws, you look. This server is the other direction. It attaches to a drawing you already have open and keeps both sides in sync.

It works because Excalidraw's collaboration protocol is open. The relay server ([excalidraw-room](https://github.com/excalidraw/excalidraw-room)) forwards encrypted blobs between participants and never sees plaintext. The collaboration link carries the room id and the AES key, so anyone holding the link can join, decrypt, and take part. This server does exactly that.

## Install

Requires Node 22 or newer.

```bash
git clone https://github.com/bjcoombs/excalidraw-room-mcp.git
cd excalidraw-room-mcp
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add excalidraw-room -- node /absolute/path/to/excalidraw-room-mcp/dist/index.js
```

Or with any other MCP client that speaks stdio, using the same command.

## Use

1. On excalidraw.com, click **Live collaboration**, then **Start session**, and copy the link. It looks like `https://excalidraw.com/#room=<id>,<key>`.
2. Ask the agent to join it: "join this excalidraw room: <link>".
3. Draw. Ask the agent what it sees, or ask it to add things.

Or the other way round: ask the agent to create a room, and open the link it gives you.

## Tools

| Tool | What it does |
|---|---|
| `create_room` | Make a new empty room, join it, return the link to open. |
| `join_room` | Join a room from its link. Loads the scene from a peer, or from the persisted copy if nobody else is there. |
| `room_status` | Connection state, peers, element counts. |
| `read_scene` | The drawing as one line per element (default), or the full element JSON. Freehand strokes come back as a sampled path so a scribble is legible. |
| `add_elements` | Add shapes, text, arrows, lines and freehand strokes from compact specs. Arrows bind to element ids; edge points are computed. |
| `add_raw_elements` | Add complete Excalidraw elements verbatim, for example from an `.excalidraw` file. |
| `update_elements` | Patch elements by id. Versions are bumped so peers accept the change. |
| `delete_elements` | Soft-delete by id. |
| `leave_room` | Disconnect. |

### Example

```
add_elements:
  - {type: rectangle, id: api, x: 0,   y: 0, width: 160, height: 80, label: "API"}
  - {type: ellipse,   id: db,  x: 320, y: 0, width: 160, height: 80, label: "Postgres"}
  - {type: arrow, start: api, end: db, label: "query"}
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
- **Persistence**: excalidraw.com keeps each room's encrypted scene in a public Firestore document. On joining an empty room the server reads it. After every write it attempts a best-effort overwrite of that document. If the write is refused, the change still reaches connected peers and their browsers persist it on their normal schedule.

## Limits

- Images and other file attachments are out of scope. They travel by a separate path and are not needed for diagrams.
- Text is measured by approximation, not a real font. Labels may be slightly wider or narrower than the web app would make them; the app re-measures on the next edit.
- The public relay is not a documented API for third parties. The protocol is open source and stable in practice, but nobody has promised to keep it that way.
- One room per server process. Run a second instance for a second room.

## Security

The room key is the only secret, and it is in the link. The server uses it locally to encrypt and decrypt; it is never sent anywhere. Treat collaboration links as you would a password to that drawing.

## Development

```bash
npm test          # build + unit tests
EXCALIDRAW_ROOM_DEBUG=1 node dist/index.js   # run with diagnostics on stderr
```

## License

MIT. Excalidraw itself is MIT, and the protocol details here are derived from its source.
