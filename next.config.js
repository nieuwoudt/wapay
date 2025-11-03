/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure Next.js can find pages in the root
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  
  // Transpile workspace packages
  transpilePackages: [
    '@wapay/providers-blu',
    '@wapay/providers-yoyo',
    '@wapay/domain',
    '@wapay/ledger',
    '@wapay/utils',
    '@wapay/whatsapp',
    '@wapay/nlp',
  ],
  
  // Webpack configuration for monorepo
  webpack: (config, { isServer }) => {
    // Handle ESM packages
    config.resolve.extensionAlias = {
      '.js': ['.js', '.ts'],
      '.jsx': ['.jsx', '.tsx'],
    };
    
    return config;
  },
}

module.exports = nextConfig

