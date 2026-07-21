/**
 * webhookProcessor.js
 * ────────────────────
 * Processes a verified webhook payload:
 *   1. Parses the raw body via the correct provider's parser
 *   2. Looks up the DeliveryShipment + Order by orderId
 *   3. Appends the event to DeliveryShipment.webhookLog + timeline
 *   4. Normalizes the provider status → canonical Order status
 *   5. If status changed → updates Order.status (respecting allowed transitions)
 *   6. Sends in-app notifications to customer and vendors
 *
 * Called by deliveryWebhookRoutes.js AFTER signature verification.
 * Always resolves (never throws) so the webhook route can always return 200.
 */

import { parseWebhookPayload, normalizeProviderStatus } from '../deliveryManager.js';
import DeliveryShipment from '../../../models/DeliveryShipment.model.js';
import Order            from '../../../models/Order.model.js';
import { createNotification } from '../../../services/notification.service.js';

// ─── Status transition guard (mirrors admin order controller) ─────────────────
const ALLOWED_TRANSITIONS = {
    pending:    ['processing', 'cancelled'],
    processing: ['shipped', 'cancelled'],
    shipped:    ['delivered', 'cancelled', 'returned'],
    delivered:  ['returned'],
    cancelled:  [],
    returned:   [],
};

function canTransition(from, to) {
    const allowed = ALLOWED_TRANSITIONS[String(from)] || [];
    return allowed.includes(String(to));
}

// ─── Main processor ───────────────────────────────────────────────────────────

/**
 * @param {string}        providerName – e.g. "shiprocket"
 * @param {string|Buffer} rawBody      – raw webhook request body
 * @param {object}        headers      – request headers
 */
