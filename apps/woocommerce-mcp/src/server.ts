import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type WooClient, WooError } from './wc-client.ts';

// Shapes returned by the WooCommerce REST API (only the fields we use).
interface WooProduct {
  id: number;
  name: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  stock_status: string;
  permalink: string;
}
interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created: string;
  payment_method_title: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: { product_id: number; name: string; quantity: number; total: string }[];
  customer_note?: string;
  shipping?: Record<string, string>;
}

const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;

const product = (p: WooProduct) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  sku: p.sku,
  price: p.price,
  regular_price: p.regular_price,
  stock_status: p.stock_status,
  permalink: p.permalink,
});

const orderSummary = (o: WooOrder) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  created: o.date_created,
  total: o.total,
  currency: o.currency,
  customer: `${o.billing.first_name} ${o.billing.last_name}`.trim(),
  items: o.line_items.map((i) => ({
    product_id: i.product_id,
    name: i.name,
    quantity: i.quantity,
    total: i.total,
  })),
});

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Converts store errors into MCP tool errors (isError) instead of protocol errors, so the model can react. */
async function run(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (err) {
    if (err instanceof WooError)
      return { isError: true, content: [{ type: 'text' as const, text: err.message }] };
    throw err;
  }
}

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function createWooMcpServer(wc: WooClient): McpServer {
  const server = new McpServer({ name: 'woocommerce', version: '1.0.0' });

  server.registerTool(
    'list_products',
    {
      description: 'List or search products in the WooCommerce store.',
      inputSchema: z.object({
        search: z.string().max(100).optional().describe('Free-text search on product name'),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('any'),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).max(1000).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) =>
      run(async () => (await wc.get<WooProduct[]>('/products', args, ctx.mcpReq.signal)).map(product)),
  );

  server.registerTool(
    'create_product',
    {
      description: 'Create a simple product. It is published to the storefront unless status is "draft".',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200),
        regular_price: z
          .string()
          .regex(/^\d{1,9}(\.\d{1,2})?$/, 'decimal string such as "19.99"')
          .describe('Price in the store currency, e.g. "19.99"'),
        description: z.string().max(5000).optional(),
        sku: z.string().max(100).optional(),
        status: z.enum(['publish', 'draft']).default('publish'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args, ctx) =>
      run(async () =>
        product(await wc.post<WooProduct>('/products', { type: 'simple', ...args }, ctx.mcpReq.signal)),
      ),
  );

  server.registerTool(
    'list_orders',
    {
      description:
        'List orders, newest first. Use created_on (store-local date YYYY-MM-DD) for "orders today", ' +
        'or after/before (ISO 8601, store-local time) for a range.',
      inputSchema: z.object({
        status: z.enum([...ORDER_STATUSES, 'any']).default('any'),
        created_on: z.iso.date().optional(),
        after: z.iso.datetime({ local: true, offset: true }).optional(),
        before: z.iso.datetime({ local: true, offset: true }).optional(),
        per_page: z.number().int().min(1).max(50).default(20),
        page: z.number().int().min(1).max(1000).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ created_on, ...args }, ctx) =>
      run(async () => {
        const query = { ...args, order: 'desc', orderby: 'date' } as Record<
          string,
          string | number | undefined
        >;
        if (created_on) {
          query.after = `${previousDay(created_on)}T23:59:59`;
          query.before = `${created_on}T23:59:59`;
        }
        return (await wc.get<WooOrder[]>('/orders', query, ctx.mcpReq.signal)).map(orderSummary);
      }),
  );

  server.registerTool(
    'get_order',
    {
      description: 'Get one order with its line items, customer and payment details.',
      inputSchema: z.object({ order_id: z.number().int().positive() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ order_id }, ctx) =>
      run(async () => {
        const o = await wc.get<WooOrder>(`/orders/${order_id}`, undefined, ctx.mcpReq.signal);
        return {
          ...orderSummary(o),
          email: o.billing.email,
          payment_method: o.payment_method_title,
          customer_note: o.customer_note ?? '',
          shipping: o.shipping ?? {},
        };
      }),
  );

  server.registerTool(
    'update_order_status',
    {
      description: 'Change the status of an order, e.g. to "completed" or "cancelled".',
      inputSchema: z.object({ order_id: z.number().int().positive(), status: z.enum(ORDER_STATUSES) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ order_id, status }, ctx) =>
      run(async () =>
        orderSummary(await wc.put<WooOrder>(`/orders/${order_id}`, { status }, ctx.mcpReq.signal)),
      ),
  );

  return server;
}
