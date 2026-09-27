import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server for apps/web/Dockerfile.
  output: "standalone",
  // Trace from the monorepo root so workspace packages land in the standalone output.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default nextConfig;
