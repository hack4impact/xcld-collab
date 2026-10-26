#!/usr/bin/env python3
"""Layout helpers for xcld-collab boards: widen and re-wrap labels, row layout, align under.

Stdlib only; nothing here talks to the server. Each command reads a board's JSON (an
.excalidraw scene, a bare element array, or the `{ board, version, scene }` that `xcld read`
prints), changes element geometry, and writes the whole board back as an .excalidraw scene.
Post the result with `xcld write <board> <file> --base <version>` (see README.md).

Usage:
  python -I xcld_layout.py widen <spec.json> <in.json> <out.json>
  python -I xcld_layout.py rows  <spec.json> <in.json> <out.json>
  python -I xcld_layout.py align <in.json> <out.json> <frame id> <node>=<partner> [...]

  widen   Set the width of chosen shapes and re-wrap their labels from `originalText`.
  rows    Lay frames (subgraph containers) and free nodes out in rows from a spec, re-route
          bound arrows as straight lines, and check the result.
  align   Move each node of a frame to its partner's x, refit the frame around them, draw
          straight vertical connectors between the pairs, and check the result.

Checks (rows, align): node/node overlap, frame/frame overlap, a node on a frame it is not a
member of, a member sticking out of its frame, and an arrow crossing a node.

Exit codes: 0 OK; 1 layout problems found (the output is still written, for inspection);
2 bad input.
"""
import argparse
import json
import math
import sys

# Server conventions (tools/mermaid-apply.mjs).
FONT_SIZE = 20
LINE_HEIGHT = 1.25
BOUND_TEXT_PADDING = 5
ARROW_GAP = 4
WRAP_TOLERANCE = 1.05
SHAPES = ("rectangle", "diamond", "ellipse")

# Defaults, overridable in the spec.
WIDEN_PAD_X = 24      # total horizontal room left beside a label
WIDEN_PAD_Y = 30      # room above and below a label
ROWS_ORIGIN = (40.0, 40.0)
ROWS_GAP = 50         # between items in a row, and between nodes in a frame
ROWS_ROW_GAP = 90     # between rows
ROWS_PAD = 30         # frame padding left, right and bottom
ROWS_PAD_TOP = 50     # frame padding on top (room for the title)
ALIGN_PAD = 30
NODE_CLEARANCE = 10   # nodes closer than this count as overlapping


class InputError(Exception):
    pass


# ---------------------------------------------------------------------------
# Text width: the server's per-character estimate for Excalifont at 20px.
# ---------------------------------------------------------------------------
def char_width(ch):
    if ch == " ":
        return 0.35
    if ch in "il.,:;|!'`":
        return 0.3
    if ch in "fjrt()[]/\\-":
        return 0.43
    if ch in "mwMW@%":
        return 0.85
    if "A" <= ch <= "Z":
        return 0.64
    if "0" <= ch <= "9":
        return 0.56
    return 0.54


def text_width(line, font_size=FONT_SIZE):
    return sum(char_width(ch) for ch in line) * font_size


def wrap_text(text, max_width, font_size=FONT_SIZE):
    """Greedy word wrap, the same rule the server uses when it lays out bound text."""
    lines = []
    for paragraph in str(text).split("\n"):
        current = ""
        for word in paragraph.split(" "):
            candidate = f"{current} {word}" if current else word
            if not current or text_width(candidate, font_size) <= max_width * WRAP_TOLERANCE:
                current = candidate
                continue
            lines.append(current)
            current = word
        lines.append(current)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Board access
# ---------------------------------------------------------------------------
def load(path):
    """Read a scene, a bare element array, or `xcld read` output. Returns (scene, version)."""
    with open(path, "rb") as handle:
        raw = handle.read()
    # PowerShell 5.1 redirection (`> file`) writes UTF-16; accept it and a UTF-8 BOM.
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8-sig")
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as error:
        raise InputError(f"{path}: not JSON ({error})")
    version = None
    if isinstance(doc, dict) and "elements" not in doc and isinstance(doc.get("scene"), dict):
        version = doc.get("version")
        doc = doc["scene"]
    if isinstance(doc, list):
        doc = {"type": "excalidraw", "version": 2, "elements": doc}
    if not isinstance(doc, dict) or not isinstance(doc.get("elements"), list):
        raise InputError(f"{path}: expected an .excalidraw scene, an element array or `xcld read` output")
    return doc, version


