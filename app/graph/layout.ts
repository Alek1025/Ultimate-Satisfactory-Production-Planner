/**
 * ELK layered layout in its own Web Worker (elkjs' intended setup: elk-api on this side,
 * elk-worker in a classic worker). Top-to-bottom, orthogonal edges, raw resources pinned
 * to the first layer and deliveries/surplus to the last.
 */
import ELK from 'elkjs/lib/elk-api.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { LayoutInput, LayoutOutput } from '../engine/protocol';

let elk: InstanceType<typeof ELK> | undefined;
const getElk = () => (elk ??= new ELK({ workerFactory: () => new Worker(elkWorkerUrl) }));

export async function layoutGraph(g: LayoutInput): Promise<LayoutOutput> {
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.layered.spacing.edgeNodeBetweenLayers': '18',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=40,left=36,bottom=36,right=36]',
    },
    children: g.nodes.map((n) => ({
      id: n.id, width: n.w, height: n.h,
      ...(n.layer ? { layoutOptions: { 'elk.layered.layering.layerConstraint': n.layer === 'first' ? 'FIRST' : 'LAST' } } : {}),
    })),
    edges: g.edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const out = await getElk().layout(root);
  const nodes: LayoutOutput['nodes'] = {};
  for (const c of out.children ?? []) nodes[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  const edges: LayoutOutput['edges'] = {};
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const pts: [number, number][] = [];
    for (const s of e.sections ?? []) {
      pts.push([s.startPoint.x, s.startPoint.y]);
      for (const b of s.bendPoints ?? []) pts.push([b.x, b.y]);
      pts.push([s.endPoint.x, s.endPoint.y]);
    }
    edges[e.id] = { points: pts };
  }
  return { nodes, edges, width: out.width ?? 0, height: out.height ?? 0 };
}
