from src.models import Bus, Generator, Branch
from src.network import build_susceptance_matrix
from src.dc_power_flow import solve_voltage_angles, calculate_line_flows

import numpy as np

BASE_MVA = 100.0

BUSES = [
    Bus(bus_id=1, load_mw=0.0),
    Bus(bus_id=2, load_mw=0.0),
    Bus(bus_id=3, load_mw=150.0),
]

GENERATORS = [
    Generator(
        generator_id="G1",
        bus_id=1,
        p_min_mw=0.0,
        p_max_mw=200.0,
        offer_price=20.0,
    ),
    Generator(
        generator_id="G2",
        bus_id=2,
        p_min_mw=0.0,
        p_max_mw=200.0,
        offer_price=50.0,
    ),
]

BRANCHES = [
    Branch(
        from_bus=1,
        to_bus=2,
        reactance_pu=0.10,
        limit_mw=100.0,
    ),
    Branch(
        from_bus=1,
        to_bus=3,
        reactance_pu=0.20,
        limit_mw=70.0,
    ),
    Branch(
        from_bus=2,
        to_bus=3,
        reactance_pu=0.25,
        limit_mw=100.0,
    ),
]

# Bus order: 1, 2, 3
# Positive = injection; negative = withdrawal
injections_mw = [100.0, 50.0, -150.0]

print(build_susceptance_matrix(BUSES,BRANCHES))

theta = solve_voltage_angles(BUSES,BRANCHES,injections_mw,BASE_MVA,reference_bus_id=1)
lfs = calculate_line_flows(BUSES,BRANCHES,theta,BASE_MVA)
print(lfs)

from src.dc_opf import solve_dc_opf

results = solve_dc_opf(
    buses=BUSES,
    generators=GENERATORS,
    branches=BRANCHES,
    base_mva=BASE_MVA,
    reference_bus_id=1
)

print("Status:", results["status"])
print(f"Total cost: ${results['total_cost']:.2f}/h")

print("\nGeneration:")
for name, mw in results["generation_mw"].items():
    print(f"  {name}: {mw:.2f} MW")
print("Angles:", results["voltage_angles_rad"])

print("\nLine flows:")
for line in results["line_flows"]:
    print(
        f"  {line['from_bus']} -> {line['to_bus']}: "
        f"{line['flow_mw']:.2f} MW "
        f"({line['loading_percent']:.1f}% loaded)"
    )

print(results["lmps"])