"""Force-level checks for the repository-owned radius-aware adaptation."""

from __future__ import annotations

import argparse
import sys
import unittest
from pathlib import Path

import numpy as np


PYSOCIALFORCE_SOURCE: Path


class StubPeds:
    def __init__(self, positions, velocities):
        self._positions = np.asarray(positions, dtype=np.float64)
        self._velocities = np.asarray(velocities, dtype=np.float64)

    def pos(self):
        return self._positions

    def vel(self):
        return self._velocities

    def size(self):
        return self._positions.shape[0]


class StubConfig:
    VALUES = {"lambda_importance": 2.0, "gamma": 0.35, "n": 2.0, "n_prime": 3.0}

    def __call__(self, key, default=None):
        return self.VALUES.get(key, default)


class RadiusAwareForceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        social_directory = Path(__file__).resolve().parents[2] / "experiments" / "baselines" / "social_force"
        sys.path.insert(0, str(social_directory))
        from runner import load_pysocialforce

        load_pysocialforce(PYSOCIALFORCE_SOURCE)
        global pairwise_surface_clearances, radius_aware_social_force
        from radius_aware import pairwise_surface_clearances, radius_aware_social_force

    def force(self, positions, velocities, radii):
        return radius_aware_social_force(
            np.asarray(positions, dtype=np.float64),
            np.asarray(velocities, dtype=np.float64),
            np.asarray(radii, dtype=np.float64),
            lambda_importance=2.0,
            gamma=0.35,
            n=2.0,
            n_prime=3.0,
        )

    def legacy_force(self, positions, velocities):
        from pysocialforce.forces import SocialForce

        force = SocialForce()
        force.peds = StubPeds(positions, velocities)
        force.config = StubConfig()
        force.factor = 1.0
        return force._get_force()

    def test_zero_radii_reproduce_upstream_legacy_force(self):
        positions = [[-1.0, 0.2], [1.0, -0.1], [0.3, 1.5]]
        velocities = [[0.8, 0.1], [-0.7, -0.2], [0.2, -0.5]]
        np.testing.assert_allclose(
            self.force(positions, velocities, [0.0, 0.0, 0.0]),
            self.legacy_force(positions, velocities),
            rtol=2e-15,
            atol=2e-15,
        )

    def test_larger_radius_sum_increases_magnitude_without_direction_change(self):
        positions = [[-1.0, 0.2], [1.0, -0.1]]
        velocities = [[0.8, 0.1], [-0.7, -0.2]]
        small = self.force(positions, velocities, [0.1, 0.1])
        large = self.force(positions, velocities, [0.35, 0.35])
        for small_force, large_force in zip(small, large):
            self.assertGreater(np.linalg.norm(large_force), np.linalg.norm(small_force))
            np.testing.assert_allclose(
                large_force / np.linalg.norm(large_force),
                small_force / np.linalg.norm(small_force),
                rtol=2e-15,
                atol=2e-15,
            )

    def test_unequal_radii_use_symmetric_sum(self):
        positions = [[-1.0, 0.2], [1.0, -0.1]]
        velocities = [[0.8, 0.1], [-0.7, -0.2]]
        first = self.force(positions, velocities, [0.15, 0.45])
        second = self.force(positions, velocities, [0.45, 0.15])
        np.testing.assert_array_equal(first, second)

    def test_contact_is_zero_surface_clearance(self):
        clearances = pairwise_surface_clearances(
            np.asarray([[0.0, 0.0], [0.7, 0.0]]),
            np.asarray([0.2, 0.5]),
        )
        np.testing.assert_allclose(clearances, [0.0, 0.0], atol=1e-15)

    def test_negative_surface_clearance_remains_finite(self):
        positions = [[-0.2, 0.05], [0.2, -0.05]]
        velocities = [[0.8, 0.1], [-0.7, -0.2]]
        clearances = pairwise_surface_clearances(
            np.asarray(positions), np.asarray([0.3, 0.3])
        )
        self.assertTrue(np.all(clearances < 0.0))
        self.assertTrue(np.all(np.isfinite(self.force(positions, velocities, [0.3, 0.3]))))

    def test_single_agent_has_no_self_interaction(self):
        np.testing.assert_array_equal(
            self.force([[0.0, 0.0]], [[1.0, 0.0]], [0.3]),
            np.zeros((1, 2)),
        )
        self.assertEqual(
            pairwise_surface_clearances(np.asarray([[0.0, 0.0]]), np.asarray([0.3])).size,
            0,
        )

    def test_agent_order_permutation_preserves_pairwise_behavior(self):
        positions = np.asarray([[-1.0, 0.2], [1.0, -0.1], [0.3, 1.5]])
        velocities = np.asarray([[0.8, 0.1], [-0.7, -0.2], [0.2, -0.5]])
        radii = np.asarray([0.2, 0.3, 0.4])
        expected = self.force(positions, velocities, radii)
        permutation = np.asarray([2, 0, 1])
        permuted = self.force(positions[permutation], velocities[permutation], radii[permutation])
        inverse = np.argsort(permutation)
        np.testing.assert_allclose(permuted[inverse], expected, rtol=2e-15, atol=2e-15)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-directory", required=True)
    arguments, unittest_arguments = parser.parse_known_args()
    global PYSOCIALFORCE_SOURCE
    PYSOCIALFORCE_SOURCE = Path(arguments.source_directory).resolve()
    unittest.main(argv=[sys.argv[0], *unittest_arguments])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
