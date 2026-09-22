/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Phase 1 runs `next dev` against the deployed API. CloudFront + S3 hosting
  // (static export) comes with the hosting work, not the skeleton.
};

export default nextConfig;
