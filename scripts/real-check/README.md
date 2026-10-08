# Real check: a human and two live agents on one board

The last acceptance step of versions and merge ([design](../../docs/DESIGN.md#concurrency-acceptance-wave-2)):
you draw in the canvas while two live agents (Sonnet) edit the same board through the `xcld`
MCP server, and a watcher prints every merge and history entry. You then confirm that nothing
was silently lost, and that the banner, `diff --since` and history explain what happened.

Everything runs in a separate Compose project, `xcld-w2r`, on port **3241** (canvas) with its
own boards folder and history volume, so your normal workspace on 3100 is not touched.

## 1. Start the stack (once)

From the repo root, with the image built (`.\build.ps1`):

```powershell
.\scripts\real-check\start.ps1          # -Reset starts over: removes the stack, its history and boards
```

It starts `xcld-w2r`, writes the demo board `realcheck/demo` from [`demo.mmd`](demo.mmd)
(Web client → API → Orders/Payments services, Orders DB, Ledger, Event queue → Notifications,
Analytics), waits for its layout (instant if the board is open in a tab, else the server's grid
after about 2 minutes) and pins it as the snapshot `kickoff`. Boards are in
`.scratch\real-check\boards` (gitignored).

Open <http://127.0.0.1:3241/?board=realcheck/demo>. Your author name is at the bottom
("Author: …"); click it to change it.

## 2. Start the watcher

In a second terminal:

```powershell
docker exec -it xcld-w2r xcld watch realcheck/demo
```

Every write prints a `MERGED` line (who, what applied, what was `OVERWRITTEN` and who lost), and
every history entry a `HISTORY` line (new, grew, closed). Leave it running; it is the record you
compare against at the end. (`--json` prints one object per line if you want to keep a file:
`... xcld watch realcheck/demo --json | Tee-Object .scratch\real-check\watch.jsonl`.)

## 3. Start two agents

Two separate agent sessions, each with its own `xcld mcp` process, so they write as two authors
(`agent:<client>#<id>`, different ids). Run them from an empty folder so they don't touch the
repo, for example `.scratch\real-check`:

**Copilot CLI** (two terminals):

```powershell
cd .scratch\real-check
copilot --model <a Sonnet model, e.g. claude-sonnet-5> --additional-mcp-config "@..\..\scripts\real-check\mcp-config.json"
```

[`mcp-config.json`](mcp-config.json) adds the server `xcld-w2r`:
`docker exec -i xcld-w2r xcld mcp`. Check with `/mcp` that its tools (`read_board`,
`write_board`, `write_mermaid`, `diff`, `snapshot`, …) are listed. Pick the model with `/model`
if you prefer.

**Or VS Code** (Copilot Chat, agent mode) for one of them: add the server to your user
`mcp.json` (Command Palette → "MCP: Open User Configuration"), under `"servers"`:

```json
{
  "servers": {
    "xcld-w2r": { "type": "stdio", "command": "docker", "args": ["exec", "-i", "xcld-w2r", "xcld", "mcp"] }
  }
}
```

and choose a Sonnet model in the chat's model picker.

## 4. Prompts

Paste one into each agent at about the same time. They read first, wait, then write, so their
bases go stale and their edits overlap with each other's and yours. *API* and *Event queue* are
edited by two writers each; everything else is disjoint.

**Agent A (Mermaid):**

```text
You are working on the shared board realcheck/demo through the xcld-w2r MCP tools. Others (a
human and another agent) are editing it at the same time. Do not write any files directly.
1. Call read_board for realcheck/demo (Mermaid) and keep its version.
2. Wait 30 seconds (run a 30-second sleep in the shell) so others can edit meanwhile.
3. Using write_mermaid with base = that version, change the Mermaid you read: rename node API
   to "API gateway", add a node Cache["Order cache"] between API and Orders (API --> Cache -->
   Orders, drop API --> Orders), and mark Cache as proposed
   (classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2). Keep every other node id and
   label as you read them.
4. Report the result: status, version, applied, overwritten, and the author key it names.
5. Read the board again, wait 20 seconds, then with write_mermaid (base = the new version)
   rename Notify to "Notification service".
6. Call diff with board realcheck/demo and since "author:<your author key>". Tell me exactly
   what changed since your last write and which of your edits, if any, were overwritten and by
   whom. Do not redo an overwritten edit; ask me instead.
```

**Agent B (board JSON):**

```text
You are working on the shared board realcheck/demo through the xcld-w2r MCP tools. Others (a
human and another agent) are editing it at the same time. Do not write any files directly.
1. Call read_board for realcheck/demo with format "json" and keep its version.
2. Wait 30 seconds (run a 30-second sleep in the shell) so others can edit meanwhile.
3. With write_board, base = that version, send the whole board you read with these changes
   only: the API shape's strokeColor "#e03131" (red); the Event queue label to "Kafka topic";
   the Ledger label to "Ledger v2"; and a new free text element "Owner: payments team" just
   right of the Ledger shape (a text element without containerId). Keep every other element
   exactly as read; bound text stays with its container.
4. Report the result: status, version, applied, overwritten, and the author key it names.
5. Call diff with board realcheck/demo and since "author:<your author key>". Tell me what
   changed since your write and which of your edits, if any, were overwritten and by whom. Do
   not redo an overwritten edit; ask me instead.
```

**You, in the canvas, while they wait:** rename *Event queue* to *Order events*, move
*Analytics* somewhere else, and draw a new box *Fraud check* next to *Payments service*. Keep
editing for a while after the agents write: the tab saves your pending edits before it shows
their merge. Press Ctrl+S once at the end.

Optional, to see a stale queued Mermaid write lose (D8): ask agent A to read, wait 60 s, and
rename *Analytics* while you rename it too in the meantime.

## 5. Check

Nothing silently lost, and the story is told:

1. **Banner.** Each agent write showed a banner in the tab ("Merged from …"), and any unit two
   writers changed without seeing each other shows "overwritten" with who won (details lists
   them).
2. **Watcher.** Every write appears as a `MERGED` line; every turn as a `HISTORY` line. No write
   an agent reported is missing (`queued` answers land a moment later and still print).
3. **`diff --since`**, the whole session:

   ```powershell
   docker exec xcld-w2r xcld diff realcheck/demo --since kickoff
   ```

   Every intended edit (the list above: yours and both agents') is either in the diff, or listed
   under "Overwritten since then" with its loser's label, or was replaced by a writer who had
   already seen it (the watcher's order shows that). *API* and *Event queue* are the expected
   conflicts: for each, the later edit by write time wins the whole shape and label.
4. **Each agent's own view** (step 6 / 5 of its prompt) agrees with the watcher: it names the
   edits of its own that lost, and the winner.
5. **History.** One entry per turn, the right authors, and your turn(s) closed by the agents'
   writes or Ctrl+S:

   ```powershell
   docker exec xcld-w2r xcld diff realcheck/demo --since author:<your name>
   docker exec xcld-w2r xcld history export realcheck/demo --full     # every version as a file
   ```

   The export lands in `.scratch\real-check\cache\exports\realcheck\demo\`; each entry's
   `.meta.json` has the losing elements under `overwritten`.
6. **Status.** `curl.exe -s http://127.0.0.1:3241/api/status` shows `pending: {}` (nothing
   stuck) and any slow disk operations (`slowIo`) that explain a `queued` answer.

If something is missing, keep the watcher output and the export and note the time.

## Stop

From the repo root:

```powershell
docker compose -p xcld-w2r down        # keeps this stack's history volume
docker compose -p xcld-w2r down -v     # also deletes it
```
