/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure Next.js can find pages in the root
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  
  // Transpile workspace packages
  transpilePackages: [
    '@wapay/ai',
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
    
    // Add aliases for workspace packages to help webpack find them
    config.resolve.alias = {
      ...config.resolve.alias,
      '@wapay/domain': require.resolve('./packages/domain/dist/index.js'),
      '@wapay/ledger': require.resolve('./packages/ledger/dist/index.js'),
      '@wapay/utils': require.resolve('./packages/utils/dist/index.js'),
      '@wapay/whatsapp': require.resolve('./packages/whatsapp/dist/index.js'),
      '@wapay/nlp': require.resolve('./packages/nlp/dist/index.js'),
      '@wapay/ai': require.resolve('./packages/ai/dist/index.js'),
      '@wapay/providers-blu': require.resolve('./packages/providers/blu/dist/index.js'),
      '@wapay/providers-yoyo': require.resolve('./packages/providers/yoyo/dist/index.js'),
    };
    
    return config;
  },
}

module.exports = nextConfig

