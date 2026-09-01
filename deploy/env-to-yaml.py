"""Turn a dotenv file into the YAML env-vars file `gcloud run deploy` expects.

Written in Python rather than shell because the values include JSON blobs,
URLs and comma-separated scope lists, which shell quoting mangles.

Usage: env-to-yaml.py <env-file> <shop> [app-url] [key-prefix]

A key-prefix lets one env file serve several stores: with prefix "VIANISA_",
VIANISA_SHOPIFY_API_KEY supplies the value shipped as SHOPIFY_API_KEY. Keys
without a prefixed variant fall back to the unprefixed one, which is how the
shared Supabase, Klaviyo and Zoho credentials stay identical across stores.
"""
import json
import sys

# Everything the app reads via process.env, minus SHOPIFY_APP_URL and
# SHOPIFY_SHOP, which are supplied as arguments.
KEYS = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SCOPES",
    "SUPABASE_URL_STOREFRONT",
    "SUPABASE_SERVICE_ROLE_KEY_STOREFRONT",
    "KLAVIYO_API_KEY",
    "CRON_SECRET",
    "SERVICE_ACCOUNT_JSON",
    "ZOHO_CLIENT_ID",
    "ZOHO_CLIENT_SECRET",
    "ZOHO_REDIRECT_URI",
    "ZOHO_REFRESH_TOKEN",
    "ZOHO_ORG_ID",
    "RETURN_API_USERNAME",
    "RETURN_API_PASSWORD",
]

env_file, shop = sys.argv[1], sys.argv[2]
app_url = sys.argv[3] if len(sys.argv) > 3 else ""
prefix = sys.argv[4] if len(sys.argv) > 4 else ""

parsed = {}
with open(env_file, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        # Strip one layer of surrounding quotes if present.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        parsed[key.strip()] = value

out = {"NODE_ENV": "production", "SHOPIFY_SHOP": shop}
if app_url:
    out["SHOPIFY_APP_URL"] = app_url

for key in KEYS:
    # A store-specific value wins; otherwise fall back to the shared one.
    value = parsed.get(prefix + key) if prefix else None
    if value:
        print("   %s <- %s%s" % (key, prefix, key), file=sys.stderr)
    else:
        value = parsed.get(key)
    if not value:
        print("!! %s missing from %s -- skipped" % (key, env_file), file=sys.stderr)
        continue
    out[key] = value

# JSON is a subset of YAML, so json.dumps produces valid, correctly escaped
# YAML for a flat string map.
for key, value in out.items():
    print("%s: %s" % (key, json.dumps(value)))
