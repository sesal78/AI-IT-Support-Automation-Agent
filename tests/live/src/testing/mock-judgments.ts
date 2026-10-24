import type { MockReply, MockRequest } from "./mock-e2e.ts";

/** What the mock does with the nth (1-based) judgment: a value, a failure, or never finishing. */
export type MockJudgment = number | "failed" | "pending" | "bad_shape";

/**
 * An `override` for startMockE2e that answers the judgment endpoints:
 * `POST /api/internal/judgments` gives 202 `{ runId }` and
 * `GET /api/internal/judgments/:runId` gives the scripted state of that run.
 * `bodies` collects the parsed POST bodies in order.
 */
export function mockJudgments(outcome: (n: number, body: unknown) => MockJudgment) {
  const bodies: unknown[] = [];
  const scripted = new Map<string, MockJudgment>();
  const override = (request: MockRequest): MockReply | undefined => {
    if (!request.path.startsWith("/api/internal/judgments")) return undefined;
    if (!request.accessOk || !request.bearerOk) return { status: 401, json: { error: "x" } };
    if (request.method === "POST" && request.path === "/api/internal/judgments") {
      const body: unknown = JSON.parse(request.body);
      bodies.push(body);
      const runId = `run_mock${bodies.length}`;
      scripted.set(runId, outcome(bodies.length, body));
      return { status: 202, json: { runId } };
    }
    const runId = request.path.split("/").pop() ?? "";
    const result = scripted.get(runId);
    if (result === undefined) return { status: 404, json: { error: "not_found" } };
    if (result === "pending") return { status: 200, json: { status: "pending" } };
    if (result === "failed") return { status: 200, json: { status: "failed" } };
    if (result === "bad_shape") return { status: 200, json: { status: "completed" } };
    return { status: 200, json: { status: "completed", output: { type: "score", value: result } } };
  };
  return { override, bodies };
}
