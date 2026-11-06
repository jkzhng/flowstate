import cytoscape, { type Core, type ElementDefinition, type EventObject } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef, useState } from "react";

import type { Theme } from "../colors";
import type { EffectiveNetwork } from "../edits";
import type { Encoding } from "../encoding";
import type { CaseData, Positions, Selection, Tool } from "../types";

cytoscape.use(fcose);

export interface TooltipContent {
  title: string;
  rows: { value: string; label: string }[];
}

interface Props {
  caseData: CaseData;
  net: EffectiveNetwork;
  encoding: Encoding;
  theme: Theme;
  selection: Selection;
  highlight: { outage: string | null; worst: string | null };
  relayoutToken: number;
  tool: Tool;
  pendingBus: number | null; // first bus picked while drawing a line
  describe: (sel: NonNullable<Selection>) => TooltipContent | null;
  /** Click on an element (or on empty canvas: target null) at a diagram position. */
  onTap: (target: Selection, position: { x: number; y: number }) => void;
  onPositionsChange: (p: Positions) => void;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Labels are sized in diagram units, so they grow when zoomed in. Above 1x zoom we shrink them
 * back so text stays at a steady on-screen size instead of swamping small cases.
 */
const labelScale = (zoom: number) => 1 / Math.max(1, zoom);

function stylesheet(t: Theme, k = 1): cytoscape.StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        width: "data(size)",
        height: "data(size)",
        shape: "data(shape)" as never,
        "border-width": 1,
        "border-color": t.ring,
        "border-opacity": 0.55,
        label: "data(label)",
        "font-family": FONT,
        "font-size": 10 * k,
        color: t.inkSecondary,
        "text-valign": "bottom",
        "text-margin-y": 3 * k,
        "text-wrap": "wrap",
        "line-height": 1.15,
        "text-background-color": t.surface,
        "text-background-opacity": 0.75,
        "text-background-padding": "1px",
        "text-background-shape": "roundrectangle",
        "min-zoomed-font-size": 7,
        "overlay-opacity": 0,
      },
    },
    { selector: "node.nolmp", style: { "border-style": "dashed", "border-opacity": 1 } },
    {
      selector: "edge",
      style: {
        "line-color": "data(color)",
        width: "data(width)",
        "curve-style": "bezier",
        "target-arrow-shape": "data(arrowT)" as never,
        "source-arrow-shape": "data(arrowS)" as never,
        "target-arrow-color": "data(color)",
        "source-arrow-color": "data(color)",
        "arrow-scale": 0.75,
        "overlay-opacity": 0,
        label: "data(label)",
        "font-family": FONT,
        "font-size": 9 * k,
        color: t.inkSecondary,
        "text-background-color": t.surface,
        "text-background-opacity": 0.85,
        "text-background-padding": "1px",
        "text-background-shape": "roundrectangle",
        "min-zoomed-font-size": 6,
      },
    },
    { selector: "edge.out", style: { "line-style": "dashed", "line-dash-pattern": [5, 4], opacity: 0.8 } },
    { selector: "edge.cont-outage", style: { "line-color": t.critical, "line-style": "dashed", width: 3, opacity: 1 } },
    {
      selector: "edge.cont-worst",
      style: { "underlay-color": t.critical, "underlay-padding": 5, "underlay-opacity": 0.3 },
    },
    {
      selector: "edge.sel",
      style: { "underlay-color": t.selection, "underlay-padding": 4, "underlay-opacity": 0.22 },
    },
    {
      selector: "node.sel",
      style: { "border-width": 3, "border-color": t.selection, "border-opacity": 1 },
    },
    {
      selector: "node.pending",
      style: { "border-width": 3, "border-color": t.selection, "border-style": "dashed", "border-opacity": 1 },
    },
    { selector: "node.hover", style: { "border-width": 2, "border-opacity": 1 } },
    { selector: "edge.hover", style: { "underlay-color": t.ink, "underlay-padding": 3, "underlay-opacity": 0.12 } },
  ];
}

function positionsOf(cy: Core): Positions {
  const out: Positions = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    out[n.data("busId")] = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
  });
  return out;
}

function runForceLayout(cy: Core, animate: boolean, done: () => void) {
  const layout = cy.layout({
    name: "fcose",
    quality: "proof",
    randomize: true,
    animate,
    animationDuration: 600,
    nodeSeparation: 70,
    idealEdgeLength: 45,
    nodeRepulsion: 6500,
    padding: 30,
  } as cytoscape.LayoutOptions);
  layout.one("layoutstop", done);
  layout.run();
}

