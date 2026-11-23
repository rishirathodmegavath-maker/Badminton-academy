import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  // Do not announce the framework on every response.
  poweredByHeader: false,
  distDir:
    process.env.NODE_ENV === "development"
      ? ".next-webpack-dev"
      : ".next-redesign",
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // The application uses no camera, microphone, location, payment or USB API: say so, so nothing injected can ask.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          // A page that opens ours (or that we open) never shares a browsing context group with it.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};
export default config;