def save(scene, path):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(scene, handle, ensure_ascii=False)


class Board:
    def __init__(self, scene):
        self.scene = scene
        self.live = {e["id"]: e for e in scene["elements"] if isinstance(e, dict) and "id" in e and not e.get("isDeleted")}
        # Bound text by container: the container's boundElements reference first, then any
        # live text that names the container (as the server's boundTextOf does).
        self.labels = {}
        for element in self.live.values():
            container = element.get("containerId")
            if element.get("type") == "text" and container in self.live:
                self.labels.setdefault(container, element)
        for element in self.live.values():
            for ref in element.get("boundElements") or []:
                text = self.live.get((ref or {}).get("id")) if (ref or {}).get("type") == "text" else None
                if text and text.get("containerId") == element["id"]:
                    self.labels[element["id"]] = text

    def get(self, element_id):
        element = self.live.get(element_id)
        if element is None:
            raise InputError(f"no live element with id {element_id!r}")
        return element

    def move(self, element_id, x, y):
        element = self.get(element_id)
        dx, dy = x - element["x"], y - element["y"]
        element["x"], element["y"] = x, y
        label = self.labels.get(element_id)
        if label:
            label["x"] += dx
            label["y"] += dy

    def shapes(self):
        return [e for e in self.live.values() if e.get("type") in SHAPES]

    def bound_arrows(self):
        for element in self.live.values():
            if element.get("type") != "arrow":
                continue
            start, end = arrow_ends(element)
            if start in self.live and end in self.live and start != end:
                yield element, start, end


def arrow_ends(arrow):
    return (arrow.get("startBinding") or {}).get("elementId"), (arrow.get("endBinding") or {}).get("elementId")


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def box(element):
    x, y = float(element["x"]), float(element["y"])
    w, h = float(element.get("width", 0)), float(element.get("height", 0))
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return x, y, x + w, y + h


def centre(element):
    x1, y1, x2, y2 = box(element)
    return (x1 + x2) / 2, (y1 + y2) / 2


def hits(a, b, pad=0.0):
    return not (a[2] + pad <= b[0] or b[2] + pad <= a[0] or a[3] + pad <= b[1] or b[3] + pad <= a[1])


def contains(outer, inner):
    return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def border_point(shape, toward):
    """Where a line from the shape's centre toward a point leaves the shape, plus the arrow gap."""
    x1, y1, x2, y2 = box(shape)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    half_w, half_h = max((x2 - x1) / 2, 0.5), max((y2 - y1) / 2, 0.5)
    if shape.get("type") == "ellipse":
        distance = 1 / math.sqrt(ux * ux / (half_w * half_w) + uy * uy / (half_h * half_h))
    elif shape.get("type") == "diamond":
        distance = 1 / (abs(ux) / half_w + abs(uy) / half_h)
    else:
        distance = min(half_w / abs(ux) if ux else math.inf, half_h / abs(uy) if uy else math.inf)
    return cx + ux * (distance + ARROW_GAP), cy + uy * (distance + ARROW_GAP)


def fixed_point(shape, point):
    x1, y1, x2, y2 = box(shape)

    def ratio(value):
        # Excalidraw stores a centred fixed point as 0.5001.
        return 0.5001 if abs(value - 0.5) < 0.0001 else value

    return [ratio((point[0] - x1) / ((x2 - x1) or 1)), ratio((point[1] - y1) / ((y2 - y1) or 1))]


def set_arrow(board, arrow, start, end):
    """Make a bound arrow a straight line from start to end and keep its bindings consistent."""
    arrow["x"], arrow["y"] = start
    arrow["points"] = [[0, 0], [end[0] - start[0], end[1] - start[1]]]
    arrow["width"], arrow["height"] = abs(end[0] - start[0]), abs(end[1] - start[1])
    for key, point in (("startBinding", start), ("endBinding", end)):
        binding = arrow[key]
        if "fixedPoint" in binding:
            binding["fixedPoint"] = fixed_point(board.get(binding["elementId"]), point)
        else:  # older binding format
            binding["focus"], binding["gap"] = 0, ARROW_GAP
    label = board.labels.get(arrow["id"])
    if label:
        label["x"] = (start[0] + end[0]) / 2 - label.get("width", 0) / 2
        label["y"] = (start[1] + end[1]) / 2 - label.get("height", 0) / 2


