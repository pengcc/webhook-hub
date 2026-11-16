import { z } from 'zod';
import { type Handler, PermanentError } from './worker.js';

const orderSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
});

/**
 * Validates the order payload. A payload that does not look like an order will
 * never become valid by retrying, so it fails permanently. Persisting a
 * business projection of the order is intentionally not done yet.
 */
const validateOrder: Handler = async (event) => {
  const parsed = orderSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new PermanentError('payload is not a valid order (missing id)');
  }
};

export const defaultHandlers: Record<string, Handler> = {
  'shopify:orders/create': validateOrder,
  'shopify:orders/updated': validateOrder,
};
