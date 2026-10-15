import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// Small, deterministic utility server. It exists to prove the gateway aggregates independent servers:
// "orders today, totals in EUR" needs woocommerce__list_orders + toolbox__convert_currency.

/** Static reference rates (units per 1 USD). Deliberately offline: no external API key or egress needed. */
export const RATES_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  INR: 83.2,
  JPY: 149.5,
  AUD: 1.52,
  CAD: 1.36,
};
const currency = z
  .string()
  .transform((s) => s.toUpperCase())
  .refine((s) => s in RATES_PER_USD, { message: `supported: ${Object.keys(RATES_PER_USD).join(', ')}` });

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function createToolboxServer(): McpServer {
  const server = new McpServer({ name: 'toolbox', version: '1.0.0' });

  server.registerTool(
    'convert_currency',
    {
      description: `Convert an amount between currencies using fixed reference rates (${Object.keys(RATES_PER_USD).join(', ')}).`,
      inputSchema: z.object({ amount: z.number().finite().nonnegative(), from: currency, to: currency }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ amount, from, to }) => {
      const result = (amount / (RATES_PER_USD[from] ?? 1)) * (RATES_PER_USD[to] ?? 1);
      return text(
        JSON.stringify({
          amount,
          from,
          to,
          result: Math.round(result * 100) / 100,
          rates: 'static reference',
        }),
      );
    },
  );

  server.registerTool(
    'current_time',
    {
      description: 'Current date and time in an IANA time zone (default UTC). Use it to resolve "today".',
      inputSchema: z.object({ timezone: z.string().max(64).default('UTC') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ timezone }) => {
      const now = new Date();
      try {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(now);
        const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeStyle: 'medium' }).format(
          now,
        );
        return text(JSON.stringify({ timezone, date, time, iso_utc: now.toISOString() }));
      } catch {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown time zone: ${timezone}` }],
        };
      }
    },
  );

  // Same name as the reference "everything" server's echo: demonstrates gateway collision handling.
  server.registerTool(
    'echo',
    {
      description: 'Echo the message back.',
      inputSchema: z.object({ message: z.string().max(1000) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ message }) => text(`toolbox echo: ${message}`),
  );

  return server;
}
