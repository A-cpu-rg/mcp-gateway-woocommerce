#!/bin/sh
# Idempotent store setup, run by the setup Job (official wordpress:cli image) on every install/upgrade.
# Every step converges to the desired state, so re-running it is safe.
set -eu
WP="${WP_CLI:-wp} --path=${WP_PATH:-/var/www/html}"

echo "waiting for WordPress files and database"
until [ -f "${WP_PATH:-/var/www/html}/wp-config.php" ]; do sleep 3; done
until $WP db query "SELECT 1" >/dev/null 2>&1; do sleep 3; done

if ! $WP core is-installed 2>/dev/null; then
  $WP core install --url="$WP_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi
# The URL is configuration (values-local vs values-prod), so always converge it.
$WP option update home "$WP_URL"
$WP option update siteurl "$WP_URL"
$WP rewrite structure '/%postname%/'

$WP plugin is-installed woocommerce || $WP plugin install woocommerce --version="$WC_VERSION"
$WP plugin is-active woocommerce || $WP plugin activate woocommerce

# Store basics: currency, live storefront (WooCommerce starts new stores in "coming soon" mode), no wizard.
$WP option update woocommerce_currency "$STORE_CURRENCY"
$WP option update woocommerce_default_country "$STORE_COUNTRY"
$WP option update woocommerce_coming_soon no
$WP option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
$WP wc tool run install_pages --user="$WP_ADMIN_USER" >/dev/null

# Test-friendly checkout: Cash on delivery + free shipping everywhere.
$WP option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json
if ! $WP wc shipping_zone_method list 0 --user="$WP_ADMIN_USER" --field=method_id | grep -q free_shipping; then
  $WP wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --user="$WP_ADMIN_USER" >/dev/null
fi

# REST API key for the MCP server. The key comes from a Kubernetes Secret (single source of truth);
# delete + insert makes rotating the Secret take effect on the next helm upgrade.
$WP eval '
global $wpdb;
$table = $wpdb->prefix . "woocommerce_api_keys";
$ck = getenv("WC_CONSUMER_KEY"); $cs = getenv("WC_CONSUMER_SECRET");
$user = get_user_by("login", getenv("WP_ADMIN_USER"));
$wpdb->delete($table, array("description" => "mcp-server"));
$wpdb->insert($table, array(
  "user_id" => $user->ID, "description" => "mcp-server", "permissions" => "read_write",
  "consumer_key" => wc_api_hash($ck), "consumer_secret" => $cs, "truncated_key" => substr($ck, -7),
));
echo "api key ready\n";
'
echo "store bootstrap complete"