export async function processWebhook(providerName, rawBody, headers) {
    let parsed;

    // 1. Parse payload
    try {
        parsed = parseWebhookPayload(providerName, rawBody, headers);
    } catch (err) {
        console.error(`[webhookProcessor] Failed to parse ${providerName} webhook:`, err.message);
        return;
    }

    const { orderId, externalId, providerStatus, meta } = parsed;

    if (!orderId && !externalId) {
        console.warn(`[webhookProcessor] ${providerName} webhook missing orderId and externalId — discarding`);
        return;
    }

    // 2. Look up order
    let order = null;
    if (orderId) {
        order = await Order.findOne({ orderId, isDeleted: { $ne: true } });
    }
    if (!order && externalId) {
        order = await Order.findOne({ externalShipmentId: externalId, isDeleted: { $ne: true } });
    }

    if (!order) {
        console.warn(`[webhookProcessor] Order not found for orderId="${orderId}" externalId="${externalId}" — discarding`);
        return;
    }

    // 3. Look up / create DeliveryShipment
    let shipment = await DeliveryShipment.findOne({
        $or: [
            { orderId: order.orderId },
            { orderMongoId: order._id },
            ...(externalId ? [{ externalShipmentId: externalId }] : []),
        ],
    });

    if (!shipment) {
        // Auto-create if first webhook arrives before admin created the shipment record
        shipment = new DeliveryShipment({
            orderId:      order.orderId,
            orderMongoId: order._id,
            providerName,
            externalShipmentId: externalId || undefined,
            status: 'created',
        });
    }

    // 4. Append to webhookLog
    shipment.webhookLog = shipment.webhookLog || [];
    shipment.webhookLog.push({
        receivedAt: new Date(),
        payload:    meta,
        processed:  false,
    });

    // 5. Append to timeline
    shipment.timeline = shipment.timeline || [];
    shipment.timeline.push({
        status:    providerStatus,
        timestamp: new Date(),
        location:  parsed.location?.label || null,
        raw:       meta,
    });

    // Update externalShipmentId if we now have one
    if (externalId && !shipment.externalShipmentId) {
        shipment.externalShipmentId = externalId;
        order.externalShipmentId    = externalId;
    }

    // Update raw provider status on order
    order.providerStatus = providerStatus;

    // 6. Normalize status → canonical
    const canonicalStatus = normalizeProviderStatus(providerName, providerStatus);

    let statusChanged = false;
    if (canonicalStatus && canTransition(order.status, canonicalStatus)) {
        order.status = canonicalStatus;
        statusChanged = true;

        // Align delivery shipment status
        const SHIPMENT_STATUS_MAP = {
            processing: 'created',
            shipped:    'in_transit',
            delivered:  'delivered',
            cancelled:  'cancelled',
            returned:   'cancelled',
        };
        shipment.status = SHIPMENT_STATUS_MAP[canonicalStatus] || shipment.status;

        if (canonicalStatus === 'delivered') {
            order.deliveredAt = new Date();
            if (order.paymentMethod === 'cod') order.paymentStatus = 'paid';
        }
        if (canonicalStatus === 'cancelled') {
            order.cancelledAt = new Date();
        }

        // Align vendor sub-orders
        if (['shipped', 'delivered', 'cancelled'].includes(canonicalStatus)) {
            order.vendorItems = (order.vendorItems || []).map((vi) => {
                const current = String(vi?.status || 'pending');
                if (current === 'delivered' && canonicalStatus !== 'returned') return vi;
                if (current === 'cancelled') return vi;
                return { ...vi.toObject(), status: canonicalStatus };
            });
        }
    } else if (canonicalStatus && !canTransition(order.status, canonicalStatus)) {
        console.warn(
            `[webhookProcessor] Ignoring status regression: order ${order.orderId} ` +
            `is "${order.status}", provider says "${providerStatus}" → "${canonicalStatus}" — not a valid forward transition`
        );
    } else if (!canonicalStatus) {
        console.warn(
            `[webhookProcessor] Unmapped provider status "${providerStatus}" for ${providerName} — ` +
            `stored in timeline, order status unchanged`
        );
    }

    // Mark webhook as processed
    const lastLog = shipment.webhookLog[shipment.webhookLog.length - 1];
    if (lastLog) lastLog.processed = true;

    // 7. Persist changes
    try {
        await Promise.all([order.save(), shipment.save()]);
    } catch (err) {
        console.error(`[webhookProcessor] Failed to save order/shipment for ${order.orderId}:`, err.message);
        return;
    }

    // 8. Send notifications (fire-and-forget — never let notification failure block webhook)
    if (statusChanged) {
        const notificationTasks = [];

        if (order.userId) {
            const msgMap = {
                shipped:   `Your order ${order.orderId} is out for delivery.`,
                delivered: `Your order ${order.orderId} has been delivered.`,
                cancelled: `Your order ${order.orderId} has been cancelled.`,
                returned:  `Your order ${order.orderId} is being returned.`,
            };
            const msg = msgMap[canonicalStatus];
            if (msg) {
                notificationTasks.push(
                    createNotification({
                        recipientId:   order.userId,
                        recipientType: 'user',
                        title: canonicalStatus === 'delivered' ? 'Order delivered 🎉' : 'Delivery update',
                        message: msg,
                        type: 'order',
                        data: { orderId: String(order.orderId), status: canonicalStatus },
                    })
                );
            }
        }

        const vendorIds = [
            ...new Set(
                (order.vendorItems || [])
                    .map((vi) => String(vi?.vendorId || '').trim())
                    .filter(Boolean)
            ),
        ];
        vendorIds.forEach((vendorId) => {
            notificationTasks.push(
                createNotification({
                    recipientId:   vendorId,
                    recipientType: 'vendor',
                    title: 'Delivery status update',
                    message: `Order ${order.orderId} moved to "${canonicalStatus}" via ${providerName}.`,
                    type: 'order',
                    data: { orderId: String(order.orderId), status: canonicalStatus },
                })
            );
        });

        if (notificationTasks.length > 0) {
            Promise.allSettled(notificationTasks).catch(() => {});
        }
    }

    console.info(
        `[webhookProcessor] ${providerName} webhook processed for order ${order.orderId}: ` +
        `providerStatus="${providerStatus}" → canonicalStatus="${canonicalStatus || 'unmapped'}" ` +
        `(order status ${statusChanged ? `updated to "${order.status}"` : 'unchanged'})`
    );
}

export default { processWebhook };
