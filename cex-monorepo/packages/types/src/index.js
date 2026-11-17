export var Side;
(function (Side) {
    Side["BUY"] = "BUY";
    Side["SELL"] = "SELL";
})(Side || (Side = {}));
export var OrderType;
(function (OrderType) {
    OrderType["LIMIT"] = "LIMIT";
    OrderType["MARKET"] = "MARKET";
})(OrderType || (OrderType = {}));
export var OrderStatus;
(function (OrderStatus) {
    OrderStatus["NEW"] = "NEW";
    OrderStatus["REJECTED"] = "REJECTED";
    OrderStatus["OPEN"] = "OPEN";
    OrderStatus["PARTIALLY_FILLED"] = "PARTIALLY_FILLED";
    OrderStatus["FILLED"] = "FILLED";
    OrderStatus["CANCELLED"] = "CANCELLED";
})(OrderStatus || (OrderStatus = {}));
export var MarketStatus;
(function (MarketStatus) {
    MarketStatus["ACTIVE"] = "ACTIVE";
    MarketStatus["HALTED"] = "HALTED";
    MarketStatus["DELISTED"] = "DELISTED";
})(MarketStatus || (MarketStatus = {}));
export var RejectCode;
(function (RejectCode) {
    RejectCode["INSUFFICIENT_FUNDS"] = "INSUFFICIENT_FUNDS";
    RejectCode["MARKET_NOT_ACTIVE"] = "MARKET_NOT_ACTIVE";
    RejectCode["INVALID_TICK"] = "INVALID_TICK";
    RejectCode["INVALID_LOT"] = "INVALID_LOT";
    RejectCode["BELOW_MIN_NOTIONAL"] = "BELOW_MIN_NOTIONAL";
    RejectCode["INVALID_FLAGS"] = "INVALID_FLAGS";
    RejectCode["POST_ONLY_WOULD_CROSS"] = "POST_ONLY_WOULD_CROSS";
    RejectCode["SELF_TRADE"] = "SELF_TRADE";
    RejectCode["DUPLICATE_ORDER"] = "DUPLICATE_ORDER";
    RejectCode["ORDER_NOT_FOUND"] = "ORDER_NOT_FOUND";
    RejectCode["NOT_OWNER"] = "NOT_OWNER";
})(RejectCode || (RejectCode = {}));
//# sourceMappingURL=index.js.map