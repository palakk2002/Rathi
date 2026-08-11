/**
 * shipment.controller.js  (Admin)
 * ────────────────────────────────
 * Admin endpoints for managing third-party delivery shipments.
 *
 * All write operations persist to both DeliveryShipment and Order models
 * so admin dashboards and customer-facing APIs always see consistent data.
 *
 * Routes (all require admin auth):
 *   POST  /api/admin/orders/:id/shipment         – create shipment with provider
 *   POST  /api/admin/orders/:id/shipment/cancel  – cancel shipment with provider
 *   GET   /api/admin/orders/:id/shipment/tracking – live tracking from provider
 *   GET   /api/admin/orders/:id/shipment/quote    – get delivery quote
 *   GET   /api/admin/orders/:id/shipment          – get stored shipment record
 *   POST  /api/admin/delivery/token/refresh       – force provider token refresh
 */

import asyncHandler   from '../../../utils/asyncHandler.js';
import ApiResponse    from '../../../utils/ApiResponse.js';
import ApiError       from '../../../utils/ApiError.js';
import Order          from '../../../models/Order.model.js';
import DeliveryShipment from '../../../models/DeliveryShipment.model.js';
import {
    createShipment,
    cancelShipment,
    getTrackingInfo,
    getQuote,
    getActiveProviderName,
    refreshProviderToken,
} from '../../delivery/deliveryManager.js';
import shiprocketProvider from '../../delivery/providers/shiprocket/shiprocketProvider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve order by orderId string OR MongoDB _id. */
async function findOrder(paramId) {
    return Order.findOne({
        $or: [
            { orderId: paramId },
            ...(paramId.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: paramId }] : []),
        ],
        isDeleted: { $ne: true },
    });
}

/** Build the ShipmentContext from an Order document. */
function buildContext(order, overrides = {}) {
    const addr = order.shippingAddress || {};
    return {
        orderId:         order.orderId,
        orderMongoId:    String(order._id),
        pickup: {
            name:    process.env.PICKUP_NAME    || 'work',
            phone:   process.env.PICKUP_PHONE   || '',
            address: process.env.PICKUP_ADDRESS || '',
            city:    process.env.PICKUP_CITY    || '',
            state:   process.env.PICKUP_STATE   || '',
            pincode: process.env.PICKUP_PINCODE || '',
        },
        drop: {
            name:    addr.name    || '',
            phone:   addr.phone   || '',
            email:   addr.email   || '',
            address: addr.address || '',
            city:    addr.city    || '',
            state:   addr.state   || '',
            pincode: addr.zipCode || '',
        },
        items: (order.items || []).map((item) => ({
            name:   item.name  || 'Item',
            sku:    String(item.productId || ''),
            qty:    item.quantity  || 1,
            weight: 0.5,           // default per item; override via overrides.items
            value:  item.price     || 0,
        })),
        paymentMode:  String(order.paymentMethod || 'PREPAID').toUpperCase() === 'COD' ? 'COD' : 'PREPAID',
        totalValue:   Number(order.total   || order.subtotal || 0),
        weight:       Number(overrides.weight || 0.5),
        idempotencyKey: `shipment:create:${order.orderId}:${overrides.providerName || getActiveProviderName()}`,
        ...overrides,
    };
}

// ─── POST /api/admin/orders/:id/shipment ─────────────────────────────────────

export const createOrderShipment = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    if (['cancelled', 'returned', 'delivered'].includes(order.status)) {
        throw new ApiError(409, `Cannot create shipment for a ${order.status} order.`);
    }

    // Prevent duplicate shipment creation
    const existing = await DeliveryShipment.findOne({
        orderId: order.orderId,
        status: { $nin: ['failed', 'cancelled'] },
    });
    if (existing) {
        throw new ApiError(409, `A shipment already exists for order ${order.orderId} (status: ${existing.status}).`);
    }

    const context  = buildContext(order, req.body);
    const providerName = context.preferredProvider || getActiveProviderName();

    let shipmentResult;
    try {
        shipmentResult = await createShipment(context);
    } catch (err) {
        // Persist a failed shipment record for ops visibility
        await DeliveryShipment.create({
            orderId:      order.orderId,
            orderMongoId: order._id,
            providerName,
            status:        'failed',
            failureReason: err.message,
        });
        throw new ApiError(502, `Provider error (${providerName}): ${err.message}`);
    }

    // Persist shipment record
    const shipment = await DeliveryShipment.create({
        orderId:            order.orderId,
        orderMongoId:       order._id,
        providerName,
        externalShipmentId: shipmentResult.externalId   || null,
        trackingUrl:        shipmentResult.trackingUrl   || null,
        label:              shipmentResult.label         || null,
        status:             'created',
        shipmentCreatedAt:  new Date(),
        idempotencyKey:     context.idempotencyKey,
        timeline: [{
            status:    shipmentResult.providerStatus || 'CREATED',
            timestamp: new Date(),
        }],
    });

    // Update Order with provider info
    order.providerName         = providerName;
    order.externalShipmentId   = shipmentResult.externalId || null;
    order.trackingUrl          = shipmentResult.trackingUrl || null;
    order.providerStatus       = shipmentResult.providerStatus || null;
    order.shipmentCreatedAt    = new Date();
    if (order.status === 'pending') {
        order.status = 'processing';
    }
    await order.save();

    res.status(201).json(new ApiResponse(201, { order, shipment, providerResult: shipmentResult }, 'Shipment created successfully.'));
});

