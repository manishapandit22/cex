# `@cex/money`

All monetary values use `bigint` scaled by `10^8`. Parse external decimal strings with
`toScaled` and format only at the boundary with `fromScaled`; do not use floating point.

Deposits with more than eight native decimal places are rounded down before crediting.
Fees and limit-buy locks use ceiling division, so they round up.
