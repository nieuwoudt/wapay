import { getPrisma } from './db.js';

export async function upsertProviderRequest(
  args: {
    idemKey: string;
    provider: string;
    route: string;
    status?: string;
    providerRef?: string | null;
    redactedPayload?: string | null;
    responseJson?: unknown;
  },
): Promise<void> {
  const prisma = getPrisma();
  await prisma.providerRequest.upsert({
    where: { idemKey: args.idemKey },
    create: {
      idemKey: args.idemKey,
      provider: args.provider,
      route: args.route,
      status: args.status ?? 'PENDING',
      providerRef: args.providerRef ?? undefined,
      redactedPayload: args.redactedPayload ?? undefined,
      responseJson:
        args.responseJson === undefined ? undefined : JSON.stringify(args.responseJson),
    },
    update: {
      status: args.status ?? undefined,
      providerRef: args.providerRef ?? undefined,
      redactedPayload: args.redactedPayload ?? undefined,
      responseJson:
        args.responseJson === undefined ? undefined : JSON.stringify(args.responseJson),
    },
  });
}

export async function getCachedResponseByIdemKey<T>(
  idemKey: string,
): Promise<{ response: T; providerRef?: string } | null> {
  const prisma = getPrisma();
  const rec = await prisma.providerRequest.findUnique({ where: { idemKey } });
  if (!rec || !rec.responseJson) return null;
  try {
    const response = JSON.parse(rec.responseJson) as T;
    return { response, providerRef: rec.providerRef ?? undefined };
  } catch {
    return null;
  }
}


