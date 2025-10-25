export declare class YoyoClient {
    private base;
    private clientId;
    private clientSecret;
    private merchantId;
    private headers;
    issueGift(accountRef: string, openingBalanceCents: number): Promise<{
        yoyoAccountId: string;
        cardId: string;
    }>;
    topupGift(cardId: string, amountCents: number, idemKey: string): Promise<{
        providerRef: string;
    }>;
    giftBalance(cardId: string): Promise<{
        balanceCents: number;
    }>;
    issueTokenForGift({ accountId }: {
        accountId: string;
    }): Promise<{
        token: string;
        type: 'WICODE';
    }>;
    isRetailerSupported(retailer: string): Promise<boolean>;
}
