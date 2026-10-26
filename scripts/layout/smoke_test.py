#!/usr/bin/env python3
"""Smoke test for xcld_layout.py on a small synthetic board. No server, no real boards.

Run: python -I scripts/layout/smoke_test.py
"""
import contextlib
import copy
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's folder off sys.path
sys.dont_write_bytecode = True

import xcld_layout as xl  # noqa: E402


def shape(element_id, x, y, w, h, label, valign="middle", wrap_at=240):
    """A rectangle with a bound label, as the server draws a Mermaid node or subgraph."""
    text_id = f"{element_id}_label"
    rect = {
        "id": element_id, "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "boundElements": [{"type": "text", "id": text_id}],
    }
    wrapped = xl.wrap_text(label, wrap_at)
    lines = wrapped.split("\n")
    text = {
        "id": text_id, "type": "text", "x": x + 10, "y": y + 10,
        "width": max(xl.text_width(line) for line in lines), "height": len(lines) * 25,
        "text": wrapped, "originalText": label, "containerId": element_id,
        "fontSize": 20, "lineHeight": 1.25, "verticalAlign": valign,
    }
    return [rect, text]


def arrow(element_id, start, end, label=None):
    elements = [{
        "id": element_id, "type": "arrow", "x": 0, "y": 0, "width": 10, "height": 10,
        "points": [[0, 0], [10, 10]],
        "startBinding": {"elementId": start, "mode": "orbit", "fixedPoint": [0.5001, 1.0]},
        "endBinding": {"elementId": end, "mode": "orbit", "fixedPoint": [0.5001, 0.0]},
        "boundElements": [],
    }]
    if label:
        elements[0]["boundElements"].append({"type": "text", "id": f"{element_id}_label"})
        elements.append({
            "id": f"{element_id}_label", "type": "text", "x": 0, "y": 0, "width": 70, "height": 25,
            "text": label, "originalText": label, "containerId": element_id, "fontSize": 20,
        })
    return elements


def grid_fallback_board():
    """Two subgraphs and four nodes piled into one narrow column, the frames overlapping."""
    elements = []
    elements += shape("src:FRAME1", -30, -40, 320, 360, "Inputs", valign="top")
    elements += shape("src:FRAME2", -30, 220, 320, 360, "Outputs", valign="top")
    elements += shape("src:A", 0, 0, 260, 110, "Read the source data from the upstream store every hour")
    elements += shape("src:B", 0, 150, 260, 60, "Validate rows")
    elements += shape("src:C", 0, 260, 260, 110, "Write the cleaned table back to the warehouse for reporting")
    elements += shape("src:D", 0, 620, 260, 60, "Notify the owner")
    elements += arrow("src:A_C", "src:A", "src:C", label="cleaned")
    elements += arrow("src:B_D", "src:B", "src:D")
    return {"type": "excalidraw", "version": 2, "elements": elements, "appState": {}, "files": {}}


FRAMES = {"src:FRAME1": ["src:A", "src:B"], "src:FRAME2": ["src:C"]}
WIDEN_SPEC = {"widths": {"src:": 420}}
ROWS_SPEC = {"rows": [
    [{"frame": "src:FRAME1", "nodes": ["src:A", "src:B"]}],
    [{"frame": "src:FRAME2", "nodes": ["src:C"]}, {"node": "src:D"}],
]}


def rect_of(element):
    return (element["x"], element["y"], element["x"] + element["width"], element["y"] + element["height"])


def disjoint(a, b, clearance=0):
    return a[2] + clearance <= b[0] or b[2] + clearance <= a[0] or a[3] + clearance <= b[1] or b[3] + clearance <= a[1]


