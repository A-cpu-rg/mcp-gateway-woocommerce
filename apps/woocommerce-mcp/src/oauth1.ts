import { createHmac, randomBytes } from 'node:crypto';

// WooCommerce only accepts Basic auth over HTTPS. Inside the cluster we talk plain HTTP to the
// WordPress Service, so we use the one-legged OAuth 1.0a scheme WooCommerce supports for HTTP.
// This mirrors WC_REST_Authentication::check_oauth_signature() (WooCommerce 11.x):
//  - each key and value is rawurlencoded, then each "key=value" pair is encoded again, joined by "%26";
//  - the signed URL is WordPress's *home URL* + request path, with scheme http (is_ssl() is false
//    on the in-cluster hop), not the Service hostname we actually connect to.

/** PHP rawurlencode(): RFC 3986 unreserved characters are left as is, everything else is encoded. */
export function rawurlencode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface OAuthInput {
  method: string;
  /** Scheme + host (+ port) of the WordPress home URL as WordPress sees it on this request, e.g. http://store.localtest.me */
  signingOrigin: string;
  path: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  timestamp?: number;
  nonce?: string;
}

/** Returns the full query (caller params + oauth_* params + oauth_signature) to send. */
export function signOAuth1(input: OAuthInput): Record<string, string> {
  const params: Record<string, string> = {
    ...input.query,
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  // PHP uksort(..., 'strcmp') sorts raw keys by byte value before encoding.
  const keys = Object.keys(params).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const queryString = keys
    .map((k) => rawurlencode(`${rawurlencode(k)}=${rawurlencode(params[k] ?? '')}`))
    .join('%26');
  const baseUri = rawurlencode(`${input.signingOrigin}${input.path}`);
  const stringToSign = `${input.method.toUpperCase()}&${baseUri}&${queryString}`;
  const signature = createHmac('sha256', `${input.consumerSecret}&`).update(stringToSign).digest('base64');
  return { ...params, oauth_signature: signature };
}
