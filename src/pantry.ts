import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type ChangeSource = 'photo' | 'receipt' | 'manual' | 'consumption' | 'automation' | 'unknown';

export interface ItemRow {
  id: string;
  product_name: string;
  brand: string | null;
  sku: string | null;
  unit: string;
  package_size: number | null;
  package_unit: string | null;
  latest_price: number | null;
  currency: string | null;
  min_quantity: number | null;
  target_quantity: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemRef {
  item_id?: string;
  product_name?: string;
  brand?: string;
  sku?: string;
}

/** Raised for conditions the AI client can recover from by re-calling with better arguments. */
export class PantryError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'PantryError';
  }
}

const DEFAULT_LOCATION = 'pantry';

function nowIso(): string {
  return new Date().toISOString();
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** SQLite REAL arithmetic drifts; keep quantities to 3 decimals so 0.1+0.2 stays 0.3. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function coerceTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PantryError(`Invalid timestamp: ${value}. Use ISO 8601, e.g. 2026-09-15T08:00:00Z.`);
  }
  return parsed.toISOString();
}

function coerceDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new PantryError(`Invalid date: ${value}. Use YYYY-MM-DD.`);
    }
    return parsed.toISOString().slice(0, 10);
  }
  return value;
}

export class PantryStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---------------------------------------------------------------- locations

  listLocations(): Array<{ id: string; name: string; item_count: number }> {
    return this.db
      .prepare(
        `SELECT l.id, l.name,
                (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id AND s.quantity > 0) AS item_count
           FROM locations l
          ORDER BY l.name`
      )
      .all() as Array<{ id: string; name: string; item_count: number }>;
  }

  /** Locations are created on first reference so the client never has to pre-register one. */
  resolveLocation(name: string | undefined): { id: string; name: string } {
    const wanted = (name?.trim() || DEFAULT_LOCATION);
    const existing = this.db
      .prepare('SELECT id, name FROM locations WHERE lower(name) = ?')
      .get(normalize(wanted)) as { id: string; name: string } | undefined;
    if (existing) return existing;

    const id = randomUUID();
    this.db
      .prepare('INSERT INTO locations (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, wanted, nowIso());
    return { id, name: wanted };
  }

  // -------------------------------------------------------------------- items

  getItemById(id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  }

  listItems(search?: string, limit = 200): ItemRow[] {
    if (!search || search.trim() === '') {
      return this.db
        .prepare('SELECT * FROM items ORDER BY product_name LIMIT ?')
        .all(limit) as unknown as ItemRow[];
    }
    const needle = `%${normalize(search)}%`;
    return this.db
      .prepare(
        `SELECT * FROM items
          WHERE lower(product_name) LIKE ?
             OR lower(coalesce(brand, '')) LIKE ?
             OR lower(coalesce(sku, '')) LIKE ?
          ORDER BY product_name LIMIT ?`
      )
      .all(needle, needle, needle, limit) as unknown as ItemRow[];
  }

  /**
   * Find the item a reference points at.
   *
   * Name-only references are deliberately strict: if several brands share a product
   * name we refuse rather than guess, and hand back the candidates so the caller can
   * retry with a brand or an item_id. Silently picking one would corrupt history.
   */
  findItem(ref: ItemRef): ItemRow | undefined {
    if (ref.item_id) {
      const byId = this.getItemById(ref.item_id);
      if (!byId) throw new PantryError(`No item with id ${ref.item_id}`);
      return byId;
    }

    if (ref.sku && ref.sku.trim() !== '') {
      const bySku = this.db
        .prepare('SELECT * FROM items WHERE lower(coalesce(sku, "")) = ?')
        .get(normalize(ref.sku)) as ItemRow | undefined;
      if (bySku) return bySku;
    }

    if (!ref.product_name || ref.product_name.trim() === '') {
      throw new PantryError('An item reference needs item_id, sku, or product_name.');
    }

    const name = normalize(ref.product_name);

    if (ref.brand !== undefined && ref.brand !== null && ref.brand.trim() !== '') {
      return this.db
        .prepare("SELECT * FROM items WHERE lower(product_name) = ? AND lower(coalesce(brand, '')) = ?")
        .get(name, normalize(ref.brand)) as ItemRow | undefined;
    }

    const matches = this.db
      .prepare('SELECT * FROM items WHERE lower(product_name) = ?')
      .all(name) as unknown as ItemRow[];

    if (matches.length > 1) {
      throw new PantryError(
        `"${ref.product_name}" matches ${matches.length} items that differ by brand. ` +
          'Retry with a brand or an item_id.',
        { candidates: matches.map(m => ({ item_id: m.id, product_name: m.product_name, brand: m.brand })) }
      );
    }
    return matches[0];
  }

  upsertItem(input: {
    item_id?: string;
    product_name?: string;
    brand?: string | null;
    sku?: string | null;
    unit?: string;
    package_size?: number | null;
    package_unit?: string | null;
    price?: number | null;
    currency?: string | null;
    min_quantity?: number | null;
    target_quantity?: number | null;
    notes?: string | null;
  }): { item: ItemRow; created: boolean } {
    const existing = this.findItem({
      item_id: input.item_id,
      product_name: input.product_name,
      brand: input.brand ?? undefined,
      sku: input.sku ?? undefined
    });

    const ts = nowIso();

    if (!existing) {
      if (!input.product_name || input.product_name.trim() === '') {
        throw new PantryError('product_name is required when creating a new item.');
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO items (id, product_name, brand, sku, unit, package_size, package_unit,
                              latest_price, currency, min_quantity, target_quantity, notes,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.product_name.trim(),
          input.brand?.trim() || null,
          input.sku?.trim() || null,
          input.unit?.trim() || 'unit',
          input.package_size ?? null,
          input.package_unit?.trim() || null,
          input.price ?? null,
          input.currency?.trim() || null,
          input.min_quantity ?? null,
          input.target_quantity ?? null,
          input.notes?.trim() || null,
          ts,
          ts
        );

      if (input.price !== undefined && input.price !== null) {
        this.insertPriceObservation(id, {
          price: input.price,
          currency: input.currency ?? null,
          source: 'manual',
          observed_on: ts.slice(0, 10)
        });
      }
      return { item: this.getItemById(id)!, created: true };
    }

    // Partial update: only fields explicitly supplied are touched.
    const patch: Record<string, unknown> = {};
    if (input.product_name !== undefined) patch.product_name = input.product_name.trim();
    if (input.brand !== undefined) patch.brand = input.brand?.trim() || null;
    if (input.sku !== undefined) patch.sku = input.sku?.trim() || null;
    if (input.unit !== undefined) patch.unit = input.unit.trim() || 'unit';
    if (input.package_size !== undefined) patch.package_size = input.package_size;
    if (input.package_unit !== undefined) patch.package_unit = input.package_unit?.trim() || null;
    if (input.price !== undefined) patch.latest_price = input.price;
    if (input.currency !== undefined) patch.currency = input.currency?.trim() || null;
    if (input.min_quantity !== undefined) patch.min_quantity = input.min_quantity;
    if (input.target_quantity !== undefined) patch.target_quantity = input.target_quantity;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

    const keys = Object.keys(patch);
    if (keys.length > 0) {
      const assignments = keys.map(k => `${k} = ?`).join(', ');
      this.db
        .prepare(`UPDATE items SET ${assignments}, updated_at = ? WHERE id = ?`)
        .run(...(keys.map(k => patch[k]) as never[]), ts, existing.id);
    }

    if (input.price !== undefined && input.price !== null && input.price !== existing.latest_price) {
      this.insertPriceObservation(existing.id, {
        price: input.price,
        currency: input.currency ?? existing.currency,
        source: 'manual',
        observed_on: ts.slice(0, 10)
      });
    }

    return { item: this.getItemById(existing.id)!, created: false };
  }

  /** Resolve a reference, creating the item when the caller allows it. */
  private resolveOrCreateItem(ref: ItemRef & { unit?: string }, allowCreate: boolean): ItemRow {
    const found = this.findItem(ref);
    if (found) return found;
    if (!allowCreate) {
      throw new PantryError(
        `Unknown item: ${ref.product_name ?? ref.sku ?? ref.item_id}. ` +
          'Create it with upsert_item first, or pass create_missing_items: true.'
      );
    }
    return this.upsertItem({
      product_name: ref.product_name,
      brand: ref.brand ?? null,
      sku: ref.sku ?? null,
      unit: ref.unit
    }).item;
  }

  // -------------------------------------------------------------------- state

  getState(options: { location?: string; search?: string; include_zero?: boolean } = {}) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.location) {
      conditions.push('lower(l.name) = ?');
      params.push(normalize(options.location));
    }
    if (options.search) {
      conditions.push("(lower(i.product_name) LIKE ? OR lower(coalesce(i.brand, '')) LIKE ?)");
      const needle = `%${normalize(options.search)}%`;
      params.push(needle, needle);
    }
    if (!options.include_zero) {
      conditions.push('s.quantity > 0');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, i.product_name, i.brand, i.sku, i.unit,
                i.package_size, i.package_unit, i.latest_price, i.currency,
                i.min_quantity, i.target_quantity,
                l.name AS location, s.quantity, s.expires_on, s.updated_at
           FROM stock s
           JOIN items i ON i.id = s.item_id
           JOIN locations l ON l.id = s.location_id
           ${where}
           ORDER BY l.name, i.product_name`
      )
      .all(...(params as never[])) as Array<Record<string, unknown>>;

    const today = nowIso().slice(0, 10);
    return rows.map(row => {
      const quantity = row.quantity as number;
      const min = row.min_quantity as number | null;
      const expires = row.expires_on as string | null;
      return {
        ...row,
        quantity: round(quantity),
        low_stock: min !== null && quantity <= min,
        expired: expires !== null && expires < today
      };
    });
  }

  /**
   * Absolute snapshot, the shape a photo produces: "this is what is on the shelf now".
   *
   * `mark_missing_as_zero` closes the loop for a photo of a whole shelf — anything
   * previously stocked in that location but absent from the frame drops to zero.
   */
  applySnapshot(input: {
    entries: Array<ItemRef & { quantity: number; unit?: string; location?: string; expires_on?: string }>;
    location?: string;
    source?: ChangeSource;
    note?: string;
    occurred_at?: string;
    create_missing_items?: boolean;
    mark_missing_as_zero?: boolean;
    batch_id?: string;
  }) {
    return this.withBatch(input.batch_id, 'snapshot', () => {
      const ts = nowIso();
      const occurredAt = coerceTimestamp(input.occurred_at, ts);
      const source = input.source ?? 'photo';
      const allowCreate = input.create_missing_items !== false;
      const touched = new Set<string>();
      const applied: unknown[] = [];

      for (const entry of input.entries) {
        if (typeof entry.quantity !== 'number' || Number.isNaN(entry.quantity)) {
          throw new PantryError(`Entry "${entry.product_name ?? entry.item_id}" is missing a numeric quantity.`);
        }
        if (entry.quantity < 0) {
          throw new PantryError(`Quantity cannot be negative for "${entry.product_name ?? entry.item_id}".`);
        }

        const item = this.resolveOrCreateItem(entry, allowCreate);
        const location = this.resolveLocation(entry.location ?? input.location);
        touched.add(`${item.id}:${location.id}`);

        const before = this.currentQuantity(item.id, location.id);
        const after = round(entry.quantity);
        const expiresOn = entry.expires_on ? coerceDate(entry.expires_on, ts.slice(0, 10)) : undefined;

        this.writeStock(item.id, location.id, after, expiresOn, ts);
        this.writeEvent({
          item_id: item.id,
          location_id: location.id,
          change_type: 'set',
          before,
          delta: round(after - before),
          after,
          unit: entry.unit ?? item.unit,
          source,
          note: input.note ?? null,
          occurred_at: occurredAt,
          recorded_at: ts,
          batch_id: input.batch_id ?? null
        });

        applied.push({
          item_id: item.id,
          product_name: item.product_name,
          brand: item.brand,
          location: location.name,
          quantity_before: before,
          quantity_after: after,
          unit: entry.unit ?? item.unit
        });
      }

      const zeroed: unknown[] = [];
      if (input.mark_missing_as_zero) {
        if (!input.location) {
          throw new PantryError('mark_missing_as_zero requires a top-level location to scope the sweep.');
        }
        const location = this.resolveLocation(input.location);
        const stale = this.db
          .prepare(
            `SELECT s.item_id, s.quantity, i.product_name, i.brand, i.unit
               FROM stock s JOIN items i ON i.id = s.item_id
              WHERE s.location_id = ? AND s.quantity > 0`
          )
          .all(location.id) as Array<{
            item_id: string; quantity: number; product_name: string; brand: string | null; unit: string;
          }>;

        for (const row of stale) {
          if (touched.has(`${row.item_id}:${location.id}`)) continue;
          this.writeStock(row.item_id, location.id, 0, undefined, ts);
          this.writeEvent({
            item_id: row.item_id,
            location_id: location.id,
            change_type: 'set',
            before: round(row.quantity),
            delta: round(-row.quantity),
            after: 0,
            unit: row.unit,
            source,
            note: input.note ? `${input.note} (absent from snapshot)` : 'absent from snapshot',
            occurred_at: occurredAt,
            recorded_at: ts,
            batch_id: input.batch_id ?? null
          });
          zeroed.push({
            item_id: row.item_id,
            product_name: row.product_name,
            brand: row.brand,
            quantity_before: round(row.quantity),
            quantity_after: 0
          });
        }
      }

      return { applied, zeroed_because_absent: zeroed, occurred_at: occurredAt };
    });
  }

  /** Relative change, the shape a receipt or a "we ate one" note produces. */
  applyAdjustments(input: {
    entries: Array<ItemRef & { delta: number; unit?: string; location?: string; expires_on?: string }>;
    location?: string;
    source?: ChangeSource;
    note?: string;
    occurred_at?: string;
    create_missing_items?: boolean;
    batch_id?: string;
  }) {
    return this.withBatch(input.batch_id, 'adjust', () => {
      const ts = nowIso();
      const occurredAt = coerceTimestamp(input.occurred_at, ts);
      const source = input.source ?? 'manual';
      const allowCreate = input.create_missing_items !== false;
      const applied: unknown[] = [];

      for (const entry of input.entries) {
        if (typeof entry.delta !== 'number' || Number.isNaN(entry.delta)) {
          throw new PantryError(`Entry "${entry.product_name ?? entry.item_id}" is missing a numeric delta.`);
        }

        const item = this.resolveOrCreateItem(entry, allowCreate);
        const location = this.resolveLocation(entry.location ?? input.location);
        const before = this.currentQuantity(item.id, location.id);
        // Stock cannot go negative; clamping keeps a miscounted consumption from
        // poisoning future reorder maths, and the event records what we really applied.
        const after = round(Math.max(0, before + entry.delta));
        const expiresOn = entry.expires_on ? coerceDate(entry.expires_on, ts.slice(0, 10)) : undefined;

        this.writeStock(item.id, location.id, after, expiresOn, ts);
        this.writeEvent({
          item_id: item.id,
          location_id: location.id,
          change_type: 'adjust',
          before,
          delta: round(after - before),
          after,
          unit: entry.unit ?? item.unit,
          source,
          note: input.note ?? null,
          occurred_at: occurredAt,
          recorded_at: ts,
          batch_id: input.batch_id ?? null
        });

        applied.push({
          item_id: item.id,
          product_name: item.product_name,
          brand: item.brand,
          location: location.name,
          requested_delta: entry.delta,
          applied_delta: round(after - before),
          quantity_before: before,
          quantity_after: after,
          clamped_at_zero: before + entry.delta < 0
        });
      }

      return { applied, occurred_at: occurredAt };
    });
  }

  // ------------------------------------------------------------------ history

  getItemHistory(ref: ItemRef, limit = 100, since?: string) {
    const item = this.findItem(ref);
    if (!item) throw new PantryError(`Unknown item: ${ref.product_name ?? ref.sku ?? ref.item_id}`);

    const params: unknown[] = [item.id];
    let sinceClause = '';
    if (since) {
      sinceClause = 'AND e.occurred_at >= ?';
      params.push(coerceTimestamp(since, nowIso()));
    }
    params.push(limit);

    const events = this.db
      .prepare(
        `SELECT e.id, e.change_type, e.quantity_before, e.quantity_delta, e.quantity_after,
                e.unit, e.source, e.note, e.occurred_at, e.recorded_at, l.name AS location
           FROM pantry_events e
           JOIN locations l ON l.id = e.location_id
          WHERE e.item_id = ? ${sinceClause}
          ORDER BY e.occurred_at DESC, e.id DESC
          LIMIT ?`
      )
      .all(...(params as never[])) as Array<Record<string, unknown>>;

    const consumed = events
      .filter(e => (e.quantity_delta as number) < 0)
      .reduce((sum, e) => sum + Math.abs(e.quantity_delta as number), 0);
    const restocked = events
      .filter(e => (e.quantity_delta as number) > 0)
      .reduce((sum, e) => sum + (e.quantity_delta as number), 0);

    return {
      item: {
        item_id: item.id,
        product_name: item.product_name,
        brand: item.brand,
        sku: item.sku,
        unit: item.unit
      },
      current_quantity: round(
        (this.db
          .prepare('SELECT coalesce(sum(quantity), 0) AS q FROM stock WHERE item_id = ?')
          .get(item.id) as { q: number }).q
      ),
      summary: {
        events_returned: events.length,
        total_decrease: round(consumed),
        total_increase: round(restocked)
      },
      events
    };
  }

  getLowStockItems(location?: string) {
    const params: unknown[] = [];
    let locationClause = '';
    if (location) {
      locationClause = 'AND lower(l.name) = ?';
      params.push(normalize(location));
    }

    return this.db
      .prepare(
        `SELECT i.id AS item_id, i.product_name, i.brand, i.sku, i.unit,
                i.latest_price, i.currency, i.min_quantity, i.target_quantity,
                l.name AS location, s.quantity,
                CASE WHEN i.target_quantity IS NOT NULL
                     THEN max(0, i.target_quantity - s.quantity)
                     ELSE NULL END AS suggested_order_quantity
           FROM stock s
           JOIN items i ON i.id = s.item_id
           JOIN locations l ON l.id = s.location_id
          WHERE i.min_quantity IS NOT NULL AND s.quantity <= i.min_quantity ${locationClause}
          ORDER BY (s.quantity - i.min_quantity), i.product_name`
      )
      .all(...(params as never[]));
  }

  // ------------------------------------------------------------------- prices

  recordPrices(input: {
    entries: Array<ItemRef & {
      price: number; currency?: string; store?: string; quantity?: number; observed_on?: string; note?: string;
    }>;
    store?: string;
    currency?: string;
    observed_on?: string;
    source?: ChangeSource;
    create_missing_items?: boolean;
    batch_id?: string;
  }) {
    return this.withBatch(input.batch_id, 'prices', () => {
      const ts = nowIso();
      const allowCreate = input.create_missing_items !== false;
      const recorded: unknown[] = [];

      for (const entry of input.entries) {
        if (typeof entry.price !== 'number' || Number.isNaN(entry.price)) {
          throw new PantryError(`Entry "${entry.product_name ?? entry.item_id}" is missing a numeric price.`);
        }
        const item = this.resolveOrCreateItem(entry, allowCreate);
        const currency = entry.currency ?? input.currency ?? item.currency ?? 'USD';
        const observedOn = coerceDate(entry.observed_on ?? input.observed_on, ts.slice(0, 10));

        this.insertPriceObservation(item.id, {
          price: entry.price,
          currency,
          store: entry.store ?? input.store ?? null,
          quantity: entry.quantity ?? null,
          observed_on: observedOn,
          source: input.source ?? 'receipt',
          note: entry.note ?? null
        });

        this.db
          .prepare('UPDATE items SET latest_price = ?, currency = ?, updated_at = ? WHERE id = ?')
          .run(entry.price, currency, ts, item.id);

        recorded.push({
          item_id: item.id,
          product_name: item.product_name,
          brand: item.brand,
          price: entry.price,
          currency,
          store: entry.store ?? input.store ?? null,
          observed_on: observedOn,
          previous_price: item.latest_price
        });
      }

      return { recorded };
    });
  }

  getPriceHistory(ref: ItemRef, limit = 100) {
    const item = this.findItem(ref);
    if (!item) throw new PantryError(`Unknown item: ${ref.product_name ?? ref.sku ?? ref.item_id}`);

    const observations = this.db
      .prepare(
        `SELECT id, price, currency, store, quantity, observed_on, source, note
           FROM price_observations WHERE item_id = ?
          ORDER BY observed_on DESC, id DESC LIMIT ?`
      )
      .all(item.id, limit) as Array<{ price: number; observed_on: string }>;

    const prices = observations.map(o => o.price);
    return {
      item: { item_id: item.id, product_name: item.product_name, brand: item.brand },
      summary: prices.length === 0
        ? null
        : {
            observations: prices.length,
            latest: prices[0],
            min: Math.min(...prices),
            max: Math.max(...prices),
            average: round(prices.reduce((a, b) => a + b, 0) / prices.length)
          },
      observations
    };
  }

  // ------------------------------------------------------------------ helpers

  private insertPriceObservation(
    itemId: string,
    obs: {
      price: number; currency?: string | null; store?: string | null; quantity?: number | null;
      observed_on: string; source: string; note?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `INSERT INTO price_observations
           (item_id, price, currency, store, quantity, observed_on, source, note, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        obs.price,
        obs.currency ?? 'USD',
        obs.store ?? null,
        obs.quantity ?? null,
        obs.observed_on,
        obs.source,
        obs.note ?? null,
        nowIso()
      );
  }

  private currentQuantity(itemId: string, locationId: string): number {
    const row = this.db
      .prepare('SELECT quantity FROM stock WHERE item_id = ? AND location_id = ?')
      .get(itemId, locationId) as { quantity: number } | undefined;
    return round(row?.quantity ?? 0);
  }

  private writeStock(
    itemId: string, locationId: string, quantity: number, expiresOn: string | undefined, ts: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO stock (item_id, location_id, quantity, expires_on, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item_id, location_id) DO UPDATE SET
           quantity = excluded.quantity,
           expires_on = coalesce(excluded.expires_on, stock.expires_on),
           updated_at = excluded.updated_at`
      )
      .run(itemId, locationId, quantity, expiresOn ?? null, ts);
  }

  private writeEvent(event: {
    item_id: string; location_id: string; change_type: string;
    before: number; delta: number; after: number;
    unit: string | null; source: string; note: string | null;
    occurred_at: string; recorded_at: string; batch_id: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pantry_events
           (item_id, location_id, change_type, quantity_before, quantity_delta, quantity_after,
            unit, source, note, occurred_at, recorded_at, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.item_id, event.location_id, event.change_type,
        event.before, event.delta, event.after,
        event.unit, event.source, event.note,
        event.occurred_at, event.recorded_at, event.batch_id
      );
  }

  /**
   * Runs `fn` in a transaction. When a batch_id is supplied the result is memoised,
   * so a client that retries a timed-out photo upload replays the stored answer
   * instead of double-counting the shelf.
   */
  private withBatch<T extends object>(batchId: string | undefined, kind: string, fn: () => T): T & { replayed?: boolean } {
    if (batchId) {
      const prior = this.db
        .prepare('SELECT result_json FROM batches WHERE id = ?')
        .get(batchId) as { result_json: string } | undefined;
      if (prior) {
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (batchId) {
        this.db
          .prepare('INSERT INTO batches (id, kind, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run(batchId, kind, JSON.stringify(result), nowIso());
      }
      this.db.exec('COMMIT');
      return result as T & { replayed?: boolean };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
