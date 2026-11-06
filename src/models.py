from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

# MATPOWER bus types
PQ, PV, REF, ISOLATED = 1, 2, 3, 4


@dataclass
class Bus:
    bus_id: int
    load_mw: float = 0.0
    name: Optional[str] = None
    bus_type: int = PQ
    shunt_mw: float = 0.0  # MATPOWER Gs: MW consumed at 1.0 pu voltage (acts as load in DC)
    area: int = 1
    base_kv: float = 0.0
    x: Optional[float] = None  # layout coordinates, filled in later by the UI
    y: Optional[float] = None


@dataclass
class Generator:
    generator_id: str
    bus_id: int
    p_min_mw: float
    p_max_mw: float
    offer_price: float = 0.0  # linear cost coefficient c1, $/MWh
    cost_c2: float = 0.0  # quadratic coefficient, $/MW^2h
    cost_c0: float = 0.0  # fixed cost, $/h
    p_mw: float = 0.0  # dispatch setpoint, used by plain power flow
    in_service: bool = True

    def cost(self, p_mw: float) -> float:
        return self.cost_c2 * p_mw**2 + self.offer_price * p_mw + self.cost_c0


@dataclass
class Branch:
    from_bus: int
    to_bus: int
    reactance_pu: float
    limit_mw: float = math.inf  # <= 0 or inf means unlimited (MATPOWER rateA = 0)
    branch_id: Optional[str] = None
    in_service: bool = True
    resistance_pu: float = 0.0
    tap_ratio: float = 1.0
    phase_shift_deg: float = 0.0

    @property
    def is_limited(self) -> bool:
        return 0 < self.limit_mw < math.inf


@dataclass
class Network:
    buses: list[Bus]
    generators: list[Generator]
    branches: list[Branch]
    base_mva: float = 100.0
    name: str = "network"
    reference_bus_id: Optional[int] = None
    bus_index: dict[int, int] = field(init=False, repr=False)

    def __post_init__(self):
        if self.base_mva <= 0:
            raise ValueError("base_mva must be positive.")

        self.bus_index = {bus.bus_id: i for i, bus in enumerate(self.buses)}
        if len(self.bus_index) != len(self.buses):
            raise ValueError("Duplicate bus IDs.")

        for n, branch in enumerate(self.branches, start=1):
            if branch.branch_id is None:
                branch.branch_id = f"L{n}"
        _check_unique([b.branch_id for b in self.branches], "branch")
        _check_unique([g.generator_id for g in self.generators], "generator")

        for branch in self.branches:
            for bus_id in (branch.from_bus, branch.to_bus):
                if bus_id not in self.bus_index:
                    raise ValueError(f"Branch {branch.branch_id} references unknown bus {bus_id}.")
            if branch.in_service and branch.reactance_pu == 0:
                raise ValueError(f"Branch {branch.branch_id} has zero reactance.")
        for gen in self.generators:
            if gen.bus_id not in self.bus_index:
                raise ValueError(f"Generator {gen.generator_id} references unknown bus {gen.bus_id}.")

        if self.reference_bus_id is None:
            refs = [b.bus_id for b in self.buses if b.bus_type == REF]
            self.reference_bus_id = refs[0] if refs else self.buses[0].bus_id
        elif self.reference_bus_id not in self.bus_index:
            raise ValueError("Reference bus does not exist.")

    def branch(self, branch_id: str) -> Branch:
        for b in self.branches:
            if b.branch_id == branch_id:
                return b
        raise KeyError(branch_id)


def _check_unique(ids, kind):
    seen = set()
    for i in ids:
        if i in seen:
            raise ValueError(f"Duplicate {kind} ID: {i}")
        seen.add(i)
