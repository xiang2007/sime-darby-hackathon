"""Tests for the walk → corridor steps that don't need COLMAP. Run: python -m unittest test_walk (in worker/)."""
import unittest

import numpy as np

from walk import _exit, _triangulate, find_walls, place_doors, placeholder_rooms, room_code, straight_runs


class RoomCode(unittest.TestCase):
    def test_signs(self):
        self.assertEqual(room_code("B-03-02"), ("B-03-02", "B", 3))
        self.assertEqual(room_code("b-3-2"), ("B-03-02", "B", 3))
        self.assertEqual(room_code("Room B–06–11A"), ("B-06-11A", "B", 6))
        self.assertEqual(room_code("APU|B|03|B-03-07"), ("B-03-07", "B", 3))
        self.assertIsNone(room_code("EXIT"))
        self.assertIsNone(room_code("2024-03-02"))     # a date isn't a room


class Runs(unittest.TestCase):
    def test_l_shaped_walk_with_sway(self):
        rng = np.random.default_rng(1)
        a = np.stack([np.linspace(1, 22.8, 40), np.full(40, 1.2)], 1)
        b = np.stack([np.full(25, 22.8), np.linspace(1.2, 13, 25)], 1)
        xy = np.vstack([a, b[1:]]) + rng.normal(0, 0.08, (64, 2))
        runs = straight_runs(xy)
        self.assertEqual([r["horiz"] for r in runs], [True, False])
        self.assertAlmostEqual(runs[0]["c"], 1.2, delta=0.1)
        self.assertAlmostEqual(runs[1]["c"], 22.8, delta=0.1)

    def test_short_sidestep_is_merged(self):
        xy = np.array([[0, 0], [5, 0], [5, 0.5], [12, 0.5]], float)
        xy = np.vstack([np.linspace(xy[i], xy[i + 1], 10) for i in range(3)])
        self.assertEqual(len(straight_runs(xy)), 1)

    def test_walls(self):
        rng = np.random.default_rng(2)
        x = rng.uniform(0, 20, 3000)
        pts = np.vstack([np.stack([x[:1500], 1.0 + rng.normal(0, 0.01, 1500) - 0.9], 1),
                         np.stack([x[1500:], 1.0 + rng.normal(0, 0.01, 1500) + 1.4], 1)])
        run = {"horiz": True, "c": 1.0}
        left, right = find_walls(run, None, pts, 0, 20)
        self.assertAlmostEqual(left, 0.9, delta=0.05)
        self.assertAlmostEqual(right, 1.4, delta=0.05)


class Doors(unittest.TestCase):
    def test_sight_lines_cross_at_the_sign(self):
        sign = np.array([9.0, 0.0])
        cams = [np.array([6.0, 1.2]), np.array([8.0, 1.5]), np.array([11.0, 1.0])]
        rays = [(c, (sign - c) / np.hypot(*(sign - c))) for c in cams]
        np.testing.assert_allclose(_triangulate(rays), sign, atol=1e-9)
        self.assertIsNone(_triangulate(rays[:1]))

    def test_misread_next_to_a_sign_is_dropped(self):
        ray = (np.array([5.0, 1.2]), np.array([0, -1.0]))
        notes = []
        doors = place_doors(self.poly, {"B-03-05": [(1.2, 0, .5, *ray)] * 3, "B-03-15": [(1.2, 0, .52, *ray)]}, notes)
        self.assertEqual([d["code"] for d in doors], ["B-03-05"])
        self.assertIn("B-03-15", notes[0])

    poly = np.array([[0, 0], [20, 0], [20, 2.4], [0, 2.4]], float)

    def test_ray_exit(self):
        s, e, t = _exit(self.poly, np.array([5, 1.2]), np.array([0, -1.0]))
        self.assertEqual(e, 0)
        self.assertAlmostEqual(s, 1.2)
        self.assertAlmostEqual(t, 0.25)

    def test_rooms_dont_overlap(self):
        ray = (np.array([5.0, 1.2]), np.array([0, -1.0]))
        hits = {c: [(1.2, e, t, *ray)] * n for c, e, t, n in (("B-03-01", 0, .25, 3), ("B-03-02", 0, .40, 3), ("B-03-03", 2, .5, 2))}
        doors = place_doors(self.poly, hits)
        notes = []
        rooms = placeholder_rooms(self.poly, doors, notes)
        self.assertEqual(len(rooms), 3)
        boxes = [(r["poly"].min(0), r["poly"].max(0)) for r in rooms]
        for i in range(3):
            lo, hi = boxes[i]
            self.assertTrue(lo[1] >= 2.4 - 1e-6 or hi[1] <= 1e-6, "room must be outside the corridor")
            for j in range(i + 1, 3):
                lo2, hi2 = boxes[j]
                self.assertFalse(np.all(lo < hi2 - 1e-6) and np.all(lo2 < hi - 1e-6), "rooms overlap")
        # signs 3 m apart: each room is at most 3 m wide
        w = [float(np.ptp(r["poly"][:, 0])) for r in rooms if r["id"] in ("B-03-01", "B-03-02")]
        self.assertTrue(all(x <= 3.0 + 1e-6 for x in w))


if __name__ == "__main__":
    unittest.main()
