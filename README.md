# Flowstate

Visualize IEEE test systems, edit them, and see the effect on DC power flow, DC-OPF dispatch and LMPs.
FTR paper trading comes next.

## Run

Two terminals from the project root:

```
.venv/Scripts/python -m uvicorn src.api.app:create_app --factory --reload --port 8100
cd web && npm run dev
```

Open http://localhost:5180. API docs are at http://127.0.0.1:8100/docs.
(Ports avoid 8000/5173 so this can run beside other projects. Override the API target with `FLOWSTATE_API`.)

First-time setup:

```
.venv/Scripts/python -m pip install -r requirements-dev.txt
cd web && npm install
```

## Using the app

- Click a bus to change its load or its generators (in service, Pmax, offer). Click a line to trip or restore it,
  or to change its limit or reactance.
- Every edit re-solves the DC-OPF. Edits are listed in order; remove any of them, Undo (Ctrl+Z) or Reset.
- **Flows & prices**: line color = loading band, width = flow, arrows = direction; bus color = LMP relative to the median.
- **Change vs base**: line color/width = change in |flow|; bus color = change in LMP.
- **N-1**: trips each line with dispatch held fixed; click a row to highlight the outage (dashed) and its worst line.
- Drag buses to tidy the diagram; positions are saved per case. Re-layout recomputes them.

## Layout

| Path | What |
|---|---|
| `src/` | Engine: MATPOWER reader, DC matrices (PTDF/LODF), power flow, OPF, scenarios, N-1 |
| `src/api/` | FastAPI app and SQLite store (`data/flowstate.db`) |
| `web/` | React + TypeScript + Cytoscape.js frontend |
| `cases/` | pglib-opf IEEE 14/30/57/118/300-bus cases |
| `tests/` | Golden tests vs PYPOWER, scenario and API tests |

```
.venv/Scripts/python -m pytest
cd web && npm run build
```
