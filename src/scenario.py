"""Scenarios: a base case plus an ordered list of edits.

The base case is never mutated. `apply_scenario` copies it and replays the edits, so a scenario
is cheap to store, diff, undo (drop the last edit) and share.
"""

from __future__ import annotations

import copy
import math
from functools import lru_cache
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field

from src.matpower import load_case
from src.models import Branch, Bus, Generator, Network


class ScenarioError(ValueError):
    def __init__(self, message: str, edit_index: int | None = None):
        super().__init__(message)
        self.edit_index = edit_index


class UnknownCaseError(ScenarioError):
    pass


# --------------------------------------------------------------------------- edits

class SetBranchStatus(BaseModel):
    op: Literal["set_branch_status"] = "set_branch_status"
    branch_id: str
    in_service: bool


class SetBranchParams(BaseModel):
    """Change line parameters. Omitted fields are unchanged; `unlimited=True` removes the limit."""
    op: Literal["set_branch_params"] = "set_branch_params"
    branch_id: str
    reactance_pu: Optional[float] = None
    limit_mw: Optional[float] = Field(None, gt=0)
    unlimited: bool = False


class AddBranch(BaseModel):
    op: Literal["add_branch"] = "add_branch"
    from_bus: int
    to_bus: int
    reactance_pu: float
    limit_mw: Optional[float] = Field(None, gt=0)  # None = unlimited
    branch_id: Optional[str] = None


class AddBus(BaseModel):
    """A new bus. It starts unconnected; add lines (and optionally a generator) to tie it in.
    `x`/`y` are its position in the diagram and don't affect the solve."""
    op: Literal["add_bus"] = "add_bus"
    bus_id: Optional[int] = Field(None, gt=0)  # default: one more than the largest bus ID
    load_mw: float = 0.0
    area: int = 1
    base_kv: float = 0.0
    name: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None


class AddGenerator(BaseModel):
    op: Literal["add_generator"] = "add_generator"
    bus_id: int
    p_max_mw: float = Field(ge=0)
    p_min_mw: float = 0.0
    offer_price: float = 0.0
    cost_c2: float = Field(0.0, ge=0)
    in_service: bool = True
    generator_id: Optional[str] = None  # default: next free "G{n}"


class SetLoad(BaseModel):
    op: Literal["set_load"] = "set_load"
    bus_id: int
    load_mw: float


class ScaleLoad(BaseModel):
    """Multiply every bus load (optionally only within one area) by `factor`."""
    op: Literal["scale_load"] = "scale_load"
    factor: float = Field(ge=0)
    area: Optional[int] = None


class SetGenerator(BaseModel):
    op: Literal["set_generator"] = "set_generator"
    generator_id: str
    in_service: Optional[bool] = None
    p_min_mw: Optional[float] = None
    p_max_mw: Optional[float] = None
    offer_price: Optional[float] = None
    cost_c2: Optional[float] = None


Edit = Annotated[
    Union[SetBranchStatus, SetBranchParams, AddBranch, AddBus, AddGenerator, SetLoad, ScaleLoad,
          SetGenerator],
    Field(discriminator="op"),
]


class Scenario(BaseModel):
    base_case: str
    edits: list[Edit] = []
    name: Optional[str] = None


# --------------------------------------------------------------------------- apply

@lru_cache(maxsize=16)
def _base_network(case_id: str) -> Network:
    return load_case(case_id)


def base_network(case_id: str) -> Network:
    """A private copy of a bundled case."""
    try:
        return copy.deepcopy(_base_network(case_id))
    except FileNotFoundError as e:
        raise UnknownCaseError(str(e)) from e


def apply_scenario(scenario: Scenario) -> Network:
    net = base_network(scenario.base_case)
    for i, edit in enumerate(scenario.edits):
        try:
            _apply(net, edit)
        except ScenarioError as e:
            raise ScenarioError(f"Edit {i} ({edit.op}): {e}", edit_index=i) from e
        except (KeyError, ValueError) as e:
            raise ScenarioError(f"Edit {i} ({edit.op}): {e}", edit_index=i) from e
    # Re-run Network validation (unique IDs, bus references, zero reactance)
    try:
        net.__post_init__()
    except ValueError as e:
        raise ScenarioError(str(e)) from e
    return net


