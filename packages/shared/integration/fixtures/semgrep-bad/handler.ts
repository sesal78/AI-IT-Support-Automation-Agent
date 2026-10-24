// Seeded finding for the Semgrep self-test: request data reaches `eval`.
// Never imported. `.semgrepignore` keeps this folder out of the repo scan.
interface Req {
  query: Record<string, string>;
}
interface Res {
  send(body: unknown): void;
}

export function handler(req: Req, res: Res): void {
  res.send(eval(String(req.query.code)));
}
