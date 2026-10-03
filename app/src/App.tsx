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
import { disambiguateDuplicateElementIds } from "./ids.mjs";

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
  mermaidPending: boolean;
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

const boardApiPath = (prefix: "board" | "mermaid", boardName: string) => `/api/${prefix}/${encodeURIComponent(boardName)}`;

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
                    {board.mermaidPending ? <span className="badge warn">Mermaid waiting to convert</span> : null}
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
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const saveTimerRef = useRef<number | undefined>();
  const applyingRemoteRef = useRef(false);
  const lastLoadedHashRef = useRef<string>("");
  const lastSavedHashRef = useRef<string>("");

  // `recenter` frames the drawing: on first load and when Mermaid brings in new content.
  // Live reloads from agent edits keep the user's current view.
  const applyScene = useCallback((scene: SceneFile, hash: string, recenter = false) => {
    lastLoadedHashRef.current = hash;
    applyingRemoteRef.current = true;
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

  const saveText = useCallback(
    async (text: string, reason: string) => {
      const persistedText = text.endsWith("\n") ? text : `${text}\n`;
      const hash = textHash(persistedText);
      if (hash === lastSavedHashRef.current) {
        return hash;
      }

      const response = await fetch(boardApiPath("board", boardName), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: persistedText,
      });
      if (!response.ok) {
        throw new Error(`Save failed: HTTP ${response.status}`);
      }
      lastSavedHashRef.current = hash;
      lastLoadedHashRef.current = hash;
      setStatus({ level: "ok", text: `Saved ${boardName}.excalidraw (${reason})` });
      return hash;
    },
    [boardName],
  );

  const convertMermaidInbox = useCallback(async () => {
    const response = await fetch(boardApiPath("mermaid", boardName));
    if (!response.ok) {
      return false;
    }

    const definition = await response.text();
    const parsed = await parseMermaidToExcalidraw(definition, {
      startOnLoad: false,
      flowchart: { curve: "linear" },
      themeVariables: { fontSize: "20px" },
    });
    const skeleton = Array.isArray(parsed) ? parsed : parsed.elements;
    // When mermaid-to-excalidraw can't parse a diagram into shapes (e.g. flowchart
    // subgraphs at the pinned SHA), it falls back to one image whose data is in `files`.
    const parsedFiles = (Array.isArray(parsed) ? {} : parsed.files ?? {}) as BinaryFiles;
    const isImageFallback = skeleton.length > 0 && skeleton.every((element) => element.type === "image");
    const stableSkeleton = disambiguateDuplicateElementIds(skeleton);
    const elements = convertToExcalidrawElements(stableSkeleton, {
      regenerateIds: false,
    }) as ExcalidrawElement[];
    const scene: SceneFile = {
      type: "excalidraw",
      version: 2,
      source: "local-mermaid-inbox",
      elements,
      appState: DEFAULT_APP_STATE,
      files: parsedFiles,
    };
    const text = sceneToText(scene.elements, scene.appState ?? {}, scene.files ?? {});
    const hash = await saveText(text, "converted Mermaid inbox");
    applyScene(scene, hash, true);
    if (isImageFallback) {
      setStatus({
        level: "warn",
        text: "Mermaid came in as a picture, not editable shapes (unsupported syntax such as subgraphs; see the browser console).",
      });
    }
    return true;
  }, [applyScene, boardName, saveText]);

  const loadBoard = useCallback(
    async (reason: string) => {
      try {
        const response = await fetch(boardApiPath("board", boardName));
        if (response.status === 404) {
          const converted = await convertMermaidInbox();
          if (!converted) {
            const scene: SceneFile = {
              type: "excalidraw",
              version: 2,
              source: "local-empty-board",
              elements: [],
              appState: DEFAULT_APP_STATE,
              files: {},
            };
            applyScene(scene, "empty");
            setStatus({
              level: "warn",
              text: `Started empty ${boardName}.excalidraw; first edit will save it.`,
            });
          }
          return;
        }
        if (!response.ok) {
          throw new Error(`Load failed: HTTP ${response.status}`);
        }

        const text = await response.text();
        const hash = textHash(text);
        if (hash === lastSavedHashRef.current || hash === lastLoadedHashRef.current) {
          return;
        }
        const scene = sceneFromText(text);
        applyScene(scene, hash);
        setStatus({ level: "ok", text: `Loaded ${boardName}.excalidraw (${reason})` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ level: "error", text: message });
      }
    },
    [applyScene, boardName, convertMermaidInbox],
  );

  const scheduleSave = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (applyingRemoteRef.current) {
        return;
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(async () => {
        try {
          const text = sceneToText(elements, appState, files ?? {});
          await saveText(text, "browser edit");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setStatus({ level: "error", text: message });
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [saveText],
  );

  useEffect(() => {
    void loadBoard("initial");
  }, [loadBoard]);

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
        if (data.kind === "mermaid") {
          void convertMermaidInbox();
          return;
        }
        void loadBoard("file change");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ level: "error", text: message });
      }
    });
    events.onerror = () => {
      setStatus({ level: "warn", text: "SSE disconnected; retrying..." });
    };
    return () => events.close();
  }, [boardName, convertMermaidInbox, loadBoard]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <a className="all-boards-link" href={window.location.pathname}>← All boards</a>
          <strong>Local Excalidraw workspace</strong>
          <span className="board-name">boards/{boardName}.excalidraw</span>
        </div>
        <div className={`status ${status.level}`}>{status.text}</div>
      </header>
      <section className="canvas-wrap">
        {initialData ? (
          <Excalidraw
            onExcalidrawAPI={(api: ExcalidrawImperativeAPI | null) => {
              apiRef.current = api;
            }}
            initialData={initialData}
            onChange={(elements, appState, files) => {
              scheduleSave(elements, appState, files ?? {});
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
