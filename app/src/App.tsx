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
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateBoardPath } from "../../tools/board-path.mjs";
import { mermaidSourceHash, stampMermaidHash } from "../../tools/mermaid-hash.mjs";
import { disambiguateDuplicateElementIds } from "./ids.mjs";
import { reconcileElements } from "./reconcile.mjs";

type SceneFile = {
  type: "excalidraw";
  version: number;
  source?: string;
  elements: readonly ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
  scrollToContent?: boolean;
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

  const markDeletedOnDisk = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    setBase(null, []);
    setDeletedState(true);
    setStatus({ level: "warn", text: "This board was deleted on disk." });
  }, [setBase, setDeletedState]);

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

  // Re-applies this tab's unsaved edits on top of the board on disk and shows the result.
  // The board on disk becomes the base; the caller saves the merged scene.
  const rebaseOnto = useCallback((remote: RemoteBoard & { text: string; scene: SceneFile }) => {
    const merged = reconcileElements({
      base: baseElementsRef.current,
      local: currentSceneRef.current.elements,
      remote: remote.scene.elements,
    });
    const scene: SceneFile = {
      ...remote.scene,
      elements: restoreElements(merged, null),
      files: { ...(remote.scene.files ?? {}), ...currentSceneRef.current.files },
    };
    applyScene(scene, textHash(remote.text));
    lastLoadedElementHashRef.current = elementHash(remote.scene.elements);
    setBase(remote.hash, remote.scene.elements);
    return currentSceneRef.current;
  }, [applyScene, setBase]);

  // Saves with If-Match (or If-None-Match: * for a new board). A save from an older base is
  // merged by the server (200, merged: true, the merged master in the body). A 409 means the
  // server doesn't know the base: "rebase" re-applies this tab's edits on the newer board and
  // retries; "replace" (inbox conversions) just retries on the new base.
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
        const text = persistedSceneText(scene.elements, scene.appState, scene.files);
        const hash = textHash(text);
        if (!force && !reapplied && (hash === lastSavedHashRef.current || hash === lastLoadedHashRef.current)) {
          return hash;
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (baseHashRef.current === null) {
          headers["If-None-Match"] = "*";
        } else {
          headers["If-Match"] = `"${baseHashRef.current}"`;
        }
        const response = await fetch(boardApiPath("board", boardName), { method: "PUT", headers, body: text });
        if (response.ok) {
          const saved = await response.json() as { hash?: string; merged?: boolean; master?: SceneFile };
          if (saved.merged && saved.master) {
            // The server merged this save with changes made elsewhere: show the merged board.
            // An autosave keeps edits made in this tab since the save was sent; an inbox
            // conversion (which isn't on the canvas yet) just shows the merged board.
            const masterHash = saved.hash ?? etagHash(response);
            const masterText = `${JSON.stringify(saved.master, null, 2)}\n`;
            const masterScene = sceneFromText(masterText);
            if (onStale === "replace") {
              applyScene(masterScene, textHash(masterText), true);
              setBase(masterHash, masterScene.elements);
            } else {
              setBase(masterHash, scene.elements);
              rebaseOnto({ hash: masterHash, text: masterText, scene: masterScene });
            }
            lastSaveMergedRef.current = true;
            lastSavedHashRef.current = textHash(masterText);
            setStatus({ level: "ok", text: `${MERGED_TEXT}; saved ${boardName}.excalidraw` });
            return lastSavedHashRef.current;
          }
          setBase(saved.hash ?? etagHash(response), scene.elements);
          lastSavedHashRef.current = hash;
          lastLoadedHashRef.current = hash;
          lastLoadedElementHashRef.current = elementHash(scene.elements);
          setStatus(reapplied
            ? { level: "ok", text: `${REAPPLIED_TEXT}; saved ${boardName}.excalidraw` }
            : { level: "ok", text: `Saved ${boardName}.excalidraw (${reason})` });
          return hash;
        }
        if (response.status !== 409) {
          throw new Error(`Save failed: HTTP ${response.status}`);
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
        scene = rebaseOnto({ ...remote, text: remote.text, scene: remote.scene });
        reapplied = true;
      }
    },
    [boardName, fetchRemote, markDeletedOnDisk, rebaseOnto, setBase],
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

  const convertMermaidInbox = useCallback(async () => {
    const response = await fetch(boardApiPath("mermaid", boardName));
    // Already applied to the board by the server: converting it again would replace the board.
    if (!response.ok || response.headers.get("X-Xcld-Mermaid-Applied")) {
      return false;
    }

    const definition = await response.text();
    const parsed = await parseMermaidToExcalidraw(definition, {
      startOnLoad: false,
      flowchart: { curve: "linear" },
      themeVariables: { fontSize: "20px" },
    });
    const skeleton = Array.isArray(parsed) ? parsed : parsed.elements;
    // When mermaid-to-excalidraw can't parse a diagram into shapes, it falls back to one
    // image whose data is in `files`.
    const parsedFiles = (Array.isArray(parsed) ? {} : parsed.files ?? {}) as BinaryFiles;
    const isImageFallback = skeleton.length > 0 && skeleton.every((element) => element.type === "image");
    const stableSkeleton = disambiguateDuplicateElementIds(skeleton);
    const elements = stampMermaidHash(convertToExcalidrawElements(stableSkeleton, {
      regenerateIds: false,
    }), mermaidSourceHash(definition)) as ExcalidrawElement[];
    const scene: SceneFile = {
      type: "excalidraw",
      version: 2,
      source: "local-mermaid-inbox",
      elements,
      appState: DEFAULT_APP_STATE,
      files: parsedFiles,
    };
    const hash = await saveScene(
      { elements: scene.elements, appState: scene.appState ?? {}, files: scene.files ?? {} },
      "converted Mermaid inbox",
      { onStale: "replace" },
    );
    if (!lastSaveMergedRef.current) {
      applyScene(scene, hash, true);
    }
    if (isImageFallback) {
      setStatus({
        level: "warn",
        text: "Mermaid came in as a picture, not editable shapes (unsupported syntax; see the browser console).",
      });
    }
    return true;
  }, [applyScene, boardName, saveScene]);

  const loadBoard = useCallback(
    async (reason: string) => {
      try {
        const remote = await fetchRemote();
        if (!remote.scene || !remote.text) {
          setBase(null, []);
          const converted = await convertViewInbox() || await convertMermaidInbox();
          if (!converted) {
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
          }
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
        if (!hasLiveElements(remote.scene.elements)) {
          const previousBase = { hash: baseHashRef.current, elements: baseElementsRef.current };
          setBase(remote.hash, remote.scene.elements);
          if (await convertViewInbox() || await convertMermaidInbox()) {
            return;
          }
          setBase(previousBase.hash, previousBase.elements);
        }
        // Unsaved edits in this tab (e.g. the debounced autosave hasn't fired yet): merge
        // them onto the new board instead of dropping them, then save the result.
        const unsaved = hasSceneRef.current
          && elementHash(currentSceneRef.current.elements) !== lastLoadedElementHashRef.current;
        if (unsaved) {
          await saveScene(rebaseOnto({ ...remote, text: remote.text, scene: remote.scene }), "re-applied edits");
          setStatus({ level: "ok", text: `${REAPPLIED_TEXT}.` });
          return;
        }
        applyScene(remote.scene, hash);
        setBase(remote.hash, remote.scene.elements);
        setStatus({ level: "ok", text: `Loaded ${boardName}.excalidraw (${reason})` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ level: "error", text: message });
      }
    },
    [applyScene, boardName, convertMermaidInbox, convertViewInbox, fetchRemote, rebaseOnto, saveScene, setBase, setDeletedState],
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

  useEffect(() => {
    void exclusive(() => loadBoard("initial"));
  }, [exclusive, loadBoard]);

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
          void exclusive(convertMermaidInbox).catch(reportError);
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
    events.onerror = () => {
      setStatus({ level: "warn", text: "SSE disconnected; retrying..." });
    };
    return () => events.close();
  }, [boardName, convertMermaidInbox, convertViewInbox, exclusive, loadBoard, markDeletedOnDisk, reportError]);

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
              scheduleSave();
            }}
          />
        ) : (
          <div className="empty-state">Waiting for board data...</div>
        )}
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
