"""Small analytical checks for independent audit geometry."""

from __future__ import annotations

import math

from audit_common import constant_velocity_ttc, deflection_degrees, wall_clearance


def main() -> int:
    assert math.isclose(constant_velocity_ttc((2.0, 0.0), (-2.0, 0.0), 0.5) or -1.0, 0.75, abs_tol=1e-15)
    assert constant_velocity_ttc((2.0, 0.0), (2.0, 0.0), 0.5) is None
    assert constant_velocity_ttc((0.4, 0.0), (-2.0, 0.0), 0.5) == 0.0
    angle = deflection_degrees((math.cos(math.radians(10)), math.sin(math.radians(10))), (1.0, 0.0))
    assert angle is not None and math.isclose(angle, 10.0, abs_tol=1e-12)
    assert math.isclose(
        wall_clearance((0.0, 0.0), 0.3, {"start": [1.0, -1.0], "end": [1.0, 1.0], "thickness": 0.2}),
        0.6,
        abs_tol=1e-15,
    )
    print("independent audit geometry self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
