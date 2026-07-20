"""Repository-owned radius-aware adaptation of pinned PySocialForce SocialForce.

Only the scalar distance used by the pedestrian-pedestrian interaction
magnitude is changed.  The upstream direction, angular terms, factor, and
aggregation are preserved.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np


DISTANCE_CONVENTION = "surface_clearance = center_distance - radius_i - radius_j"
RADIUS_AWARE_FORCE_VERSION = 1


def pairwise_surface_clearances(positions: np.ndarray, radii: np.ndarray) -> np.ndarray:
    """Return row-major off-diagonal surface clearances used by PySocialForce."""
    positions = np.asarray(positions, dtype=np.float64)
    radii = np.asarray(radii, dtype=np.float64)
    _validate_inputs(positions, np.zeros_like(positions), radii)
    count = positions.shape[0]
    if count <= 1:
        return np.empty((0,), dtype=np.float64)
    position_differences = (
        np.expand_dims(positions, 1) - np.expand_dims(positions, 0)
    )
    center_distances = np.linalg.norm(position_differences, axis=-1)
    radius_sums = np.expand_dims(radii, 1) + np.expand_dims(radii, 0)
    mask = ~np.eye(count, dtype=bool)
    return center_distances[mask] - radius_sums[mask]


def radius_aware_social_force(
    positions: np.ndarray,
    velocities: np.ndarray,
    radii: np.ndarray,
    *,
    lambda_importance: float,
    gamma: float,
    n: float,
    n_prime: float,
) -> np.ndarray:
    """Compute the unfactored pinned SocialForce with surface-clearance distance."""
    positions = np.asarray(positions, dtype=np.float64)
    velocities = np.asarray(velocities, dtype=np.float64)
    radii = np.asarray(radii, dtype=np.float64)
    _validate_inputs(positions, velocities, radii)
    parameters = np.asarray([lambda_importance, gamma, n, n_prime], dtype=np.float64)
    if not np.all(np.isfinite(parameters)) or gamma <= 0.0:
        raise ValueError("Radius-aware SocialForce parameters must be finite and gamma positive")
    count = positions.shape[0]
    if count <= 1:
        return np.zeros((count, 2), dtype=np.float64)

    mask = ~np.eye(count, dtype=bool)
    position_differences = (
        np.expand_dims(positions, 1) - np.expand_dims(positions, 0)
    )[mask]
    velocity_differences = -1.0 * (
        np.expand_dims(velocities, 1) - np.expand_dims(velocities, 0)
    )[mask]
    difference_directions, center_distances = _normalize(position_differences)
    surface_clearances = center_distances - (
        np.expand_dims(radii, 1) + np.expand_dims(radii, 0)
    )[mask]

    interaction_vectors = lambda_importance * velocity_differences + difference_directions
    interaction_directions, interaction_lengths = _normalize(interaction_vectors)
    theta = (
        np.arctan2(interaction_directions[:, 1], interaction_directions[:, 0])
        - np.arctan2(difference_directions[:, 1], difference_directions[:, 0])
    )
    scale = gamma * interaction_lengths
    try:
        with np.errstate(divide="ignore", invalid="ignore", over="raise"):
            common_exponent = -1.0 * surface_clearances / scale
            velocity_amount = np.exp(common_exponent - np.square(n_prime * scale * theta))
            angle_amount = -np.sign(theta) * np.exp(
                common_exponent - np.square(n * scale * theta)
            )
    except FloatingPointError as error:
        raise FloatingPointError(_failure_context(
            "non-finite exponential", positions, velocities, radii,
            surface_clearances, interaction_lengths,
        )) from error
    if not np.all(np.isfinite(velocity_amount)) or not np.all(np.isfinite(angle_amount)):
        raise FloatingPointError(_failure_context(
            "non-finite exponential", positions, velocities, radii,
            surface_clearances, interaction_lengths,
        ))

    velocity_force = velocity_amount.reshape(-1, 1) * interaction_directions
    left_normal = np.fliplr(interaction_directions) * np.array([-1.0, 1.0])
    angle_force = angle_amount.reshape(-1, 1) * left_normal
    pair_forces = velocity_force + angle_force
    forces = np.sum(pair_forces.reshape((count, -1, 2)), axis=1)
    if not np.all(np.isfinite(pair_forces)) or not np.all(np.isfinite(forces)):
        raise FloatingPointError(_failure_context(
            "non-finite force", positions, velocities, radii,
            surface_clearances, interaction_lengths,
        ))
    return forces


def install_radius_aware_social_force(simulator: Any, radii: np.ndarray) -> None:
    """Replace exactly the upstream SocialForce instance in a Simulator."""
    from pysocialforce import forces as upstream_forces  # pylint: disable=import-outside-toplevel

    radii = np.asarray(radii, dtype=np.float64).copy()
    if radii.shape != (simulator.peds.size(),):
        raise ValueError("Radius count does not match PySocialForce pedestrian count")

    class RadiusAwareSocialForce(upstream_forces.SocialForce):
        def init(self, scene, config):
            # The subclass name must not select a new TOML section.  Reuse the
            # exact upstream [social_force] configuration instead.
            self.scene = scene
            self.peds = scene.peds
            self.config = config.sub_config("social_force")
            self.factor = self.config("factor", 1.0)

        def _get_force(self):
            force = radius_aware_social_force(
                self.peds.pos(),
                self.peds.vel(),
                radii,
                lambda_importance=self.config("lambda_importance", 2.0),
                gamma=self.config("gamma", 0.35),
                n=self.config("n", 2),
                n_prime=self.config("n_prime", 3),
            )
            factored = force * self.factor
            if not np.all(np.isfinite(factored)):
                raise FloatingPointError(_failure_context(
                    "non-finite factored force",
                    self.peds.pos(), self.peds.vel(), radii,
                    pairwise_surface_clearances(self.peds.pos(), radii),
                    np.empty((0,), dtype=np.float64),
                ))
            return factored

    indices = [
        index for index, force in enumerate(simulator.forces)
        if type(force) is upstream_forces.SocialForce
    ]
    if len(indices) != 1:
        raise RuntimeError(
            f"Expected exactly one upstream SocialForce instance, found {len(indices)}"
        )
    replacement = RadiusAwareSocialForce()
    replacement.init(simulator, simulator.config)
    simulator.forces[indices[0]] = replacement


def _normalize(vectors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lengths = np.linalg.norm(vectors, axis=1)
    normalized = np.zeros_like(vectors, dtype=np.float64)
    nonzero = lengths != 0.0
    normalized[nonzero] = vectors[nonzero] / lengths[nonzero, None]
    return normalized, lengths


def _validate_inputs(
    positions: np.ndarray,
    velocities: np.ndarray,
    radii: np.ndarray,
) -> None:
    if positions.ndim != 2 or positions.shape[1:] != (2,):
        raise ValueError("positions must have shape (n, 2)")
    if velocities.shape != positions.shape:
        raise ValueError("velocities must have the same shape as positions")
    if radii.shape != (positions.shape[0],):
        raise ValueError("radii must have shape (n,)")
    if (
        not np.all(np.isfinite(positions))
        or not np.all(np.isfinite(velocities))
        or not np.all(np.isfinite(radii))
    ):
        raise ValueError("Radius-aware SocialForce inputs must be finite")
    if np.any(radii < 0.0):
        raise ValueError("Pedestrian radii must be nonnegative")


def _failure_context(
    reason: str,
    positions: np.ndarray,
    velocities: np.ndarray,
    radii: np.ndarray,
    surface_clearances: np.ndarray,
    interaction_lengths: np.ndarray,
) -> str:
    context = {
        "reason": reason,
        "positions": np.asarray(positions).tolist(),
        "velocities": np.asarray(velocities).tolist(),
        "radii": np.asarray(radii).tolist(),
        "surfaceClearances": np.asarray(surface_clearances).tolist(),
        "interactionLengths": np.asarray(interaction_lengths).tolist(),
    }
    return f"Radius-aware SocialForce failure: {json.dumps(context, separators=(',', ':'))}"
