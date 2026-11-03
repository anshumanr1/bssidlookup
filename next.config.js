/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile mapbox-gl for Next.js compatibility
  transpilePackages: ['mapbox-gl'],

  // Experimental features for better map performance
  experimental: {
    optimizePackageImports: ['mapbox-gl', 'react-map-gl/mapbox', '@deck.gl/react']
  },

  // Open the Neighbour Locator by default instead of the WaveDigger home page
  async redirects() {
    return [
      { source: '/', destination: '/bssid-neighbour-locator.html', permanent: false },
    ];
  },
};

module.exports = nextConfig;