// ─── POST /api/admin/orders/:id/shipment/cancel ───────────────────────────────

export const cancelOrderShipment = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    if (['delivered'].includes(order.status)) {
        throw new ApiError(409, 'Cannot cancel a delivered order.');
    }

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        status: { $nin: ['cancelled', 'failed'] },
    });

    const context = {
        ...buildContext(order),
        externalShipmentId: order.externalShipmentId || shipment?.externalShipmentId,
        shiprocketOrderId:  shipment?.shiprocketOrderId,
    };

    const result = await cancelShipment(context);

    if (shipment) {
        shipment.status             = 'cancelled';
        shipment.shipmentCancelledAt = new Date();
        shipment.timeline.push({ status: 'CANCELLED', timestamp: new Date() });
        await shipment.save();
    }

    order.shipmentCancelledAt = new Date();
    order.providerStatus      = 'CANCELLED';
    await order.save();

    res.status(200).json(new ApiResponse(200, { result, shipment }, 'Shipment cancellation requested.'));
});

// ─── GET /api/admin/orders/:id/shipment/tracking ─────────────────────────────

export const getOrderTracking = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    if (!order.externalShipmentId) {
        throw new ApiError(404, 'No shipment created yet for this order.');
    }

    const context = {
        ...buildContext(order),
        externalShipmentId: order.externalShipmentId,
    };

    const tracking = await getTrackingInfo(context);

    // Also return stored timeline from DeliveryShipment for completeness
    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
    }).select('timeline webhookLog status externalShipmentId trackingUrl').lean();

    res.status(200).json(new ApiResponse(200, { liveTracking: tracking, shipment }, 'Tracking info fetched.'));
});

// ─── GET /api/admin/orders/:id/shipment/quote ─────────────────────────────────

export const getOrderQuote = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    const context = buildContext(order, req.query);
    const quote   = await getQuote(context);

    res.status(200).json(new ApiResponse(200, quote, 'Quote fetched.'));
});

// ─── GET /api/admin/orders/:id/shipment ──────────────────────────────────────

export const getOrderShipment = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
    }).lean();

    if (!shipment) throw new ApiError(404, 'No shipment record found for this order.');

    res.status(200).json(new ApiResponse(200, { order, shipment }, 'Shipment fetched.'));
});

// ─── GET /api/admin/orders/:id/shipment/label ─────────────────────────────────
export const getOrderLabel = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
    });

    let labelUrl = shipment?.labelUrl || order.labelUrl;
    if (!labelUrl && shipment?.shiprocketShipmentId) {
        labelUrl = await shiprocketProvider.generateLabel(shipment.shiprocketShipmentId);
        if (labelUrl) {
            shipment.labelUrl = labelUrl;
            order.labelUrl = labelUrl;
            await Promise.all([shipment.save(), order.save()]);
        }
    }

    if (!labelUrl) throw new ApiError(404, 'Shipping label not available yet.');
    res.status(200).json(new ApiResponse(200, { labelUrl }, 'Shipping label fetched.'));
});

// ─── GET /api/admin/orders/:id/shipment/manifest ──────────────────────────────
export const getOrderManifest = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
    });

    let manifestUrl = shipment?.manifestUrl || order.manifestUrl;
    if (!manifestUrl && shipment?.shiprocketShipmentId) {
        manifestUrl = await shiprocketProvider.generateManifest(shipment.shiprocketShipmentId);
        if (manifestUrl) {
            shipment.manifestUrl = manifestUrl;
            order.manifestUrl = manifestUrl;
            await Promise.all([shipment.save(), order.save()]);
        }
    }

    if (!manifestUrl) throw new ApiError(404, 'Manifest document not available yet.');
    res.status(200).json(new ApiResponse(200, { manifestUrl }, 'Manifest fetched.'));
});

// ─── GET /api/admin/orders/:id/shipment/invoice ───────────────────────────────
export const getOrderInvoice = asyncHandler(async (req, res) => {
    const order = await findOrder(req.params.id);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
    });

    let invoiceUrl = shipment?.invoiceUrl || order.invoiceUrl;
    if (!invoiceUrl && (shipment?.shiprocketOrderId || order.shiprocketOrderId)) {
        const srOrderId = shipment?.shiprocketOrderId || order.shiprocketOrderId;
        invoiceUrl = await shiprocketProvider.generateInvoice(srOrderId);
        if (invoiceUrl) {
            shipment.invoiceUrl = invoiceUrl;
            order.invoiceUrl = invoiceUrl;
            await Promise.all([shipment.save(), order.save()]);
        }
    }

    if (!invoiceUrl) throw new ApiError(404, 'Invoice document not available yet.');
    res.status(200).json(new ApiResponse(200, { invoiceUrl }, 'Invoice fetched.'));
});

// ─── POST /api/admin/delivery/token/refresh ───────────────────────────────────

export const refreshDeliveryToken = asyncHandler(async (req, res) => {
    const providerName = String(req.body.provider || req.query.provider || getActiveProviderName());
    await refreshProviderToken(providerName);
    res.status(200).json(new ApiResponse(200, null, `Token refreshed for provider "${providerName}".`));
});
