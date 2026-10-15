import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import * as z from 'zod/v4';
import type { ChatModel, ToolSpec } from '../src/agent.ts';
import { ADMIN, skip, startGateway, startUpstream, type Upstream } from './helpers.ts';

// The chat tool loop with a scripted model: proves the loop, tool routing through the broker,
// per-user tool filtering and audit attribution, independent of any real LLM.

describe('chat agent', { skip }, () => {
  let gw: Awaited<ReturnType<typeof startGateway>>;
  let up: Upstream;
  let adminCookie: string;
  const seenTools: string[][] = [];

  const model: ChatModel = async (messages, tools: ToolSpec[]) => {
    seenTools.push(tools.map((t) => t.function.name));
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      return {
        content: null,
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'shop__list_orders', arguments: '{"created_on":"2026-10-15"}' },
          },
        ],
      };
    }
    return { content: `Found: ${last?.content}`, toolCalls: [] };
  };

  before(async () => {
    gw = await startGateway(model);
    up = await startUpstream((s) => {
      s.registerTool(
        'list_orders',
        { inputSchema: z.object({ created_on: z.string() }) },
        async ({ created_on }) => ({
          content: [{ type: 'text', text: `order #7 on ${created_on}` }],
        }),
      );
      s.registerTool('create_product', { inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: 'created' }],
      }));
    });
    adminCookie = await gw.loginAs(ADMIN.email, ADMIN.password);
    const res = await gw.request('/api/servers', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ slug: 'shop', name: 'Shop', url: up.url, adminOnlyTools: ['create_product'] }),
    });
    assert.equal(res.status, 201, res.text);
  });

  after(async () => {
    await gw.close();
    await up.close();
  });

  async function chat(cookie: string) {
    const res = await gw.request('/api/chat', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'What orders came in today?' }] }),
    });
    assert.equal(res.status, 200, res.text);
    return res.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  }

  test('runs the tool loop and streams tool calls, results and the answer', async () => {
    const events = await chat(adminCookie);
    assert.deepEqual(
      events.map((e) => e.type),
      ['tool_call', 'tool_result', 'message'],
    );
    assert.equal(events[0].name, 'shop__list_orders');
    assert.equal(events[1].ok, true);
    assert.equal(events[2].content, 'Found: order #7 on 2026-10-15');
  });

  test('acts as the logged-in user: audit row is attributed to them on the chat channel', async () => {
    const audit = (await gw.request('/api/audit', { cookie: adminCookie })).json as {
      user: string;
      channel: string;
      tool: string;
    }[];
    assert.ok(audit.some((a) => a.user === ADMIN.email && a.channel === 'chat' && a.tool === 'list_orders'));
  });

  test('the model is only offered tools the user may call', async () => {
    const invite = await gw.request('/api/invites', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'm@example.com', name: 'M', role: 'member' }),
    });
    const token = String(invite.json.inviteUrl).split('/invite/')[1];
    await gw.request('/api/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token, password: 'member-pass-123' }),
    });
    const memberCookie = await gw.loginAs('m@example.com', 'member-pass-123');
    seenTools.length = 0;
    await chat(memberCookie);
    assert.deepEqual(seenTools[0], ['shop__list_orders']);
    // Admin sees the write tool too.
    seenTools.length = 0;
    await chat(adminCookie);
    assert.deepEqual(seenTools[0]?.sort(), ['shop__create_product', 'shop__list_orders']);
  });
});
