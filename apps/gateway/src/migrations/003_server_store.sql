-- The store a server was provisioned for. Its owner may use the server's admin-only tools (broker.ts).
-- Set only by the store-provisioner when it registers the server; NULL for servers an admin registered.
-- Deleting the store unlinks the server, so no ownership grant can outlive the store.
ALTER TABLE upstream_servers ADD COLUMN store_id uuid REFERENCES stores (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX upstream_servers_store_idx ON upstream_servers (store_id);

-- Servers registered before this column existed. requestStore rejects a store whose server slug is already
-- taken, so a server with the store's slug registered after the store was requested is the provisioner's.
UPDATE upstream_servers us SET store_id = s.id
FROM stores s
WHERE us.slug = 'store-' || s.slug AND us.created_at >= s.created_at;
