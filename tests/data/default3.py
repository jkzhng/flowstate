from src.models import Bus, Generator, Branch

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
        limit_mw=100.0,
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