def reroute(board, scope=None):
    """Redraw bound arrows as straight lines between their shapes' borders.

    With a scope, only arrows with an end in it; the rest keep their routing exactly.
    """
    for arrow, start, end in board.bound_arrows():
        if scope is not None and start not in scope and end not in scope:
            continue
        s, t = board.get(start), board.get(end)
        set_arrow(board, arrow, border_point(s, centre(t)), border_point(t, centre(s)))


def polyline(arrow):
    return [(arrow["x"] + p[0], arrow["y"] + p[1]) for p in arrow.get("points") or [[0, 0]]]


def segment_enters(p, q, rect):
    """True if the segment p-q passes through the inside of rect (Liang-Barsky clipping)."""
    x1, y1, x2, y2 = rect[0] + 0.5, rect[1] + 0.5, rect[2] - 0.5, rect[3] - 0.5
    if x1 >= x2 or y1 >= y2:
        return False
    dx, dy = q[0] - p[0], q[1] - p[1]
    lo, hi = 0.0, 1.0
    for edge_p, edge_q in ((-dx, p[0] - x1), (dx, x2 - p[0]), (-dy, p[1] - y1), (dy, y2 - p[1])):
        if edge_p == 0:
            if edge_q < 0:
                return False
            continue
        t = edge_q / edge_p
        if edge_p < 0:
            lo = max(lo, t)
        else:
            hi = min(hi, t)
        if lo > hi:
            return False
    return hi - lo > 1e-9


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def find_problems(board, frames, moved, everything):
    """Overlap and crossing problems.

    frames: frame id -> its member node ids. Shapes not in `frames` count as nodes.
    everything: check every pair; otherwise only pairs with at least one element in `moved`.
    """
    problems = []
    shapes = board.shapes()
    ids = [s["id"] for s in shapes]
    boxes = {s["id"]: box(s) for s in shapes}
    members = {f: set(nodes) for f, nodes in frames.items()}

    def in_scope(*element_ids):
        return everything or any(e in moved for e in element_ids)

    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if not in_scope(a, b):
                continue
            a_frame, b_frame = a in frames, b in frames
            if a_frame and b_frame:
                if b in members[a] or a in members[b]:
                    continue  # nested frames
                if hits(boxes[a], boxes[b]):
                    problems.append(f"frame overlap {a} / {b}")
            elif a_frame or b_frame:
                frame, node = (a, b) if a_frame else (b, a)
                if node in members[frame]:
                    if not contains(boxes[frame], boxes[node]):
                        problems.append(f"{node} sticks out of its frame {frame}")
                elif hits(boxes[frame], boxes[node]):
                    problems.append(f"{node} sits on frame {frame} without being a member")
            elif hits(boxes[a], boxes[b], NODE_CLEARANCE):
                problems.append(f"node overlap {a} / {b}")

    nodes = [i for i in ids if i not in frames]
    for arrow, start, end in board.bound_arrows():
        if not in_scope(start, end):
            continue
        points = polyline(arrow)
        for node in nodes:
            if node in (start, end):
                continue
            if contains(boxes[node], box(board.get(start))) or contains(boxes[node], box(board.get(end))):
                continue  # encloses an end: a container the arrow has to leave, e.g. an unlisted frame
            if any(segment_enters(p, q, boxes[node]) for p, q in zip(points, points[1:])):
                problems.append(f"arrow {arrow['id']} crosses {node}")
    return problems


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def widen(board, spec):
    """Spec: {"widths": {"<id>" | "<prefix>:" | "<prefix>*": px}, "exclude": [...], "padX", "padY"}.

    Exact ids win over prefixes, a longer prefix over a shorter one. Prefix matches skip
    shapes whose label is top-aligned (subgraph containers); name those exactly to widen
    them. Only rectangles are widened. Returns (changed ids, notes).
    """
    widths = spec.get("widths")
    if not isinstance(widths, dict) or not widths:
        raise InputError('widen spec needs "widths": {"<id or prefix>": <px>, ...}')
    exclude = set(spec.get("exclude", []))
    pad_x = float(spec.get("padX", WIDEN_PAD_X))
    pad_y = float(spec.get("padY", WIDEN_PAD_Y))
    prefixes = sorted(
        ((key[:-1] if key.endswith("*") else key, w) for key, w in widths.items() if key.endswith((":", "*"))),
        key=lambda item: -len(item[0]),
    )
    notes = [f"{key}: not on the board" for key in widths if not key.endswith((":", "*")) and key not in board.live]
    changed = []
    for element_id, element in board.live.items():
        if element.get("type") not in SHAPES or element_id in exclude:
            continue
        exact = element_id in widths
        width = widths[element_id] if exact else next((w for p, w in prefixes if element_id.startswith(p)), None)
        if width is None:
            continue
        label = board.labels.get(element_id)
        if label is None:
            if exact:
                notes.append(f"{element_id}: no bound label, left alone")
            continue
        if not exact and label.get("verticalAlign") == "top":
            continue  # a subgraph container; relayout sizes those
        if element.get("type") != "rectangle":
            notes.append(f"{element_id}: {element['type']}, only rectangles are widened")
            continue
        font_size = float(label.get("fontSize", FONT_SIZE))
        line_height = float(label.get("lineHeight", LINE_HEIGHT))
        source = label.get("originalText") or label.get("text", "")
        text = wrap_text(source, float(width) - pad_x, font_size)
        lines = text.split("\n")
        text_w = max(text_width(line, font_size) for line in lines)
        text_h = len(lines) * font_size * line_height
        element["width"], element["height"] = float(width), text_h + 2 * pad_y
        label["text"] = text
        label["width"], label["height"] = text_w, text_h
        label["x"] = element["x"] + (float(width) - text_w) / 2
        label["y"] = element["y"] + pad_y
        changed.append(element_id)
    return changed, notes