class LayoutSmokeTest(unittest.TestCase):
    def assert_clean_layout(self, board, frames):
        """Independent of xcld_layout's own checker: plain box arithmetic."""
        live = board.live
        frame_ids = list(frames)
        node_ids = [i for i, e in live.items() if e["type"] == "rectangle" and i not in frames]
        for i, a in enumerate(frame_ids):
            for b in frame_ids[i + 1:]:
                self.assertTrue(disjoint(rect_of(live[a]), rect_of(live[b])), f"frames {a} and {b} overlap")
        for i, a in enumerate(node_ids):
            for b in node_ids[i + 1:]:
                self.assertTrue(disjoint(rect_of(live[a]), rect_of(live[b]), 10), f"nodes {a} and {b} overlap")
        for frame, members in frames.items():
            f = rect_of(live[frame])
            for node in node_ids:
                n = rect_of(live[node])
                if node in members:
                    self.assertTrue(f[0] <= n[0] and f[1] <= n[1] and n[2] <= f[2] and n[3] <= f[3], f"{node} not inside {frame}")
                else:
                    self.assertTrue(disjoint(f, n), f"{node} sits on {frame}")
        for element_id, element in live.items():
            label = board.labels.get(element_id)
            if element["type"] == "rectangle" and label and label.get("verticalAlign") != "top":
                s, t = rect_of(element), rect_of(label)
                self.assertTrue(s[0] <= t[0] and s[1] <= t[1] and t[2] <= s[2] and t[3] <= s[3], f"label of {element_id} left its shape")

    def test_grid_fallback_board_is_flagged(self):
        board = xl.Board(grid_fallback_board())
        problems = xl.find_problems(board, FRAMES, set(), everything=True)
        self.assertIn("frame overlap src:FRAME1 / src:FRAME2", problems)

    def test_widen_rewraps_from_original_text(self):
        board = xl.Board(grid_fallback_board())
        changed, notes = xl.widen(board, WIDEN_SPEC)
        self.assertEqual(sorted(changed), ["src:A", "src:B", "src:C", "src:D"])  # frames skipped
        self.assertEqual(notes, [])
        self.assertEqual(board.get("src:FRAME1")["width"], 320)
        a, label = board.get("src:A"), board.labels["src:A"]
        self.assertEqual(a["width"], 420.0)
        self.assertEqual(label["originalText"], "Read the source data from the upstream store every hour")
        self.assertEqual(label["text"].replace("\n", " "), label["originalText"])
        self.assertLess(label["text"].count("\n"), 2, "a 420px node should need at most two lines")
        for line in label["text"].split("\n"):
            self.assertLessEqual(xl.text_width(line), (420 - xl.WIDEN_PAD_X) * xl.WRAP_TOLERANCE)
        self.assertGreaterEqual(a["height"], label["height"])

    def test_widen_then_rows_lays_out_cleanly(self):
        board = xl.Board(grid_fallback_board())
        xl.widen(board, WIDEN_SPEC)
        problems = xl.rows(board, copy.deepcopy(ROWS_SPEC))
        self.assertEqual(problems, [])
        self.assert_clean_layout(board, FRAMES)
        # The re-routed arrow starts just outside A and its binding matches the new geometry.
        arr, a = board.get("src:A_C"), board.get("src:A")
        start = (arr["x"], arr["y"])
        x1, y1, x2, y2 = rect_of(a)
        self.assertFalse(x1 < start[0] < x2 and y1 < start[1] < y2, "arrow starts inside its shape")
        fp = arr["startBinding"]["fixedPoint"]
        self.assertAlmostEqual(x1 + fp[0] * (x2 - x1), start[0], delta=0.5)
        self.assertAlmostEqual(y1 + fp[1] * (y2 - y1), start[1], delta=0.5)
        # The arrow's label sits on the arrow's midpoint.
        end = (arr["x"] + arr["points"][-1][0], arr["y"] + arr["points"][-1][1])
        lab = board.labels["src:A_C"]
        self.assertAlmostEqual(lab["x"] + lab["width"] / 2, (start[0] + end[0]) / 2)

    def test_partial_spec_reports_landing_on_an_untouched_node(self):
        board = xl.Board(grid_fallback_board())
        xl.widen(board, WIDEN_SPEC)
        xl.rows(board, copy.deepcopy(ROWS_SPEC))
        b = board.get("src:B")
        before = json.dumps(board.get("src:A_C"), sort_keys=True)
        problems = xl.rows(board, {"partial": True, "origin": [b["x"], b["y"]], "rows": [[{"node": "src:D"}]]})
        self.assertIn("node overlap src:B / src:D", problems)
        self.assertEqual(json.dumps(board.get("src:A_C"), sort_keys=True), before, "partial must not touch other arrows")

    def test_align_under_draws_vertical_connector(self):
        board = xl.Board(grid_fallback_board())
        xl.widen(board, WIDEN_SPEC)
        xl.rows(board, {"rows": [
            [{"frame": "src:FRAME1", "nodes": ["src:A", "src:B"]}],
            [{"frame": "src:FRAME2", "nodes": ["src:C"]}],
            [{"node": "src:D"}],
        ]})
        problems = xl.align(board, "src:FRAME2", [("src:C", "src:B")])
        self.assertEqual(problems, [], problems)
        self.assertEqual(board.get("src:C")["x"], board.get("src:B")["x"])
        frame, c = rect_of(board.get("src:FRAME2")), rect_of(board.get("src:C"))
        self.assertTrue(frame[0] < c[0] and c[2] < frame[2], "frame refit around the moved node")

    def test_align_reports_landing_on_another_node(self):
        board = xl.Board(grid_fallback_board())
        xl.widen(board, WIDEN_SPEC)
        xl.rows(board, {"rows": [
            [{"frame": "src:FRAME1", "nodes": ["src:A", "src:B"]}],
            [{"node": "src:D"}, {"frame": "src:FRAME2", "nodes": ["src:C"]}],
        ]})
        problems = xl.align(board, "src:FRAME2", [("src:C", "src:A")])  # D is already under A
        self.assertIn("node overlap src:C / src:D", problems)
        self.assertEqual(board.get("src:A_C")["points"][-1][0], 0, "the pair's connector is vertical")

    def test_cli_reads_xcld_read_output_and_writes_a_scene(self):
        quiet = io.StringIO()
        with tempfile.TemporaryDirectory(prefix=".smoke-", dir=HERE) as tmp,                 contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            path = lambda name: os.path.join(tmp, name)  # noqa: E731
            envelope = {"board": "sandbox/demo", "version": "abc123", "scene": grid_fallback_board()}
            # PowerShell 5.1 `>` writes UTF-16; the loader must accept it.
            with open(path("read.json"), "w", encoding="utf-16") as handle:
                json.dump(envelope, handle)
            for name, spec in (("widen.json", WIDEN_SPEC), ("rows.json", ROWS_SPEC)):
                with open(path(name), "w", encoding="utf-8") as handle:
                    json.dump(spec, handle)
            self.assertEqual(xl.main(["widen", path("widen.json"), path("read.json"), path("step1.json")]), 0)
            self.assertEqual(xl.main(["rows", path("rows.json"), path("step1.json"), path("step2.json")]), 0)
            with open(path("step2.json"), encoding="utf-8") as handle:
                out = json.load(handle)
            self.assertEqual(out["type"], "excalidraw")
            self.assertEqual(len(out["elements"]), len(grid_fallback_board()["elements"]))
            # Bad input is exit 2: a missing file, and a spec naming an id the board doesn't have.
            self.assertEqual(xl.main(["rows", path("rows.json"), path("missing.json"), path("x.json")]), 2)
            with open(path("bad.json"), "w", encoding="utf-8") as handle:
                json.dump({"rows": [[{"node": "src:NOPE"}]]}, handle)
            self.assertEqual(xl.main(["rows", path("bad.json"), path("step1.json"), path("x.json")]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