export function NetworkView(props: Props) {
  const { caseData, net, encoding, theme, selection, highlight, relayoutToken, tool, pendingBus } = props;
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const scaleRef = useRef(1);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; sel: NonNullable<Selection> } | null>(null);

  // Latest callbacks without re-creating the graph
  const cb = useRef(props);
  cb.current = props;

  // ---- build the graph when the case changes
  useEffect(() => {
    if (!container.current) return;
    const saved = caseData.layout;
    const hasLayout = saved != null && caseData.buses.every((b) => saved[String(b.bus_id)]);

    const elements: ElementDefinition[] = [
      ...caseData.buses.map((b) => ({
        group: "nodes" as const,
        // style fields are filled in up front so the stylesheet's data() mappings always resolve
        data: {
          id: `b${b.bus_id}`,
          busId: String(b.bus_id),
          ...nodeData(cb.current.encoding, b.bus_id),
        },
        position: hasLayout ? { ...saved![String(b.bus_id)] } : undefined,
      })),
      ...caseData.branches.map((br) => ({
        group: "edges" as const,
        data: {
          id: `e${br.branch_id}`,
          branchId: br.branch_id,
          source: `b${br.from_bus}`,
          target: `b${br.to_bus}`,
          ...edgeData(cb.current.encoding, br.branch_id),
        },
      })),
    ];

    const cy = cytoscape({
      container: container.current,
      elements,
      style: stylesheet(cb.current.theme),
      layout: hasLayout ? { name: "preset", fit: true, padding: 30 } : { name: "null" },
      minZoom: 0.15,
      maxZoom: 5,
      boxSelectionEnabled: false,
      autoungrabify: false,
    });
    cyRef.current = cy;
    scaleRef.current = 1;
    let frame = 0;
    const rescale = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const k = labelScale(cy.zoom());
        if (Math.abs(k - scaleRef.current) / scaleRef.current < 0.04) return;
        scaleRef.current = k;
        cy.style(stylesheet(cb.current.theme, k));
      });
    };
    cy.on("zoom", rescale);
    if (import.meta.env.DEV) (window as unknown as { __flowstateCy?: Core }).__flowstateCy = cy; // for UI tests
    applyEncoding(cy, cb.current.encoding);

    // Fit again once the container has its final size (the first fit can run before layout settles)
    const refit = hasLayout
      ? requestAnimationFrame(() => {
          cy.resize().fit(undefined, 30);
          rescale();
        })
      : 0;
    if (!hasLayout) {
      runForceLayout(cy, false, () => {
        cy.fit(undefined, 30);
        rescale();
        cb.current.onPositionsChange(positionsOf(cy));
      });
    }

    const toSelection = (e: EventObject): NonNullable<Selection> | null => {
      const t = e.target;
      if (t === cy || !t.isNode) return null;
      return t.isNode() ? { kind: "bus", id: Number(t.data("busId")) } : { kind: "branch", id: t.data("branchId") };
    };

    cy.on("tap", (e) => cb.current.onTap(toSelection(e), e.position));
    cy.on("mouseover", "node, edge", (e) => {
      e.target.addClass("hover");
      const sel = toSelection(e);
      if (sel && e.renderedPosition) setTooltip({ ...e.renderedPosition, sel });
    });
    cy.on("mousemove", "node, edge", (e) => {
      if (e.renderedPosition) {
        const { x, y } = e.renderedPosition;
        setTooltip((t) => (t ? { ...t, x, y } : t));
      }
    });
    cy.on("mouseout", "node, edge", (e) => {
      e.target.removeClass("hover");
      setTooltip(null);
    });
    cy.on("dragfree", "node", () => cb.current.onPositionsChange(positionsOf(cy)));
    cy.on("pan zoom", () => setTooltip(null));

    return () => {
      cancelAnimationFrame(refit);
      cancelAnimationFrame(frame);
      cy.destroy();
      cyRef.current = null;
      setTooltip(null);
    };
  }, [caseData]);

  // ---- add/remove the buses and lines that scenario edits created
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const enc = cb.current.encoding;
    cy.batch(() => {
      cy.nodes("[?added]").forEach((n) => {
        if (!net.added.buses.has(Number(n.data("busId")))) n.remove(); // takes its lines with it
      });
      cy.edges("[?added]").forEach((e) => {
        if (!net.added.branches.has(e.data("branchId"))) e.remove();
      });
      const ext = cy.extent();
      for (const id of net.added.buses) {
        const bus = net.buses.get(id)!;
        const pos = bus.x != null && bus.y != null ? { x: bus.x, y: bus.y } : null;
        const node = cy.$id(`b${id}`);
        if (node.empty()) {
          cy.add({
            group: "nodes",
            data: { id: `b${id}`, busId: String(id), added: true, ...nodeData(enc, id) },
            position: pos ?? { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 },
          });
        } else if (pos) {
          const p = node.position();
          if (Math.abs(p.x - pos.x) > 0.5 || Math.abs(p.y - pos.y) > 0.5) node.position(pos);
        }
      }
      for (const id of net.added.branches) {
        const br = net.branches.get(id)!;
        if (cy.$id(`e${id}`).nonempty()) continue;
        if (cy.$id(`b${br.from_bus}`).empty() || cy.$id(`b${br.to_bus}`).empty()) continue;
        cy.add({
          group: "edges",
          data: {
            id: `e${id}`,
            branchId: id,
            added: true,
            source: `b${br.from_bus}`,
            target: `b${br.to_bus}`,
            ...edgeData(enc, id),
          },
        });
      }
    });
  }, [net, caseData]);

  // ---- restyle on every result / view / theme change
  useEffect(() => {
    if (cyRef.current) applyEncoding(cyRef.current, encoding);
  }, [encoding]);

  useEffect(() => {
    cyRef.current?.style(stylesheet(theme, scaleRef.current));
  }, [theme]);

  // ---- selection & contingency highlight classes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("sel cont-outage cont-worst pending");
      if (pendingBus != null) cy.$id(`b${pendingBus}`).addClass("pending");
      if (selection?.kind === "bus") cy.$id(`b${selection.id}`).addClass("sel");
      if (selection?.kind === "branch") cy.$id(`e${selection.id}`).addClass("sel");
      if (highlight.outage) cy.$id(`e${highlight.outage}`).addClass("cont-outage");
      if (highlight.worst) cy.$id(`e${highlight.worst}`).addClass("cont-worst");
    });
  }, [selection, highlight, pendingBus, net, caseData]);

  // ---- explicit re-layout
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || relayoutToken === 0) return;
    runForceLayout(cy, true, () => cb.current.onPositionsChange(positionsOf(cy)));
  }, [relayoutToken]);

  // Rebuilt every render so the text tracks the latest solve, not the moment the pointer arrived
  const tooltipContent = tooltip ? props.describe(tooltip.sel) : null;

  return (
    <div className="network">
      <div ref={container} className={`network-canvas tool-${tool}`} aria-label={`Network diagram of ${caseData.id}`} />
      <div className="network-controls">
        <button className="icon-btn" title="Zoom to fit" onClick={() => cyRef.current?.fit(undefined, 30)}>
          Fit
        </button>
      </div>
      {tooltipContent && tooltip && (
        <div
          className="tooltip"
          style={{ left: tooltip.x + 14, top: tooltip.y + 14 }}
          role="status"
        >
          <div className="tooltip-title">{tooltipContent.title}</div>
          {tooltipContent.rows.map((r, i) => (
            <div className="tooltip-row" key={i}>
              <strong>{r.value}</strong>
              <span>{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_NODE = { color: "#888888", size: 13, shape: "ellipse" };
const DEFAULT_EDGE = { color: "#888888", width: 1.5, arrowT: "none", arrowS: "none", label: "" };

function nodeData(enc: Encoding, busId: number) {
  const s = enc.nodes.get(busId);
  return s
    ? { color: s.color, size: s.size, shape: s.shape, label: s.label }
    : { ...DEFAULT_NODE, label: String(busId) };
}

function edgeData(enc: Encoding, branchId: string) {
  const s = enc.edges.get(branchId);
  return s ? { color: s.color, width: s.width, arrowT: s.arrowT, arrowS: s.arrowS, label: s.label } : DEFAULT_EDGE;
}

function applyEncoding(cy: Core, enc: Encoding) {
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const busId = Number(n.data("busId"));
      n.data(nodeData(enc, busId));
      n.toggleClass("nolmp", enc.nodes.get(busId)?.noLmp ?? false);
    });
    cy.edges().forEach((e) => {
      const branchId = e.data("branchId");
      e.data(edgeData(enc, branchId));
      e.toggleClass("out", enc.edges.get(branchId)?.out ?? false);
    });
  });
}
