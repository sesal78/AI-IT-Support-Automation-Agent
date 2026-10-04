// Clean twin of ../semgrep-bad/handler.ts for the Semgrep self-test: no `eval`.
interface Req {
  query: Record<string, string>;
}
interface Res {
  send(body: unknown): void;
}

export function handler(req: Req, res: Res): void {
  res.send(String(req.query.code).length);
}
