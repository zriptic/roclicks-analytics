import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The generated Prisma client lives in src/ and has to be named explicitly.
  serverExternalPackages: ["@/generated/prisma"],
};

export default nextConfig;
