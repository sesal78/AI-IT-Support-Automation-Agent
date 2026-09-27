import { env } from "@/env";

export function GET() {
  return Response.json({ status: "ok", version: env.APP_VERSION });
}
