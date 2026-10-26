-- Stores provisioned from the dashboard. This is the desired state; the store-provisioner reconciles the
-- cluster towards it (namespace, Secrets, Helm release, gateway registration) and reports progress here.
CREATE TABLE stores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,17}$'),
  name           text NOT NULL,
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  namespace      text NOT NULL UNIQUE,
  host           text NOT NULL,
  status         text NOT NULL DEFAULT 'provisioning'
                 CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
  status_reason  text,
  -- Provisioning that has not finished by this time is marked failed (guardrail and recovery bound).
  deadline_at    timestamptz NOT NULL,
  attempt        integer NOT NULL DEFAULT 1,
  -- Work lease: a provisioner holds a store while working on it; after a crash the lease expires and the
  -- store is picked up again, so provisioning either completes or fails by its deadline.
  lease_owner    text,
  lease_until    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  ready_at       timestamptz
);
CREATE INDEX stores_owner_idx ON stores (owner_id);
CREATE INDEX stores_work_idx ON stores (status, lease_until) WHERE status IN ('provisioning', 'deleting');
