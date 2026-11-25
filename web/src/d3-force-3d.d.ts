// SPDX-License-Identifier: AGPL-3.0-or-later
declare module "d3-force-3d" {
  export interface SimNode {
    id: string;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
    index?: number;
  }
  export interface SimLink<N extends SimNode> {
    source: string | N;
    target: string | N;
    [key: string]: unknown;
  }
  export interface Force {
    (alpha: number): void;
  }
  export interface Simulation<N extends SimNode> {
    tick(iterations?: number): this;
    stop(): this;
    alpha(): number;
    alpha(a: number): this;
    alphaDecay(d: number): this;
    alphaTarget(t: number): this;
    velocityDecay(d: number): this;
    force(name: string, f: unknown): this;
    nodes(): N[];
  }
  export function forceSimulation<N extends SimNode>(nodes?: N[], numDimensions?: number): Simulation<N>;
  export function forceLink<N extends SimNode>(links?: SimLink<N>[]): {
    id(fn: (n: N) => string): ReturnType<typeof forceLink<N>>;
    distance(fn: number | ((l: SimLink<N>) => number)): ReturnType<typeof forceLink<N>>;
    strength(fn: number | ((l: SimLink<N>) => number)): ReturnType<typeof forceLink<N>>;
  };
  export function forceManyBody(): { strength(s: number | ((n: SimNode) => number)): ReturnType<typeof forceManyBody>; distanceMax(d: number): ReturnType<typeof forceManyBody> };
  export function forceCenter(x?: number, y?: number, z?: number): unknown;
  export function forceCollide(r?: number | ((n: SimNode) => number)): unknown;
}
