import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Graph, GraphBody, Group, Node } from "../../src/core/types.ts";
import { dependencies } from "../../src/core/schema.ts";
import type { PlannerCase } from "./cases.ts";

export async function verifyOutputs(scenario: PlannerCase, cwd: string): Promise<Record<string, boolean>> {
  const outcomes: Record<string, boolean> = {};
  for (const [file, expected] of Object.entries(scenario.expected)) {
    try { outcomes[file] = isDeepStrictEqual(JSON.parse(await readFile(join(cwd, file), "utf8")), expected); }
    catch { outcomes[file] = false; }
  }
  if (scenario.semantic) {
    const routes = scenario.expected["routes.json"] as Record<string, string>;
    for (const item of JSON.parse(scenario.files["messages.json"]!)) {
      for (const category of ["billing", "technical", "review"]) {
        const key = `${category}/${item.id}`;
        try {
          // Read even an unselected path: its absence, not short-circuiting, proves exclusivity.
          const text = await readFile(join(cwd, "work", category, `${item.id}.txt`), "utf8");
          outcomes[key] = category === routes[item.id] && text.trimEnd() === item.text;
        } catch (error) {
          outcomes[key] = (error as NodeJS.ErrnoException).code === "ENOENT" && category !== routes[item.id];
        }
      }
    }
  }
  return outcomes;
}

/** Detect a submitted continuation consuming semantic results, including foreach/repeat outputs. */
export function hasSemanticContinuation(graph: Graph): boolean {
  function containsJev(body: GraphBody, visited = new Set<string>()): boolean {
    return Object.values(body.nodes).some(n => n.type === "jev") || Object.values(body.groups ?? {}).some(group => {
      if (visited.has(group.template)) return false;
      const template = graph.templates?.[group.template];
      return template ? containsJev(template, new Set([...visited, group.template])) : false;
    });
  }
  return [graph, ...Object.values(graph.templates ?? {})].some(body => {
    const entries: Record<string, Node | Group> = { ...body.nodes, ...body.groups };
    const sources = new Set(Object.entries(entries).filter(([, n]) => "type" in n ? n.type === "jev" : containsJev(graph.templates![n.template]!)).map(([id]) => id));
    function consumesDecision(id: string, visited = new Set<string>()): boolean {
      if (sources.has(id)) return true;
      if (visited.has(id) || !entries[id]) return false;
      return dependencies(entries[id]!).some(parent => consumesDecision(parent, new Set([...visited, id])));
    }
    return Object.entries(body.nodes).some(([id, node]) => node.type === "bash" && consumesDecision(id));
  });
}
