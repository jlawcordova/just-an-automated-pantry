import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PantryStore, PantryError } from '../pantry.js';

const SOURCES = ['photo', 'receipt', 'manual', 'consumption', 'automation', 'unknown'] as const;

const itemRef = {
  item_id: z.string().optional().describe('Exact item id, if you already know it. Beats every other field.'),
  product_name: z.string().optional().describe('Product name as printed on the packaging, e.g. "Diced Tomatoes".'),
  brand: z.string().optional().describe('Brand, e.g. "Hunt\'s". Include it whenever the label shows one — it is how look-ups stay unambiguous.'),
  sku: z.string().optional().describe('Barcode or SKU, if legible.')
};

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  if (error instanceof PantryError) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: error.message, ...(error.details ?? {}) }, null, 2)
      }]
    };
  }
  console.error('[mcp] tool failure:', error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Internal error: ${(error as Error).message}` }]
  };
}

function guard<T>(fn: () => T) {
  try {
    return ok(fn());
  } catch (error) {
    return fail(error);
  }
}

export function createPantryMcpServer(pantry: PantryStore, userEmail: string): McpServer {
  const server = new McpServer(
    { name: 'pantry-inventory', version: '0.1.0' },
    {
      instructions:
        'Tracks pantry inventory for ' + userEmail + '.\n\n' +
        'Typical flows:\n' +
        '- Photo of a shelf: read off every visible product, then call record_pantry_snapshot with absolute ' +
        'quantities. Pass mark_missing_as_zero only when the photo covers the whole location.\n' +
        '- Receipt: call record_prices for the prices, and adjust_pantry_stock with positive deltas for what was bought.\n' +
        '- Someone used something: adjust_pantry_stock with a negative delta and source "consumption".\n' +
        '- Before creating items, call list_items to check whether the product already exists under a ' +
        'slightly different name, so history stays on one item instead of splitting across duplicates.\n' +
        '- Pass a stable batch_id (a UUID per photo or receipt) on write tools; a retry then replays the ' +
        'stored result instead of double counting.'
    }
  );

  server.registerTool(
    'list_locations',
    {
      title: 'List storage locations',
      description: 'Lists every storage location (pantry, fridge, freezer, …) with how many distinct items are currently stocked in it.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => guard(() => ({ locations: pantry.listLocations() }))
  );

  server.registerTool(
    'list_items',
    {
      title: 'List or search the item catalogue',
      description:
        'Searches the catalogue of products that can be stocked, matching on product name, brand or SKU. ' +
        'Call this before creating an item so a product already known under a slightly different name is ' +
        'reused rather than duplicated.',
      inputSchema: {
        search: z.string().optional().describe('Substring to match against product name, brand or SKU. Omit to list everything.'),
        limit: z.number().int().positive().max(500).optional().describe('Maximum rows to return (default 200).')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ search, limit }) => guard(() => ({ items: pantry.listItems(search, limit ?? 200) }))
  );

  server.registerTool(
    'upsert_item',
    {
      title: 'Create or edit an item',
      description:
        'Creates a product in the catalogue, or edits one that already exists. Identify an existing item by ' +
        'item_id, by SKU, or by product_name plus brand. Only the fields you pass are changed. Setting a ' +
        'price here also files a price observation, so price history stays complete.',
      inputSchema: {
        ...itemRef,
        unit: z.string().optional().describe('Unit each quantity is counted in: "can", "box", "bottle", "g", "ml", "pack". Defaults to "unit".'),
        package_size: z.number().optional().describe('Size of one package, e.g. 400 for a 400 g can.'),
        package_unit: z.string().optional().describe('Unit for package_size, e.g. "g" or "ml".'),
        price: z.number().optional().describe('Current unit price.'),
        currency: z.string().optional().describe('ISO currency code for the price, e.g. "PHP" or "USD".'),
        min_quantity: z.number().optional().describe('Reorder threshold. At or below this, the item shows up in get_low_stock_items.'),
        target_quantity: z.number().optional().describe('Quantity to restock back up to; drives suggested_order_quantity.'),
        notes: z.string().optional().describe('Free-text notes.')
      }
    },
    async args => guard(() => pantry.upsertItem(args))
  );

  server.registerTool(
    'get_pantry_state',
    {
      title: 'Get current pantry state',
      description:
        'Returns what is in stock right now: item, brand, quantity, unit, location, expiry, and flags for ' +
        'low stock and expired stock. This is the tool a reorder or meal-planning task should start from.',
      inputSchema: {
        location: z.string().optional().describe('Restrict to one location, e.g. "fridge".'),
        search: z.string().optional().describe('Restrict to items whose name or brand matches this substring.'),
        include_zero: z.boolean().optional().describe('Include items that are out of stock (quantity 0). Default false.')
      },
      annotations: { readOnlyHint: true }
    },
    async args => guard(() => {
      const state = pantry.getState(args);
      return {
        as_of: new Date().toISOString(),
        item_count: state.length,
        low_stock_count: state.filter(row => row.low_stock).length,
        items: state
      };
    })
  );

  server.registerTool(
    'record_pantry_snapshot',
    {
      title: 'Record an observed pantry snapshot',
      description:
        'Records absolute observed quantities — the shape a photo of a shelf produces. Each entry says ' +
        '"there are now N of this item". Unknown products are created automatically. ' +
        'Set mark_missing_as_zero only when the photo covers an entire location, since it zeroes every ' +
        'item previously stocked there that is absent from your entries.',
      inputSchema: {
        entries: z.array(z.object({
          ...itemRef,
          quantity: z.number().min(0).describe('Absolute quantity observed, not a change.'),
          unit: z.string().optional().describe('Unit for this observation, if it differs from the item default.'),
          location: z.string().optional().describe('Per-entry location override.'),
          expires_on: z.string().optional().describe('Earliest expiry date visible on the packaging, YYYY-MM-DD.')
        })).min(1).describe('Every product observed.'),
        location: z.string().optional().describe('Location for the whole snapshot. Defaults to "pantry".'),
        source: z.enum(SOURCES).optional().describe('Where the observation came from. Defaults to "photo".'),
        note: z.string().optional().describe('Free-text note stored on every event in this snapshot.'),
        occurred_at: z.string().optional().describe('ISO 8601 time the observation was made, if not now — e.g. the photo timestamp.'),
        create_missing_items: z.boolean().optional().describe('Create catalogue entries for unknown products. Default true.'),
        mark_missing_as_zero: z.boolean().optional().describe('Zero out items stocked in this location but absent from entries. Requires location. Default false.'),
        batch_id: z.string().optional().describe('Stable id for this photo. Re-sending the same id replays the stored result instead of double counting.')
      }
    },
    async args => guard(() => pantry.applySnapshot(args))
  );

  server.registerTool(
    'adjust_pantry_stock',
    {
      title: 'Adjust pantry quantities by a delta',
      description:
        'Applies relative changes — the shape a receipt ("+6 bought") or a consumption note ("-1 eaten") ' +
        'produces. Use this when you know the change but not the resulting total. Quantities are clamped ' +
        'at zero and the response reports what was actually applied.',
      inputSchema: {
        entries: z.array(z.object({
          ...itemRef,
          delta: z.number().describe('Signed change. Positive restocks, negative consumes.'),
          unit: z.string().optional().describe('Unit for this change, if it differs from the item default.'),
          location: z.string().optional().describe('Per-entry location override.'),
          expires_on: z.string().optional().describe('Expiry date for newly added stock, YYYY-MM-DD.')
        })).min(1),
        location: z.string().optional().describe('Location for the whole adjustment. Defaults to "pantry".'),
        source: z.enum(SOURCES).optional().describe('Where the change came from. Defaults to "manual".'),
        note: z.string().optional().describe('Free-text note stored on every event.'),
        occurred_at: z.string().optional().describe('ISO 8601 time the change happened, if not now — e.g. the receipt date.'),
        create_missing_items: z.boolean().optional().describe('Create catalogue entries for unknown products. Default true.'),
        batch_id: z.string().optional().describe('Stable id for this receipt or batch, for safe retries.')
      }
    },
    async args => guard(() => pantry.applyAdjustments(args))
  );

  server.registerTool(
    'get_item_history',
    {
      title: 'Get an item\'s stock history',
      description:
        'Returns the change log for one item — every snapshot and adjustment, with before/after quantities, ' +
        'source and timestamp, plus totals for how much went in and out. This is the raw material for ' +
        'consumption-rate and restocking-frequency analysis.',
      inputSchema: {
        ...itemRef,
        limit: z.number().int().positive().max(1000).optional().describe('Maximum events to return (default 100, newest first).'),
        since: z.string().optional().describe('Only events at or after this ISO 8601 time.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ limit, since, ...ref }) => guard(() => pantry.getItemHistory(ref, limit ?? 100, since))
  );

  server.registerTool(
    'get_low_stock_items',
    {
      title: 'Get items at or below their reorder threshold',
      description:
        'Returns every item whose quantity has fallen to or below its min_quantity, with a ' +
        'suggested_order_quantity derived from target_quantity. Intended for the scheduled reorder task.',
      inputSchema: {
        location: z.string().optional().describe('Restrict to one location.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ location }) => guard(() => ({ items: pantry.getLowStockItems(location) }))
  );

  server.registerTool(
    'record_prices',
    {
      title: 'Record prices from a receipt',
      description:
        'Files price observations, typically parsed from a receipt, and updates each item\'s current price. ' +
        'Records only price — call adjust_pantry_stock separately to add the purchased quantities to stock.',
      inputSchema: {
        entries: z.array(z.object({
          ...itemRef,
          price: z.number().describe('Price paid for one unit of the item.'),
          currency: z.string().optional().describe('Per-entry currency override.'),
          store: z.string().optional().describe('Per-entry store override.'),
          quantity: z.number().optional().describe('How many units this line covered, for reference.'),
          observed_on: z.string().optional().describe('Per-entry date override, YYYY-MM-DD.'),
          note: z.string().optional()
        })).min(1),
        store: z.string().optional().describe('Store the receipt is from, e.g. "SM Supermarket".'),
        currency: z.string().optional().describe('ISO currency code for the whole receipt.'),
        observed_on: z.string().optional().describe('Date on the receipt, YYYY-MM-DD. Defaults to today.'),
        source: z.enum(SOURCES).optional().describe('Defaults to "receipt".'),
        create_missing_items: z.boolean().optional().describe('Create catalogue entries for unknown products. Default true.'),
        batch_id: z.string().optional().describe('Stable id for this receipt, for safe retries.')
      }
    },
    async args => guard(() => pantry.recordPrices(args))
  );

  server.registerTool(
    'get_price_history',
    {
      title: 'Get an item\'s price history',
      description:
        'Returns every recorded price for one item with min, max, average and latest, so price movement ' +
        'over time can be analysed.',
      inputSchema: {
        ...itemRef,
        limit: z.number().int().positive().max(1000).optional().describe('Maximum observations to return (default 100, newest first).')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ limit, ...ref }) => guard(() => pantry.getPriceHistory(ref, limit ?? 100))
  );

  return server;
}
