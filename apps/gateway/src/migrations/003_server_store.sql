-- The store a server was provisioned for. Its owner may use the server's admin-only tools (broker.ts).
-- Set only by the store-provisioner when it registers the server; NULL for servers an admin registered.
-- Deleting the store unlinks the server, so no ownership grant can outlive the store.
ALTER TABLE upstream_servers ADD COLUMN store_id uuid REFERENCES stores (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX upstream_servers_store_idx ON upstream_servers (store_id);

-- Servers registered before this column existed. A matching slug and creation time do not prove anything (an
-- admin may register "store-<slug>" by hand), so a server is linked only if it is that store's own MCP server:
-- the exact URL the provisioner registers, the MCP Service inside the store's namespace (only that store's
-- WooCommerce MCP server answers there). Anything else stays unlinked and grants the owner nothing.
UPDATE upstream_servers us SET store_id = s.id
FROM stores s
WHERE us.slug = 'store-' || s.slug
  AND us.created_at >= s.created_at
  AND us.url = 'http://woocommerce-mcp.' || s.namespace || '.svc.cluster.local:8080/mcp';
