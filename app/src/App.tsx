import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateBoardPath } from "../../tools/board-path.mjs";
import { stampMermaidHash } from "../../tools/mermaid-hash.mjs";
import {
  FALLBACK_NAME,
  NAME_STORAGE_KEY,
  TAB_CHANNEL,
  authorKey,
  guardTabId,
  identityHeaders,
  newTabId,
  readStoredName,
  readTabId,
  replaceTabId,
  resolveAuthorName,
  storeName,
} from "./identity.mjs";
import { disambiguateDuplicateElementIds } from "./ids.mjs";
import { addBannerItems, bannerDetails, bannerSummary, mergeItems } from "./merge-banner.mjs";
import { keepEditsSinceSave, reapplyUnsavedEdits, serverCopies, wireElements } from "./tab-merge.mjs";

type SceneFile = {
  type: "excalidraw";
  version: number;
  source?: string;
  elements: readonly ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
  scrollToContent?: boolean;
  // The elements as the server wrote them, before Excalidraw's restore filled in defaults.
  rawElements?: readonly { id: string }[];
};

type BoardSummary = {
  name: string;
  folder: string;
  leaf: string;
  hasBoard: boolean;
  hasMermaid: boolean;
  hasView: boolean;
  mermaidPending: boolean;
  viewPending: boolean;
  modified: string | null;
};

type BoardIndex = {
  boards: BoardSummary[];
  folders: string[];
};

type StatusLevel = "ok" | "warn" | "error";

type Status = {
  level: StatusLevel;
  text: string;
};

const SAVE_DEBOUNCE_MS = 1000;
const MAX_STALE_RETRIES = 3;
const REAPPLIED_TEXT = "Board changed elsewhere; your edits were re-applied";
const MERGED_TEXT = "Board changed elsewhere; the server merged your edits";
const DEFAULT_APP_STATE: Partial<AppState> = {
  viewBackgroundColor: "#ffffff",
};

type MergeUnit = { unitId: string; label: string; kind: string };
type OverwrittenUnit = {
  unitId: string;
  label: string;
  winner: { author: string; writtenAt: number };
  loser: { author: string; writtenAt: number };
};
// What a save answers (PUT /api/board) and what the `merged` SSE event carries.
type MergeReport = { applied?: MergeUnit[]; overwritten?: OverwrittenUnit[] };
type SaveAnswer = MergeReport & { hash?: string; version?: string; merged?: boolean; master?: SceneFile };
type MergedEvent = MergeReport & { name?: string; version?: string; author?: string };
type BannerItem = ReturnType<typeof mergeItems>[number];
type Identity = { name: string; tabId: string };

const browserStorage = (kind: "localStorage" | "sessionStorage") => {
  try {
    return window[kind];
  } catch {
    return null;
  }
};

// Excalidraw bumps an element's version on every edit, so a changed sum means the elements changed.
const sceneVersion = (elements: readonly ExcalidrawElement[]) => elements.reduce((sum, element) => sum + (element.version ?? 0), 0);

const textHash = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const readBoardParam = () => {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("board")) {
    return { boardName: null, invalidBoardName: null };
  }
  const raw = params.get("board") ?? "";
  return validateBoardPath(raw).ok
    ? { boardName: raw, invalidBoardName: null }
    : { boardName: null, invalidBoardName: raw };
};

const boardApiPath = (prefix: "board" | "mermaid" | "view", boardName: string) => `/api/${prefix}/${encodeURIComponent(boardName)}`;

const etagHash = (response: Response) => response.headers.get("ETag")?.replace(/^"(.*)"$/, "$1") || null;