def _apply(net: Network, edit) -> None:
    if isinstance(edit, SetBranchStatus):
        _branch(net, edit.branch_id).in_service = edit.in_service

    elif isinstance(edit, SetBranchParams):
        br = _branch(net, edit.branch_id)
        if edit.reactance_pu is not None:
            if edit.reactance_pu == 0:
                raise ScenarioError("reactance cannot be zero")
            br.reactance_pu = edit.reactance_pu
        if edit.unlimited:
            br.limit_mw = math.inf
        elif edit.limit_mw is not None:
            br.limit_mw = edit.limit_mw

    elif isinstance(edit, AddBranch):
        for b in (edit.from_bus, edit.to_bus):
            if b not in net.bus_index:
                raise ScenarioError(f"unknown bus {b}")
        if edit.from_bus == edit.to_bus:
            raise ScenarioError("from_bus and to_bus must differ")
        if edit.reactance_pu == 0:
            raise ScenarioError("reactance cannot be zero")
        branch_id = edit.branch_id or _next_branch_id(net)
        if any(b.branch_id == branch_id for b in net.branches):
            raise ScenarioError(f"branch {branch_id} already exists")
        net.branches.append(Branch(
            branch_id=branch_id,
            from_bus=edit.from_bus,
            to_bus=edit.to_bus,
            reactance_pu=edit.reactance_pu,
            limit_mw=edit.limit_mw if edit.limit_mw is not None else math.inf,
        ))

    elif isinstance(edit, AddBus):
        bus_id = edit.bus_id if edit.bus_id is not None else max(net.bus_index, default=0) + 1
        if bus_id in net.bus_index:
            raise ScenarioError(f"bus {bus_id} already exists")
        net.buses.append(Bus(bus_id=bus_id, load_mw=edit.load_mw, name=edit.name, area=edit.area,
                             base_kv=edit.base_kv, x=edit.x, y=edit.y))
        net.bus_index[bus_id] = len(net.buses) - 1  # later edits in this scenario may reference it

    elif isinstance(edit, AddGenerator):
        if edit.bus_id not in net.bus_index:
            raise ScenarioError(f"unknown bus {edit.bus_id}")
        if edit.p_min_mw > edit.p_max_mw:
            raise ScenarioError(f"p_min_mw ({edit.p_min_mw}) exceeds p_max_mw ({edit.p_max_mw})")
        existing = {g.generator_id for g in net.generators}
        gen_id = edit.generator_id
        if gen_id is None:
            n = len(net.generators) + 1
            while f"G{n}" in existing:
                n += 1
            gen_id = f"G{n}"
        elif gen_id in existing:
            raise ScenarioError(f"generator {gen_id} already exists")
        net.generators.append(Generator(
            generator_id=gen_id, bus_id=edit.bus_id, p_min_mw=edit.p_min_mw, p_max_mw=edit.p_max_mw,
            offer_price=edit.offer_price, cost_c2=edit.cost_c2, in_service=edit.in_service,
        ))

    elif isinstance(edit, SetLoad):
        if edit.bus_id not in net.bus_index:
            raise ScenarioError(f"unknown bus {edit.bus_id}")
        net.buses[net.bus_index[edit.bus_id]].load_mw = edit.load_mw

    elif isinstance(edit, ScaleLoad):
        for bus in net.buses:
            if edit.area is None or bus.area == edit.area:
                bus.load_mw *= edit.factor

    elif isinstance(edit, SetGenerator):
        gen = next((g for g in net.generators if g.generator_id == edit.generator_id), None)
        if gen is None:
            raise ScenarioError(f"unknown generator {edit.generator_id}")
        for field in ("in_service", "p_min_mw", "p_max_mw", "offer_price", "cost_c2"):
            value = getattr(edit, field)
            if value is not None:
                setattr(gen, field, value)
        if gen.p_min_mw > gen.p_max_mw:
            raise ScenarioError(f"p_min_mw ({gen.p_min_mw}) exceeds p_max_mw ({gen.p_max_mw})")

    else:  # pragma: no cover - guarded by the discriminated union
        raise ScenarioError(f"unsupported edit {edit!r}")


def _branch(net: Network, branch_id: str) -> Branch:
    try:
        return net.branch(branch_id)
    except KeyError:
        raise ScenarioError(f"unknown branch {branch_id}") from None


def _next_branch_id(net: Network) -> str:
    n = len(net.branches) + 1
    existing = {b.branch_id for b in net.branches}
    while f"L{n}" in existing:
        n += 1
    return f"L{n}"
