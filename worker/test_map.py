"""Tests for the --map steps that don't need COLMAP. Run: python -m unittest test_map (in worker/)."""
import unittest

import cv2
import numpy as np

from floorplan import GRID
from floormap import DOOR_GAP, align_walls, doorways, outline, place_doors, shape_of, split

# A 20 × 2.4 m corridor with 15 cm walls; room A (5 × 5) and room B (5.85 × 4) to the north, room C (6 × 5) to the
# south, each through a 0.9 m door. Plan coordinates, metres.
CORRIDOR = (0, 0, 20, 2.4)
ROOMS = {"A": ((2, -5.15, 7, -0.15), (4.05, 4.95)), "B": ((7.15, -4.15, 13, -0.15), (11.0, 11.9)),
         "C": ((5, 2.55, 11, 7.55), (6.0, 6.9))}
LO = np.array([-1.0, -6.5])


def floor_mask():
    m = np.zeros((int(15 / GRID), int(22 / GRID)), np.uint8)
    box = lambda x0, y0, x1, y1: cv2.rectangle(m, tuple(np.round((np.array([x0, y0]) - LO) / GRID).astype(int)),
                                               tuple(np.round((np.array([x1, y1]) - LO) / GRID).astype(int) - 1), 1, -1)
    box(*CORRIDOR)
    for (x0, y0, x1, y1), (d0, d1) in ROOMS.values():
        box(x0, y0, x1, y1)
        box(d0, -0.15, d1, 0) if y1 <= 0 else box(d0, 2.4, d1, 2.55)
    return m


class Split(unittest.TestCase):
    def setUp(self):
        self.lab = split(floor_mask())
        self.ways = doorways(self.lab, LO)

    def test_parts_meet_in_the_doorways(self):
        self.assertEqual(self.lab.max(), 4)
        self.assertEqual(len(self.ways), 3)
        for (x0, y0, x1, y1), (d0, d1) in ROOMS.values():
            want = np.array([(d0 + d1) / 2, -0.075 if y1 <= 0 else 2.475])
            got = min(self.ways, key=lambda w: np.hypot(*(w["c"] - want)))
            self.assertLess(np.hypot(*(got["c"] - want)), 0.15)
            self.assertTrue(got["horiz"])
            self.assertAlmostEqual(got["w"], 0.9, delta=0.15)

    def test_outlines_doors_and_shared_walls(self):
        regions = []
        for l in range(1, self.lab.max() + 1):
            poly = outline((self.lab == l).astype(np.uint8), LO, np.zeros((0, 2)))
            regions.append({"label": l, "poly": poly, "doors": []})
        align_walls({r["label"]: r["poly"] for r in regions})
        for r in regions:
            g = shape_of(r["poly"])
            r.update(type=g["kind"], area=float(cv2.contourArea(r["poly"].astype(np.float32))), width=g["width"])
        types = sorted(r["type"] for r in regions)
        self.assertEqual(types, ["corridor", "room", "room", "room"])
        hall = next(r for r in regions if r["type"] == "corridor")
        self.assertAlmostEqual(hall["width"], 2.55, delta=0.15)   # measured to the middle of the 15 cm walls it shares
        # the corridor's walls and each room's wall are on one line now
        ys = sorted({round(float(v[1]), 2) for v in hall["poly"]})
        for r in regions:
            if r is hall:
                continue
            ry = sorted({round(float(v[1]), 2) for v in r["poly"]})
            self.assertTrue(set(ry) & set(ys), f"room {ry} shares no wall with the corridor {ys}")
        notes = []
        place_doors(regions, self.ways, notes)
        self.assertEqual(notes, [])
        self.assertEqual(sum(len(r["doors"]) for r in regions), 3)
        self.assertEqual(len(hall["doors"]), 0, "doors go on the rooms")
        for r in regions:
            for d in r["doors"]:
                self.assertLessEqual(d["gap"], DOOR_GAP)
                self.assertAlmostEqual(d["w"], 0.9, delta=0.15)


class Shape(unittest.TestCase):
    def test_kinds(self):
        rect = lambda w, h: np.array([[0, 0], [w, 0], [w, h], [0, h]], float)
        self.assertEqual(shape_of(rect(20, 2.4))["kind"], "corridor")
        self.assertEqual(shape_of(rect(5, 5))["kind"], "room")
        self.assertEqual(shape_of(rect(8, 3))["kind"], "room")


if __name__ == "__main__":
    unittest.main()