type SceneState = {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

// What is on disk now: `hash` is the server's content hash, null when the board doesn't exist.
type RemoteBoard = { hash: string | null; text: string | null; scene: SceneFile | null };

const sceneFromText = (text: string): SceneFile => {
  const parsed = JSON.parse(text) as SceneFile;
  return {
    type: "excalidraw",
    version: parsed.version ?? 2,
    source: parsed.source,
    elements: restoreElements(parsed.elements ?? [], null),
    appState: { ...DEFAULT_APP_STATE, ...(parsed.appState ?? {}) },
    files: parsed.files ?? {},
    rawElements: (JSON.parse(text) as SceneFile).elements ?? [],
  };
};

const sceneToText = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => serializeAsJSON(elements, appState, files, "local");

const persistedSceneText = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => {
  const text = sceneToText(elements, appState, files);
  return text.endsWith("\n") ? text : `${text}\n`;
};

const sceneHash = (scene: SceneFile) => textHash(persistedSceneText(scene.elements, scene.appState ?? {}, scene.files ?? {}));

const elementHash = (elements: readonly ExcalidrawElement[]) => textHash(JSON.stringify(
  elements.map((element) => ({
    id: element.id,
    type: element.type,
    isDeleted: element.isDeleted ?? false,
    version: element.version ?? null,
    versionNonce: (element as { versionNonce?: number }).versionNonce ?? null,
    seed: (element as { seed?: number }).seed ?? null,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    text: (element as { text?: string }).text ?? null,
  })),
));

const hasLiveElements = (elements: readonly ExcalidrawElement[]) => elements.some((element) => !element.isDeleted);

const isFullExcalidrawElement = (element: unknown) => {
  const candidate = element as { version?: unknown; seed?: unknown; versionNonce?: unknown };
  return typeof candidate?.version === "number" || typeof candidate?.seed === "number" || typeof candidate?.versionNonce === "number";
};

const sceneFromViewInbox = (view: { elements?: unknown[] }): SceneFile => {
  const rawElements = Array.isArray(view.elements) ? view.elements : [];
  const elements = rawElements.length && rawElements.every(isFullExcalidrawElement)
    ? restoreElements(rawElements as ExcalidrawElement[], null)
    : convertToExcalidrawElements(disambiguateDuplicateElementIds(rawElements), {
        regenerateIds: false,
      }) as ExcalidrawElement[];
  return {
    type: "excalidraw",
    version: 2,
    source: "xcld-view-inbox",
    elements,
    appState: DEFAULT_APP_STATE,
    files: {},
  };
};

const formatModified = (value: string | null) => {
  if (!value) {
    return "not saved yet";
  }
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const navigateToBoard = (name: string) => {
  window.location.assign(`${window.location.pathname}?board=${encodeURIComponent(name)}`);
};

const BoardBrowser = ({ invalidBoardName }: { invalidBoardName: string | null }) => {
  const [index, setIndex] = useState<BoardIndex>({ boards: [], folders: [] });
  const [status, setStatus] = useState<Status>({ level: "warn", text: "Loading boards..." });
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardError, setNewBoardError] = useState<string | null>(null);

  const loadBoards = useCallback(async () => {
    try {
      const response = await fetch("/api/boards");
      if (!response.ok) {
        throw new Error(`Board list failed: HTTP ${response.status}`);
      }
      const data = (await response.json()) as BoardIndex;
      setIndex(data);
      setStatus({ level: "ok", text: `${data.boards.length} board${data.boards.length === 1 ? "" : "s"}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ level: "error", text: message });
    }
  }, []);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("board", () => {
      void loadBoards();
    });
    events.onerror = () => {
      setStatus({ level: "warn", text: "SSE disconnected; retrying..." });
    };
    return () => events.close();
  }, [loadBoards]);

  const groups = useMemo(() => {
    const byFolder = new Map<string, BoardSummary[]>();
    for (const board of index.boards) {
      const group = byFolder.get(board.folder) ?? [];
      group.push(board);
      byFolder.set(board.folder, group);
    }
    return [...byFolder.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [index.boards]);

  const submitNewBoard = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = newBoardName.trim();
    const validation = validateBoardPath(trimmed);
    if (!validation.ok) {
      setNewBoardError(`Invalid board path: ${trimmed || "<empty>"}`);
      return;
    }
    navigateToBoard(trimmed);
  };

  return (
    <main className="app-shell browser-shell">
      <header className="topbar">
        <div>
          <strong>Local Excalidraw workspace</strong>
          <span className="board-name">All boards</span>
        </div>
        <div className={`status ${status.level}`}>{status.text}</div>
      </header>
      <section className="board-browser">
        {invalidBoardName ? (
          <div className="banner error">Invalid board path: {invalidBoardName}</div>
        ) : null}
        <div className="browser-header">
          <div>
            <h1>Boards</h1>
            <p>Open a board, or create a nested board path such as <code>myproject/flow</code>.</p>
          </div>
          <form className="new-board" onSubmit={submitNewBoard}>
            <label htmlFor="new-board-name">New board</label>
            <div>
              <input
                id="new-board-name"
                value={newBoardName}
                placeholder="myproject/flow"
                onChange={(event) => {
                  setNewBoardName(event.target.value);
                  setNewBoardError(null);
                }}
              />
              <button type="submit">Open</button>
            </div>
            {newBoardError ? <div className="form-error">{newBoardError}</div> : null}
          </form>
        </div>
        {groups.length ? groups.map(([folder, boards]) => (
          <section className="board-group" key={folder || "root"}>
            <h2>{folder || "Root"}</h2>
            <ul className="board-list">
              {boards.map((board) => (
                <li key={board.name}>
                  <a href={`?board=${encodeURIComponent(board.name)}`}>{board.name}</a>
                  <span className="badges">
                    {board.hasBoard ? <span className="badge">board</span> : null}
                    {board.hasMermaid ? <span className="badge">mmd</span> : null}
                    {board.hasView ? <span className="badge">view</span> : null}
                    {board.mermaidPending ? <span className="badge warn">Mermaid waiting to convert</span> : null}
                    {board.viewPending ? <span className="badge warn">View waiting to convert</span> : null}
                  </span>
                  <span className="modified">{formatModified(board.modified)}</span>
                </li>
              ))}
            </ul>
          </section>
        )) : (
          <div className="empty-state">No boards yet. Create one above.</div>
        )}
      </section>
    </main>
  );
};

// Non-modal: it never takes focus (its buttons keep focus where it was on mouse down).
const MergeBanner = ({ items, onDismiss }: { items: BannerItem[]; onDismiss: () => void }) => {
  const [open, setOpen] = useState(false);
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <div className="merge-banner" role="status" aria-live="polite" data-testid="merge-banner">
      <div className="merge-banner-line">
        <span className="merge-banner-summary">{bannerSummary(items)}</span>
        <button type="button" onMouseDown={keepFocus} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? "hide details" : "details"}
        </button>
        <button type="button" className="merge-banner-close" onMouseDown={keepFocus} onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
      {open ? (
        <ul className="merge-banner-details" data-testid="merge-banner-details">
          {bannerDetails(items).map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      ) : null}
    </div>
  );
};

const AuthorOverlay = ({ name, onRename }: { name: string; onRename: (name: string) => void }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const cancelledRef = useRef(false);
  const finish = () => {
    setEditing(false);
    if (!cancelledRef.current) {
      onRename(draft);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancelledRef.current = true;
      event.currentTarget.blur();
    }
  };
  return (
    <div className="author-overlay" data-testid="author-overlay">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            finish();
          }}
        >
          <label htmlFor="xcld-author-name">Author:</label>
          <input
            id="xcld-author-name"
            autoFocus
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={finish}
            onKeyDown={onKeyDown}
          />
        </form>
      ) : (
        <button
          type="button"
          title="Your name in version history and in other tabs' banners. Click to rename; it is remembered in this browser."
          onClick={() => {
            cancelledRef.current = false;
            setDraft(name);
            setEditing(true);
          }}
        >
          Author: <strong>{name}</strong>
        </button>
      )}
    </div>
  );
};

const BoardView = ({ boardName }: { boardName: string }) => {
  const [initialData, setInitialData] = useState<SceneFile | null>(null);
  const [status, setStatus] = useState<Status>({
    level: "warn",
    text: "Loading board...",
  });
  const [deletedOnDisk, setDeletedOnDisk] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saveTimerRef = useRef<number | undefined>();
  const applyingRemoteRef = useRef(false);
  const deletedOnDiskRef = useRef(false);
  const lastLoadedHashRef = useRef<string>("");
  const lastSavedHashRef = useRef<string>("");
  const lastLoadedElementHashRef = useRef<string>("");
  const hasSceneRef = useRef(false);
  const currentSceneRef = useRef<SceneState>({ elements: [], appState: DEFAULT_APP_STATE, files: {} });
  // The board on disk this tab's scene is based on: sent as If-Match on every save.
  // null hash = the board doesn't exist yet (sent as If-None-Match: *).
  const baseHashRef = useRef<string | null>(null);
  const baseElementsRef = useRef<readonly ExcalidrawElement[]>([]);
  // True when the last save was merged by the server and the merged board is already shown.
  const lastSaveMergedRef = useRef(false);
  // Loads, saves and conversions run one at a time so a reload can't interleave with a save.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Who this tab saves as: `human:<name>#<tabId>` (X-Xcld-Author-Name / X-Xcld-Tab).
  const [initialIdentity] = useState<Identity>(() => ({ name: FALLBACK_NAME, tabId: readTabId(browserStorage("sessionStorage")) }));
  const identityRef = useRef<Identity>(initialIdentity);
  const configuredNameRef = useRef<string | null>(null);
  const [authorName, setAuthorName] = useState<string | null>(null);
  const [bannerItems, setBannerItems] = useState<BannerItem[]>([]);
  // When this tab last changed an element: a save says how long ago (X-Xcld-Edit-Age), so the
  // server's "last writer" is the last one to edit, not the last save to arrive.
  const lastEditAtRef = useRef(0);
  // Per element id, the server's own copy and the version stamp of what the tab shows for it.
  const serverCopiesRef = useRef<ReturnType<typeof serverCopies>>(new Map());
  const sceneVersionRef = useRef(0);

  const reportMerge = useCallback((report: { author: string | null; applied?: MergeUnit[]; overwritten?: OverwrittenUnit[]; dropped?: OverwrittenUnit[] }) => {
    const items = mergeItems(report, identityRef.current);
    if (items.length) {
      setBannerItems((current) => addBannerItems(current, items));
    }
  }, []);

  const exclusive = useCallback(<T,>(task: () => Promise<T>) => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.catch(() => {});
    return run;
  }, []);

  // Excalidraw mutates element objects in place while editing, so the base is a copy.
  const setBase = useCallback((hash: string | null, elements: readonly ExcalidrawElement[]) => {
    baseHashRef.current = hash;
    baseElementsRef.current = structuredClone(elements);
  }, []);

  const setDeletedState = useCallback((value: boolean) => {
    deletedOnDiskRef.current = value;
    setDeletedOnDisk(value);
  }, []);

  const cancelPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
  }, []);

  const hasUnsavedEdits = useCallback(
    () => hasSceneRef.current && elementHash(currentSceneRef.current.elements) !== lastLoadedElementHashRef.current,
    [],
  );

  const markDeletedOnDisk = useCallback(() => {
    cancelPendingSave();
    setBase(null, []);
    setDeletedState(true);
    setStatus({ level: "warn", text: "This board was deleted on disk." });
  }, [cancelPendingSave, setBase, setDeletedState]);

  // `recenter` frames the drawing: on first load and when Mermaid brings in new content.
  // Live reloads from agent edits keep the user's current view.
  const applyScene = useCallback((scene: SceneFile, hash: string, recenter = false) => {
    hasSceneRef.current = true;
    lastLoadedHashRef.current = hash;
    lastLoadedElementHashRef.current = elementHash(scene.elements);
    applyingRemoteRef.current = true;
    currentSceneRef.current = {
      elements: scene.elements,
      appState: scene.appState ?? DEFAULT_APP_STATE,
      files: scene.files ?? {},
    };
    setInitialData((current) => current ?? { ...scene, scrollToContent: true });
    const api = apiRef.current;
    const files = Object.values(scene.files ?? {});
    if (api && files.length) {
      api.addFiles(files);
    }
    api?.updateScene({
      elements: scene.elements,
      appState: scene.appState as AppState,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (api && recenter) {
      const visible = scene.elements.filter((element) => !element.isDeleted);
      if (visible.length) {
        window.requestAnimationFrame(() => {
          api.setViewport({ target: visible, fit: "scale-down", animation: true });
        });
      }
    }
    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 0);
  }, []);

  const fetchRemote = useCallback(async (): Promise<RemoteBoard> => {
    const response = await fetch(boardApiPath("board", boardName));
    if (response.status === 404) {
      return { hash: null, text: null, scene: null };
    }
    if (!response.ok) {
      throw new Error(`Load failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    return { hash: etagHash(response), text, scene: sceneFromText(text) };
  }, [boardName]);

  // Offline fallback for a 409 (the server no longer knows this tab's base): merges this tab's
  // unsaved edits onto the board on disk, against the version the tab last loaded, and shows the
  // result. The board on disk becomes the base; the caller saves the merged scene.
  const reapplyOnto = useCallback((remote: RemoteBoard & { text: string; scene: SceneFile }) => {
    const local = currentSceneRef.current;
    const merged = reapplyUnsavedEdits({
      base: baseElementsRef.current,
      local: local.elements,
      remote: remote.scene.elements,
      author: authorKey(identityRef.current),
    });
    const scene: SceneFile = {
      ...remote.scene,
      elements: merged.elements as ExcalidrawElement[],
      files: { ...(remote.scene.files ?? {}), ...local.files },
    };
    applyScene(scene, textHash(remote.text));
    lastLoadedElementHashRef.current = elementHash(remote.scene.elements);
    serverCopiesRef.current = serverCopies(remote.scene.rawElements, remote.scene.elements);
    setBase(remote.hash, remote.scene.elements);
    reportMerge({ author: authorKey(identityRef.current), overwritten: merged.overwritten as OverwrittenUnit[] });
    return currentSceneRef.current;
  }, [applyScene, reportMerge, setBase]);

  // Saves with If-Match (or If-None-Match: * for a new board) as this tab's author. A save from
  // an older base is merged by the server (200, merged: true, the merged master in the body);
  // master becomes the new base, so an edit of this tab that lost is never sent again (it is in
  // version history only). A 409 means the server doesn't know the base: "rebase" re-applies
  // this tab's edits on the newer board and retries; "replace" (inbox conversions) just retries
  // on the new base.
  const saveScene = useCallback(
    async (
      input: SceneState,
      reason: string,
      { force = false, onStale = "rebase" }: { force?: boolean; onStale?: "rebase" | "replace" } = {},
    ) => {
      let scene = input;
      let reapplied = false;
      lastSaveMergedRef.current = false;
      for (let attempt = 0; ; attempt++) {
        // Exactly what this save carries. Excalidraw edits elements in place, so this is a copy:
        // edits made while the save is in flight are measured against it. Elements untouched
        // since the server sent them go out as the server wrote them (wireElements).
        const sent = structuredClone(scene.elements);
        const wire = wireElements(sent, serverCopiesRef.current) as ExcalidrawElement[];
        const text = persistedSceneText(wire, scene.appState, scene.files);
        const hash = textHash(text);
        if (!force && !reapplied && (hash === lastSavedHashRef.current || hash === lastLoadedHashRef.current)) {
          return hash;
        }
        const identity = identityRef.current;
        const headers: Record<string, string> = { "Content-Type": "application/json", ...identityHeaders(identity) };
        if (baseHashRef.current === null) {
          headers["If-None-Match"] = "*";
        } else {
          headers["If-Match"] = `"${baseHashRef.current}"`;
        }
        if (onStale === "rebase" && lastEditAtRef.current) {
          headers["X-Xcld-Edit-Age"] = String(Math.max(0, Date.now() - lastEditAtRef.current));
        }
        const response = await fetch(boardApiPath("board", boardName), { method: "PUT", headers, body: text });
        if (response.ok) {
          const saved = await response.json() as SaveAnswer;
          const version = saved.version ?? saved.hash ?? etagHash(response);
          if (saved.merged && saved.master) {
            // The server merged this save with changes made elsewhere: show the merged board.
            // An autosave keeps edits made in this tab since the save was sent; an inbox
            // conversion (which isn't on the canvas yet) just shows the merged board.
            const masterText = `${JSON.stringify(saved.master, null, 2)}\n`;
            const masterScene = sceneFromText(masterText);
            let dropped: OverwrittenUnit[] = [];
            let shownMaster = masterScene.elements;
            if (onStale === "replace") {
              applyScene(masterScene, textHash(masterText), true);
            } else {
              const local = currentSceneRef.current;
              const rebased = keepEditsSinceSave({
                sent,
                wire,
                masterRaw: masterScene.rawElements ?? [],
                master: masterScene.elements,
                local: local.elements,
              });
              dropped = rebased.dropped as OverwrittenUnit[];
              shownMaster = rebased.shownMaster as ExcalidrawElement[];
              applyScene({
                ...masterScene,
                elements: rebased.elements as ExcalidrawElement[],
                files: { ...(masterScene.files ?? {}), ...local.files },
              }, textHash(masterText));
              lastLoadedElementHashRef.current = elementHash(shownMaster);
            }
            serverCopiesRef.current = serverCopies(masterScene.rawElements, shownMaster);
            setBase(version, shownMaster);
            lastSaveMergedRef.current = true;
            lastSavedHashRef.current = textHash(masterText);
            reportMerge({ author: authorKey(identity), applied: saved.applied, overwritten: saved.overwritten, dropped });
            setStatus({ level: "ok", text: `${MERGED_TEXT}; saved ${boardName}.excalidraw` });
            return lastSavedHashRef.current;
          }
          serverCopiesRef.current = serverCopies(wire, sent);
          setBase(version, sent);
          lastSavedHashRef.current = hash;
          lastLoadedHashRef.current = hash;
          lastLoadedElementHashRef.current = elementHash(sent);
          setStatus(reapplied
            ? { level: "ok", text: `${REAPPLIED_TEXT}; saved ${boardName}.excalidraw` }
            : { level: "ok", text: `Saved ${boardName}.excalidraw (${reason})` });
          return hash;
        }
        if (response.status !== 409) {
          throw new Error(`Save failed: HTTP ${response.status}`);
        }
        // The server needs a newer page (a build upgrade): retrying can't help.
        const conflict = await response.clone().json().catch(() => null) as { error?: string; message?: string } | null;
        if (conflict?.error === "reload-required") {
          throw new Error(conflict.message ?? "Reload the page to keep editing.");
        }
        if (attempt >= MAX_STALE_RETRIES) {
          throw new Error(`Save failed: the board kept changing elsewhere (${MAX_STALE_RETRIES} retries). Your edits are still in this tab; edit again to retry.`);
        }
        const remote = await fetchRemote();
        if (!remote.scene || !remote.text) {
          if (onStale === "rebase" && !force) {
            markDeletedOnDisk();
            return hash;
          }
          setBase(null, []);
          continue;
        }
        if (onStale === "replace") {
          setBase(remote.hash, remote.scene.elements);
          continue;
        }
        scene = reapplyOnto({ ...remote, text: remote.text, scene: remote.scene });
        reapplied = true;
      }
    },
    [applyScene, boardName, fetchRemote, markDeletedOnDisk, reapplyOnto, reportMerge, setBase],
  );
  const convertViewInbox = useCallback(async () => {
    const response = await fetch(boardApiPath("view", boardName));
    if (!response.ok) {
      return false;
    }

    const view = await response.json() as { type?: string; elements?: unknown[] };
    if (view.type !== "xcld-view") {
      throw new Error("View inbox is not an xcld-view file.");
    }
    const scene = sceneFromViewInbox(view);
    const hash = await saveScene(
      { elements: scene.elements, appState: scene.appState ?? {}, files: scene.files ?? {} },
      "converted view inbox",
      { onStale: "replace" },
    );
    if (!lastSaveMergedRef.current) {
      applyScene(scene, hash, true);
    }
    return true;
  }, [applyScene, boardName, saveScene]);

  // Mermaid writes the server couldn't apply node by node (a board without that source's shapes,
  // a non-flowchart): this tab lays each one out in memory with the real converter and posts the
  // shapes back. The server places them as a group clear of the drawing and merges them as the
  // agent that wrote the Mermaid, at its write time; nothing on the board is replaced (only an
  // empty board keeps the converter's coordinates). Returns true when a write landed.
  const convertPendingMermaid = useCallback(async () => {
    const response = await fetch(`${boardApiPath("mermaid", boardName)}?pending`);
    if (!response.ok) {
      return false;
    }
    const { pending = [] } = await response.json() as { pending?: { id: string; hash: string; mermaid: string; author: string }[] };
    let landed = false;
    for (const item of pending) {
      const parsed = await parseMermaidToExcalidraw(item.mermaid, {
        startOnLoad: false,
        flowchart: { curve: "linear" },
        themeVariables: { fontSize: "20px" },
      });
      const skeleton = Array.isArray(parsed) ? parsed : parsed.elements;
      // When mermaid-to-excalidraw can't parse a diagram into shapes, it falls back to one
      // image whose data is in `files`.
      const parsedFiles = (Array.isArray(parsed) ? {} : parsed.files ?? {}) as BinaryFiles;
      const isImageFallback = skeleton.length > 0 && skeleton.every((element) => element.type === "image");
      const elements = stampMermaidHash(convertToExcalidrawElements(disambiguateDuplicateElementIds(skeleton), {
        regenerateIds: false,
      }), item.hash);
      const answer = await fetch(`${boardApiPath("mermaid", boardName)}?layout=${encodeURIComponent(item.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: item.hash, elements, files: parsedFiles }),
      });
      // 409: another tab (or the server's own layout) got there first.
      const result = await answer.json().catch(() => null) as { placement?: string } | null;
      if (answer.ok) {
        landed = true;
        setStatus(isImageFallback
          ? { level: "warn", text: "Mermaid came in as a picture, not editable shapes (unsupported syntax; see the browser console)." }
          : { level: "ok", text: `Laid out Mermaid from ${item.author.replace(/#.*$/, "")} on ${boardName}${result?.placement && result.placement !== "keep" ? ` (${result.placement} the drawing)` : ""}` });
      } else if (answer.status !== 409) {
        throw new Error(`Mermaid layout failed: HTTP ${answer.status}`);
      }
    }
    return landed;
  }, [boardName]);

  const loadBoard = useCallback(
    async (reason: string, { recenter = false }: { recenter?: boolean } = {}): Promise<void> => {
      try {
        const remote = await fetchRemote();
        if (!remote.scene || !remote.text) {
          setBase(null, []);
          if (await convertViewInbox()) {
            return;
          }
          if (await convertPendingMermaid()) {
            return loadBoard("converted Mermaid", { recenter: true });
          }
          const scene: SceneFile = {
            type: "excalidraw",
            version: 2,
            source: "local-empty-board",
            elements: [],
            appState: DEFAULT_APP_STATE,
            files: {},
          };
          applyScene(scene, sceneHash(scene));
          setStatus({
            level: "warn",
            text: `Started empty ${boardName}.excalidraw; first edit will save it.`,
          });
          return;
        }

        const hash = textHash(remote.text);
        setDeletedState(false);
        if (hash === lastSavedHashRef.current || hash === lastLoadedHashRef.current) {
          if (hash === lastLoadedHashRef.current) {
            setBase(remote.hash, remote.scene.elements);
          }
          return;
        }
        if (remote.hash !== null && remote.hash === baseHashRef.current) {
          return;
        }
        if (!hasLiveElements(remote.scene.elements)) {
          const previousBase = { hash: baseHashRef.current, elements: baseElementsRef.current };
          setBase(remote.hash, remote.scene.elements);
          if (await convertViewInbox()) {
            return;
          }
          if (await convertPendingMermaid()) {
            return loadBoard("converted Mermaid", { recenter: true });
          }
          setBase(previousBase.hash, previousBase.elements);
        }
        // Save before reload: unsaved edits in this tab (e.g. the debounced autosave hasn't fired
        // yet) go to the server first, with the base they started from. The server merges them
        // with the newer board, and saveScene shows the merged board it answers with.
        if (hasUnsavedEdits()) {
          cancelPendingSave();
          await saveScene(currentSceneRef.current, "saved before reload");
          return;
        }
        applyScene(remote.scene, hash, recenter);
        serverCopiesRef.current = serverCopies(remote.scene.rawElements, remote.scene.elements);
        setBase(remote.hash, remote.scene.elements);
        setStatus({ level: "ok", text: `Loaded ${boardName}.excalidraw (${reason})` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ level: "error", text: message });
      }
    },
    [applyScene, boardName, cancelPendingSave, convertPendingMermaid, convertViewInbox, fetchRemote, hasUnsavedEdits, saveScene, setBase, setDeletedState],
  );

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus({ level: "error", text: message });
  }, []);

  // Reads the latest canvas when the timer fires, not the scene that scheduled it.
  const scheduleSave = useCallback(() => {
    if (applyingRemoteRef.current || deletedOnDiskRef.current) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      void exclusive(async () => {
        const scene = currentSceneRef.current;
        if (deletedOnDiskRef.current || elementHash(scene.elements) === lastLoadedElementHashRef.current) {
          return;
        }
        await saveScene(scene, "browser edit");
      }).catch(reportError);
    }, SAVE_DEBOUNCE_MS);
  }, [exclusive, reportError, saveScene]);

  const restoreFromThisTab = useCallback(() => exclusive(async () => {
    await saveScene(currentSceneRef.current, "restored from this tab", { force: true });
    setDeletedState(false);
  }).catch(reportError), [exclusive, reportError, saveScene, setDeletedState]);

  const applyAuthorName = useCallback((name: string) => {
    identityRef.current = { ...identityRef.current, name };
    setAuthorName(name);
  }, []);

  // The default name is XCLD_AUTHOR_NAME (GET /api/config); a rename in this browser wins.
  const resolveIdentity = useCallback(async () => {
    let configured: string | null = null;
    try {
      const response = await fetch("/api/config");
      if (response.ok) {
        configured = ((await response.json()) as { authorName?: string | null }).authorName ?? null;
      }
    } catch {}
    configuredNameRef.current = configured;
    applyAuthorName(resolveAuthorName({ stored: readStoredName(browserStorage("localStorage")), configured }));
  }, [applyAuthorName]);

  // Remembered per browser, so every tab of this person shows (and saves as) the same name.
  const renameAuthor = useCallback((raw: string) => {
    if (raw.trim() === identityRef.current.name) {
      return;
    }
    const stored = storeName(browserStorage("localStorage"), raw);
    applyAuthorName(resolveAuthorName({ stored, configured: configuredNameRef.current }));
  }, [applyAuthorName]);

  // Ctrl+S / Cmd+S: save now, then close this tab's open history entry (one restore point).
  const saveCheckpoint = useCallback(() => exclusive(async () => {
    if (deletedOnDiskRef.current) {
      return;
    }
    cancelPendingSave();
    if (hasUnsavedEdits()) {
      await saveScene(currentSceneRef.current, "Ctrl+S");
    }
    if (baseHashRef.current === null) {
      setStatus({ level: "warn", text: "Nothing to checkpoint: the board isn't saved yet" });
      return;
    }
    const response = await fetch(`${boardApiPath("board", boardName)}/checkpoint`, {
      method: "POST",
      headers: identityHeaders(identityRef.current),
    });
    if (!response.ok) {
      throw new Error(`Checkpoint failed: HTTP ${response.status}`);
    }
    const result = await response.json() as { closed?: boolean };
    setStatus(result.closed
      ? { level: "ok", text: "Saved checkpoint" }
      : { level: "ok", text: "No changes since the last checkpoint" });
  }).catch(reportError), [boardName, cancelPendingSave, exclusive, hasUnsavedEdits, reportError, saveScene]);

  useEffect(() => {
    // Capture phase, so Excalidraw's own Ctrl+S ("Save to…", a download) never sees it.
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopImmediatePropagation();
        void saveCheckpoint();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [saveCheckpoint]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === NAME_STORAGE_KEY || event.key === null) {
        applyAuthorName(resolveAuthorName({ stored: event.key === null ? null : event.newValue, configured: configuredNameRef.current }));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyAuthorName]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return;
    }
    const channel = new BroadcastChannel(TAB_CHANNEL);
    const stop = guardTabId({
      channel,
      getTabId: () => identityRef.current.tabId,
      instance: newTabId(),
      onTaken: () => {
        identityRef.current = { ...identityRef.current, tabId: replaceTabId(browserStorage("sessionStorage")) };
      },
    });
    return () => {
      stop();
      channel.close();
    };
  }, []);

  useEffect(() => {
    void exclusive(async () => {
      await resolveIdentity();
      await loadBoard("initial");
      // Mermaid written while no tab was open, on a board that already has a drawing.
      if (hasSceneRef.current && await convertPendingMermaid()) {
        await loadBoard("converted Mermaid");
      }
    }).catch(reportError);
  }, [convertPendingMermaid, exclusive, loadBoard, reportError, resolveIdentity]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("board", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          name?: string;
          kind?: string;
        };
        if (data.name !== boardName) {
          return;
        }
        if (data.kind === "deleted") {
          void exclusive(async () => markDeletedOnDisk());
          return;
        }
        if (data.kind === "mermaid") {
          void exclusive(convertPendingMermaid).catch(reportError);
          return;
        }
        if (data.kind === "view") {
          void exclusive(convertViewInbox).catch(reportError);
          return;
        }
        void exclusive(() => loadBoard("file change"));
      } catch (error) {
        reportError(error);
      }
    });
    // After every commit. Another writer's merge goes on the banner; if master moved, the tab
    // saves its pending edits first and then shows the merged board (loadBoard). A write that
    // lost every change leaves master as it is: banner only. This tab's own saves were already
    // reported from their answer.
    events.addEventListener("merged", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as MergedEvent;
        if (data.name !== boardName || data.author === authorKey(identityRef.current)) {
          return;
        }
        reportMerge({ author: data.author ?? null, applied: data.applied, overwritten: data.overwritten });
        if (data.version && data.version !== baseHashRef.current) {
          void exclusive(() => loadBoard("merged"));
        }
      } catch (error) {
        reportError(error);
      }
    });
    events.onerror = () => {
      setStatus({ level: "warn", text: "SSE disconnected; retrying..." });
    };
    return () => events.close();
  }, [boardName, convertPendingMermaid, convertViewInbox, exclusive, loadBoard, markDeletedOnDisk, reportError, reportMerge]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <a className="all-boards-link" href={window.location.pathname}>← All boards</a>
          <strong>Local Excalidraw workspace</strong>
          <span className="board-name">boards/{boardName}.excalidraw</span>
        </div>
        {deletedOnDisk ? (
          <div className="deleted-board-banner">
            <span>This board was deleted on disk.</span>
            <button type="button" onClick={restoreFromThisTab}>Restore from this tab</button>
            <button type="button" onClick={() => window.location.assign(window.location.pathname)}>Close</button>
          </div>
        ) : (
          <div className={`status ${status.level}`}>{status.text}</div>
        )}
      </header>
      <section className="canvas-wrap">
        {initialData ? (
          <Excalidraw
            onExcalidrawAPI={(api: ExcalidrawImperativeAPI | null) => {
              apiRef.current = api;
            }}
            initialData={initialData}
            onChange={(elements, appState, files) => {
              currentSceneRef.current = { elements, appState, files: files ?? {} };
              const version = sceneVersion(elements);
              if (version !== sceneVersionRef.current) {
                sceneVersionRef.current = version;
                if (!applyingRemoteRef.current) {
                  lastEditAtRef.current = Date.now();
                }
              }
              scheduleSave();
            }}
          />
        ) : (
          <div className="empty-state">Waiting for board data...</div>
        )}
        {bannerItems.length ? <MergeBanner items={bannerItems} onDismiss={() => setBannerItems([])} /> : null}
        {authorName !== null ? <AuthorOverlay name={authorName} onRename={renameAuthor} /> : null}
      </section>
    </main>
  );
};

export const App = () => {
  const { boardName, invalidBoardName } = useMemo(readBoardParam, []);
  if (!boardName) {
    return <BoardBrowser invalidBoardName={invalidBoardName} />;
  }
  return <BoardView boardName={boardName} />;
};
