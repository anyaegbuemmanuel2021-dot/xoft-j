import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';

/**
 * KnowledgeGraph — spec section 14. Real nodes + edges, file-persisted,
 * queryable — alongside vector memory, not a replacement for it. Vector
 * memory answers "what do I know about X" via semantic similarity; this
 * answers "what's connected to X" via explicit relationships (USER
 * works_on PROJECT contains TASK depends_on TASK).
 *
 * Node types are open strings (spec examples: USER, PERSON, PROJECT, GOAL,
 * TASK, EVENT, DOCUMENT, DECISION, PREFERENCE, CONVERSATION) — not
 * enforced as an enum, so this doesn't need updating every time a new kind
 * of thing needs representing.
 */
export class KnowledgeGraph {
  constructor({ dataDir = './data', sqliteStore = null }) {
    this._store = new JsonStore({ dataDir, fileName: 'knowledge_graph.json', kvKey: 'knowledge_graph', defaultValue: { nodes: [], edges: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  /** @param {string} type e.g. 'PROJECT' @param {string} label @param {object} [metadata] */
  addNode(type, label, metadata = {}) {
    const data = this._load();
    // De-dup on (type, label) — re-adding the same node returns the existing one.
    const existing = data.nodes.find((n) => n.type === type && n.label === label);
    if (existing) return existing;
    const node = { id: crypto.randomUUID(), type, label, metadata, createdAt: new Date().toISOString() };
    data.nodes.push(node);
    this._save(data);
    return node;
  }

  /** @param {string} fromId @param {string} relation e.g. 'works_on', 'depends_on', 'contains' @param {string} toId */
  addEdge(fromId, relation, toId) {
    const data = this._load();
    if (!data.nodes.find((n) => n.id === fromId) || !data.nodes.find((n) => n.id === toId)) {
      throw new Error('KnowledgeGraph: both fromId and toId must reference existing nodes');
    }
    const exists = data.edges.find((e) => e.from === fromId && e.relation === relation && e.to === toId);
    if (exists) return exists;
    const edge = { id: crypto.randomUUID(), from: fromId, relation, to: toId, createdAt: new Date().toISOString() };
    data.edges.push(edge);
    this._save(data);
    return edge;
  }

  getNode(id) {
    return this._load().nodes.find((n) => n.id === id) ?? null;
  }

  findNodes({ type, label } = {}) {
    return this._load().nodes.filter((n) => (type ? n.type === type : true) && (label ? n.label === label : true));
  }

  /** Every edge touching a node, in either direction, with the connected node resolved. */
  getRelated(nodeId) {
    const data = this._load();
    const outgoing = data.edges
      .filter((e) => e.from === nodeId)
      .map((e) => ({ direction: 'outgoing', relation: e.relation, node: data.nodes.find((n) => n.id === e.to) }));
    const incoming = data.edges
      .filter((e) => e.to === nodeId)
      .map((e) => ({ direction: 'incoming', relation: e.relation, node: data.nodes.find((n) => n.id === e.from) }));
    return [...outgoing, ...incoming];
  }

  /**
   * Breadth-first traversal up to maxDepth hops — for questions like "what's
   * connected to this project, and what's connected to those things."
   */
  traverse(nodeId, maxDepth = 2) {
    const visited = new Set([nodeId]);
    let frontier = [nodeId];
    const result = [];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];
      for (const id of frontier) {
        for (const rel of this.getRelated(id)) {
          if (!rel.node || visited.has(rel.node.id)) continue;
          visited.add(rel.node.id);
          result.push({ depth: depth + 1, relation: rel.relation, direction: rel.direction, node: rel.node });
          nextFrontier.push(rel.node.id);
        }
      }
      frontier = nextFrontier;
    }
    return result;
  }

  removeNode(id) {
    const data = this._load();
    data.nodes = data.nodes.filter((n) => n.id !== id);
    data.edges = data.edges.filter((e) => e.from !== id && e.to !== id); // drop dangling edges too
    this._save(data);
  }

  stats() {
    const data = this._load();
    return { nodeCount: data.nodes.length, edgeCount: data.edges.length };
  }
}