def rows(board, spec):
    """Spec: {"rows": [[item, ...], ...], "partial": bool, "origin": [x, y], "gap", "rowGap", "pad", "padTop"}.

    Items: {"frame": id, "nodes": [id, ...]} lays the nodes left to right inside the frame and
    fits the frame around them; {"node": id, "under": id} places a free node, at the x of
    `under` if given. Rows stack top to bottom, items go left to right.
    Without "partial", every shape must be in the spec and every bound arrow is re-routed.
    With "partial": true, only listed shapes move and only arrows touching them are re-routed.
    Returns the list of problems.
    """
    if not isinstance(spec.get("rows"), list):
        raise InputError('rows spec needs "rows": [[item, ...], ...]')
    x0, y0 = (float(v) for v in spec.get("origin", ROWS_ORIGIN))
    gap = float(spec.get("gap", ROWS_GAP))
    row_gap = float(spec.get("rowGap", ROWS_ROW_GAP))
    pad = float(spec.get("pad", ROWS_PAD))
    pad_top = float(spec.get("padTop", ROWS_PAD_TOP))
    partial = bool(spec.get("partial"))

    frames, placed, seen = {}, [], set()

    def claim(element_id):
        board.get(element_id)
        if element_id in seen:
            raise InputError(f"{element_id!r} appears twice in the spec")
        seen.add(element_id)

    y = y0
    for row in spec["rows"]:
        x, row_h = x0, 0.0
        for item in row:
            if "frame" in item:
                frame_id, nodes = item["frame"], list(item.get("nodes", []))
                claim(frame_id)
                frame = board.get(frame_id)
                label = board.labels.get(frame_id)
                nx, height = x + pad, 0.0
                for node in nodes:
                    claim(node)
                    board.move(node, nx, y + pad_top)
                    nx += board.get(node)["width"] + gap
                    height = max(height, board.get(node)["height"])
                if nodes:
                    content_w = nx - gap + pad - x
                    width = max(content_w, (label.get("width", 0) + 2 * pad) if label else 0)
                    if width > content_w:  # a title wider than the members: centre them
                        for node in nodes:
                            board.move(node, board.get(node)["x"] + (width - content_w) / 2, board.get(node)["y"])
                    frame_h = pad_top + height + pad
                else:
                    width, frame_h = frame["width"], frame["height"]
                frame["x"], frame["y"], frame["width"], frame["height"] = x, y, width, frame_h
                if label:
                    label["x"] = x + (width - label.get("width", 0)) / 2
                    label["y"] = y + BOUND_TEXT_PADDING
                frames[frame_id] = nodes
                placed.extend(nodes)
                x += width + gap
                row_h = max(row_h, frame_h)
            elif "node" in item:
                node = item["node"]
                claim(node)
                nx = board.get(item["under"])["x"] if "under" in item else x
                board.move(node, nx, y)
                placed.append(node)
                x = max(x, nx + board.get(node)["width"] + gap)
                row_h = max(row_h, board.get(node)["height"])
            else:
                raise InputError(f"spec item needs \"frame\" or \"node\": {item!r}")
        if row:
            y += row_h + row_gap

    moved = set(placed) | set(frames)
    reroute(board, moved if partial else None)
    problems = []
    if not partial:
        missing = [s["id"] for s in board.shapes() if s["id"] not in moved]
        if missing:
            problems.append(f"not in spec: {missing}")
    problems += find_problems(board, frames, moved, everything=not partial)
    return problems


