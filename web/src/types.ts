// SPDX-License-Identifier: AGPL-3.0-or-later

export type NodeType = "note" | "episode" | "entity";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  scope: string | null;
  kind: string | null;
  trust: string | null;
  status: string | null;
  importance: number;
  agent: string | null;
  provider: string | null;
  t: string | null;
  weight: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface Stats {
  episodes: number;
  items: number;
  notes: number;
  blocks: number;
  pendingVectors: number;
  disputed: number;
  superseded: number;
  archived: number;
  entities: number;
  links: number;
  pendingJobs: number;
  lastReflection: string | null;
  bytes: number;
}

export interface Me {
  email: string;
  linked: boolean;
  stats?: Stats;
  scopes?: string[];
}

export interface MemoryItem {
  id: string;
  kind: "chunk" | "note";
  scope: string;
  content: string;
  noteKind: string | null;
  trust: string;
  agent: string;
  provider: string;
  episodeId: string | null;
  tEvent: string;
  status: string;
  origin: string;
  importance: number;
  confirmations: number;
  supersededBy: string | null;
  score?: number;
}

export interface SearchResult {
  items: MemoryItem[];
  tookMs: number;
  totalMs: number;
  sources: Record<string, number>;
  scopes: string[];
}

export interface Neighbour {
  id: string;
  direction: "in" | "out";
  kind: string;
  weight: number;
  type: string;
  label: string | null;
  scope: string | null;
  status: string | null;
  trust: string | null;
}

export type Detail =
  | { type: "note" | "chunk"; item: MemoryItem; neighbours: Neighbour[]; entities: { id: string; name: string; type: string }[]; accessCount: number }
  | {
      type: "episode";
      episode: { id: string; scope: string; agent: string; provider: string; model: string | null; tEvent: string; chars: number; messages: { role: string; content: string }[] | null; text: string | null };
      neighbours: Neighbour[];
      entities: { id: string; name: string; type: string }[];
    }
  | {
      type: "entity";
      entity: { id: string; name: string; type: string; mentions: number; firstSeen: string; lastSeen: string };
      mentions: { id: string; label: string; scope: string; type: string; t: string }[];
    };

export interface Block {
  scope: string;
  label: string;
  value: string;
  description: string | null;
  charLimit: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}
