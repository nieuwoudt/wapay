/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure Next.js can find pages in the root
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],

  // Short pay-link domains: pleasepayme.co.za/PRXXXXXX and wa-pay.me/PRXXXXXX
  // serve the pay page directly once attached to this Vercel project.
  // Codes are strictly PR + 6 letters, so nothing else collides at the root.
  // NAMING NOTE (2026-08-22): "Please Pay Me" is also Capitec's product name
  // — founder decision to run the domain anyway; the PRODUCT stays branded
  // WaPay everywhere (domain = link only), and a CIPC trademark search is on
  // the counsel list. Founder owns both domains (GoDaddy).
  async rewrites() {
    return [
      {
        source: '/:code(PR[A-Za-z]{6})',
        has: [{ type: 'host', value: '(^|\\.)(pleasepayme\\.co\\.za|wa-pay\\.me)$' }],
        destination: '/pay/:code',
      },
    ];
  },
  
  // Transpile workspace packages
  transpilePackages: [
    '@wapay/ai',
    '@wapay/auth',
    '@wapay/providers-blu',
    '@wapay/providers-yoyo',
    '@wapay/domain',
    '@wapay/ledger',
    '@wapay/utils',
    '@wapay/whatsapp',
    '@wapay/nlp',
  ],
  
  // Mark server-only packages as external
  experimental: {
    serverComponentsExternalPackages: ['argon2', '@prisma/client', 'prisma'],
  },
  
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
      '@wapay/auth': require.resolve('./packages/auth/dist/index.js'),
      '@wapay/providers-blu': require.resolve('./packages/providers/blu/dist/index.js'),
      '@wapay/providers-yoyo': require.resolve('./packages/providers/yoyo/dist/index.js'),
    };
    
    // Exclude native modules from client-side bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        'argon2': false,
        'fs': false,
        'net': false,
        'tls': false,
        'crypto': false,
      };
    }
    
    // Always externalize argon2 and its dependencies
    config.externals = config.externals || [];
    if (Array.isArray(config.externals)) {
      config.externals.push(
        'argon2',
        '@mapbox/node-pre-gyp',
        'mock-aws-s3',
        'aws-sdk',
        'nock'
      );
    }
    
    return config;
  },
}

module.exports = nextConfig

