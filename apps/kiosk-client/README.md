# Kiosk client

Status: planned UI and device integration; the operating system and terminal/cash hardware remain to be confirmed.

Use shared public catalog/quote/order APIs. Bind the kiosk to a unique revocable device identity, authenticated merchant context and short-lived customer sessions. Treat local prices as display values; the backend authorizes the charge.

Cached catalog browsing is possible; the initial monetary flow requires online confirmation. Before cash intake, obtain a valid quote and define recovery for accepted cash if payment or fulfillment cannot complete. Clear personal data between users.

Hardware integrations belong in a separately permissioned device agent where needed. General browser code must not receive provider credentials or raw card data.

