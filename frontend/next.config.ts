import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Local models can take minutes to generate a longer answer on CPU.
    proxyTimeout: 360_000,
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const api = (process.env.ASTRA_API_PROXY_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
