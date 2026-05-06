/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next.js 14.x — keep heavy Node.js-only packages out of the client bundle
  experimental: {
    serverComponentsExternalPackages: [
      "nodemailer",
      "mongoose",
      "bcryptjs",
      "jsonwebtoken",
    ],
  },

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Prevent Node.js built-ins from breaking the browser bundle.
      // NOTE: do NOT stub out `crypto` — webpack 5 handles it natively
      // and stubbing it causes "Cannot read properties of undefined (reading 'call')".
      config.resolve.fallback = {
        ...config.resolve.fallback,
        net: false,
        tls: false,
        fs: false,
        dns: false,
        child_process: false,
        stream: false,
        http: false,
        https: false,
        zlib: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;


