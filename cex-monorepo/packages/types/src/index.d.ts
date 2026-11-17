export declare enum Side {
    BUY = "BUY",
    SELL = "SELL"
}
export declare enum OrderType {
    LIMIT = "LIMIT",
    MARKET = "MARKET"
}
export declare enum OrderStatus {
    NEW = "NEW",
    REJECTED = "REJECTED",
    OPEN = "OPEN",
    PARTIALLY_FILLED = "PARTIALLY_FILLED",
    FILLED = "FILLED",
    CANCELLED = "CANCELLED"
}
export declare enum MarketStatus {
    ACTIVE = "ACTIVE",
    HALTED = "HALTED",
    DELISTED = "DELISTED"
}
export declare enum RejectCode {
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
    MARKET_NOT_ACTIVE = "MARKET_NOT_ACTIVE",
    INVALID_TICK = "INVALID_TICK",
    INVALID_LOT = "INVALID_LOT",
    BELOW_MIN_NOTIONAL = "BELOW_MIN_NOTIONAL",
    INVALID_FLAGS = "INVALID_FLAGS",
    POST_ONLY_WOULD_CROSS = "POST_ONLY_WOULD_CROSS",
    SELF_TRADE = "SELF_TRADE",
    DUPLICATE_ORDER = "DUPLICATE_ORDER",
    ORDER_NOT_FOUND = "ORDER_NOT_FOUND",
    NOT_OWNER = "NOT_OWNER"
}
export type CommandType = 'PLACE_ORDER' | 'CANCEL_ORDER' | 'DEPOSIT' | 'WITHDRAW_REQUEST' | 'WITHDRAW_COMPLETE' | 'WITHDRAW_REJECT' | 'MARKET_CONFIG' | 'HALT_MARKET' | 'RESUME_MARKET';
export type EventType = 'ORDER_ACCEPTED' | 'ORDER_REJECTED' | 'ORDER_PLACED' | 'ORDER_UPDATED' | 'ORDER_CANCELLED' | 'TRADE' | 'BALANCE_UPDATED' | 'DEPTH_DELTA' | 'MARKET_STATUS';
export interface Command {
    commandId: string;
    type: CommandType;
    userId?: string;
    ts: number;
    payload: Record<string, string | boolean>;
}
export interface Event {
    engineSeq: string;
    commandId: string;
    type: EventType;
    ts: number;
    data: Record<string, unknown>;
}
export interface MarketConfig {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    tickSize: string;
    lotSize: string;
    minNotional: string;
    makerFeeBps: number;
    takerFeeBps: number;
    status: MarketStatus;
}
export interface PlaceOrderRequest {
    market: string;
    side: Side;
    type: OrderType;
    price?: string;
    quantity?: string;
    quoteQuantity?: string;
    clientOrderId?: string;
    postOnly?: boolean;
    ioc?: boolean;
}
export interface OrderResponse {
    orderId: string;
    status: OrderStatus;
    filledQuantity: string;
    rejectCode?: RejectCode;
}
export interface ApiErrorResponse {
    code: string;
    message: string;
    requestId: string;
}
//# sourceMappingURL=index.d.ts.map