def align(board, frame_id, pairs, pad=ALIGN_PAD):
    """Move each node to its partner's x, refit the frame's x and width around the nodes, and
    draw a straight vertical connector for every arrow between a pair. List every member of
    the frame: one left out is reported if it ends up outside. Returns the list of problems.
    """
    frame = board.get(frame_id)
    for node, partner in pairs:
        element = board.get(node)
        board.move(node, board.get(partner)["x"], element["y"])
    left = min(board.get(n)["x"] for n, _ in pairs)
    right = max(board.get(n)["x"] + board.get(n)["width"] for n, _ in pairs)
    label = board.labels.get(frame_id)
    frame["x"], frame["width"] = left - pad, max(right - left + 2 * pad, (label.get("width", 0) + 2 * pad) if label else 0)
    if label:
        label["x"] = frame["x"] + (frame["width"] - label.get("width", 0)) / 2

    moved = {n for n, _ in pairs} | {frame_id}
    reroute(board, moved)
    pair_sets = [{n, p} for n, p in pairs]
    for arrow, start, end in board.bound_arrows():
        if {start, end} not in pair_sets:
            continue
        s, t = box(board.get(start)), box(board.get(end))
        lo, hi = max(s[0], t[0]), min(s[2], t[2])
        if lo >= hi:
            continue  # no shared x range; keep the straight re-route
        cx = (lo + hi) / 2
        if s[1] > t[1]:  # start below end
            set_arrow(board, arrow, (cx, s[1] - ARROW_GAP), (cx, t[3] + ARROW_GAP))
        else:
            set_arrow(board, arrow, (cx, s[3] + ARROW_GAP), (cx, t[1] - ARROW_GAP))
    return find_problems(board, {frame_id: [n for n, _ in pairs]}, moved, everything=False)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def report_problems(problems, ok_message):
    print("\n".join(problems) if problems else ok_message)
    return 1 if problems else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("widen", "rows"):
        cmd = sub.add_parser(name)
        cmd.add_argument("spec")
        cmd.add_argument("input")
        cmd.add_argument("output")
    cmd = sub.add_parser("align")
    cmd.add_argument("input")
    cmd.add_argument("output")
    cmd.add_argument("frame")
    cmd.add_argument("pairs", nargs="+", metavar="node=partner")
    args = parser.parse_args(argv)

    try:
        scene, version = load(args.input)
        board = Board(scene)
        if args.command == "widen":
            spec = load_spec(args.spec)
            changed, notes = widen(board, spec)
            save(scene, args.output)
            for note in notes:
                print(f"note: {note}")
            print(f"widened {len(changed)} shapes")
            code = 0
        elif args.command == "rows":
            spec = load_spec(args.spec)
            problems = rows(board, spec)
            save(scene, args.output)
            code = report_problems(problems, "layout OK: no overlaps, no arrow crossings")
        else:
            pairs = []
            for pair in args.pairs:
                node, sep, partner = pair.partition("=")
                if not sep or not node or not partner:
                    raise InputError(f"expected <node>=<partner>, got {pair!r}")
                pairs.append((node, partner))
            problems = align(board, args.frame, pairs)
            save(scene, args.output)
            code = report_problems(problems, "align OK: no overlaps, no arrow crossings")
    except (InputError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if version:
        print(f"read version {version} (pass it as --base when you write)")
    return code


def load_spec(path):
    with open(path, encoding="utf-8-sig") as handle:
        try:
            spec = json.load(handle)
        except json.JSONDecodeError as error:
            raise InputError(f"{path}: not JSON ({error})")
    if not isinstance(spec, dict):
        raise InputError(f"{path}: the spec must be a JSON object")
    return spec


if __name__ == "__main__":
    sys.exit(main())
