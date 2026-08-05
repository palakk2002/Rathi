/**
 * vendorShipment.controller.js (Vendor / Seller)
 * ───────────────────────────────────────────────
 * Seller endpoints for generating and managing Shiprocket shipments.
 *
 * Responsibilities:
 *   • Resolves seller's registered pickup location automatically (PickupLocation model / Vendor model).
 *   • Auto-fills product physical attributes (weight, length, breadth, height) if present.
 *   • Calls deliveryManager to create third-party shipment with central platform credentials.
 *   • Updates Order and DeliveryShipment models with AWB, courier name, labels, and tracking URL.
 *   • Provides document endpoints for shipping label, manifest, invoice, and live tracking.
 */

import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import ApiError from '../../../utils/ApiError.js';
import Order from '../../../models/Order.model.js';
import DeliveryShipment from '../../../models/DeliveryShipment.model.js';
import PickupLocation from '../../../models/PickupLocation.model.js';
import Vendor from '../../../models/Vendor.model.js';
import Product from '../../../models/Product.model.js';
import {
    createShipment,
    cancelShipment,
    getTrackingInfo,
    getActiveProviderName,
} from '../../delivery/deliveryManager.js';
import shiprocketProvider from '../../delivery/providers/shiprocket/shiprocketProvider.js';

/** Find vendor's order by orderId or Mongo _id */
async function findVendorOrder(paramId, vendorId) {
    const idFilter = [{ orderId: paramId }];
    if (paramId.match(/^[0-9a-fA-F]{24}$/)) {
        idFilter.push({ _id: paramId });
    }
    return Order.findOne({
        $or: idFilter,
        'vendorItems.vendorId': vendorId,
        isDeleted: { $ne: true },
    });
}

/** Resolve Seller's registered pickup warehouse location */
async function resolveSellerPickupLocation(vendorId) {
    // 1. Try default registered PickupLocation
    let pickup = await PickupLocation.findOne({ vendorId, isDefault: true }).lean();
    if (!pickup) {
        // 2. Try any registered PickupLocation for this vendor
        pickup = await PickupLocation.findOne({ vendorId }).lean();
    }

    if (pickup) {
        return {
            name:    pickup.name    || 'Primary Warehouse',
            phone:   pickup.phone   || '',
            address: pickup.address || '',
            city:    pickup.city    || '',
            state:   pickup.state   || '',
            pincode: pickup.zipCode || '',
        };
    }

    // 3. Fallback to Vendor profile primary address
    const vendor = await Vendor.findById(vendorId).lean();
    return {
        name:    vendor?.storeName || vendor?.name || 'Primary Warehouse',
        phone:   vendor?.phone || '',
        address: vendor?.address || '',
        city:    vendor?.city || '',
        state:   vendor?.state || '',
        pincode: vendor?.pincode || vendor?.zipCode || '',
    };
}

/** Calculate or extract package dimensions and weight from products */
async function resolvePackageMetrics(orderItems = [], overrides = {}) {
    let totalWeight = 0;
    let maxLength = 10;
    let maxBreadth = 10;
    let maxHeight = 5;

    const productIds = orderItems.map((item) => item.productId).filter(Boolean);
    if (productIds.length > 0) {
        const products = await Product.find({ _id: { $in: productIds } }).lean();
        const prodMap = new Map(products.map((p) => [String(p._id), p]));

        for (const item of orderItems) {
            const prod = prodMap.get(String(item.productId));
            const qty = Number(item.quantity || 1);
            if (prod) {
                totalWeight += Number(prod.weight || 0.5) * qty;
                if (Number(prod.length || 10) > maxLength) maxLength = Number(prod.length);
                if (Number(prod.breadth || 10) > maxBreadth) maxBreadth = Number(prod.breadth);
                if (Number(prod.height || 5) > maxHeight) maxHeight = Number(prod.height);
            } else {
                totalWeight += 0.5 * qty;
            }
        }
    }

    return {
        weight: Number(overrides.weight || totalWeight || 0.5),
        length: Number(overrides.length || maxLength || 10),
        breadth: Number(overrides.breadth || maxBreadth || 10),
        height: Number(overrides.height || maxHeight || 5),
    };
}

// ─── POST /api/vendor/orders/:id/shipment ─────────────────────────────────────
export const createVendorShipment = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found for this vendor.');

    if (['cancelled', 'returned', 'delivered'].includes(order.status)) {
        throw new ApiError(409, `Cannot create shipment for a ${order.status} order.`);
    }

    // Check for existing active shipment
    const existing = await DeliveryShipment.findOne({
        orderId: order.orderId,
        vendorId,
        status: { $nin: ['failed', 'cancelled'] },
    });
    if (existing) {
        throw new ApiError(409, `A shipment already exists for order ${order.orderId} (AWB: ${existing.awbCode || existing.externalShipmentId || 'N/A'}).`);
    }

    // Extract seller-specific items
    const vendorGroup = (order.vendorItems || []).find((vi) => String(vi.vendorId) === String(vendorId));
    const itemsToShip = vendorGroup?.items?.length ? vendorGroup.items : order.items;

    // Resolve pickup location & physical dimensions
    const pickup = req.body?.pickup || await resolveSellerPickupLocation(vendorId);
    const metrics = await resolvePackageMetrics(itemsToShip, req.body);

    const addr = order.shippingAddress || {};
    const context = {
        orderId:      order.orderId,
        orderMongoId: String(order._id),
        vendorId,
        pickup,
        drop: {
            name:    addr.name    || '',
            phone:   addr.phone   || '',
            email:   addr.email   || '',
            address: addr.address || '',
            city:    addr.city    || '',
            state:   addr.state   || '',
            pincode: addr.zipCode || '',
        },
        items: itemsToShip.map((item) => ({
            name:  item.name  || 'Item',
            sku:   String(item.productId || ''),
            qty:   item.quantity  || 1,
            value: item.price     || 0,
        })),
        paymentMode: String(order.paymentMethod || 'PREPAID').toUpperCase() === 'COD' ? 'COD' : 'PREPAID',
        totalValue:  Number(vendorGroup?.subtotal || order.total || order.subtotal || 0),
        weight:      metrics.weight,
        length:      metrics.length,
        breadth:     metrics.breadth,
        height:      metrics.height,
        idempotencyKey: `shipment:vendor:${vendorId}:${order.orderId}:${getActiveProviderName()}`,
    };

    const providerName = getActiveProviderName();
    let shipmentResult;

    try {
        shipmentResult = await createShipment(context);
    } catch (err) {
        console.error('[vendorShipment.controller] Shipment creation error:', err);
        await DeliveryShipment.create({
            orderId:      order.orderId,
            orderMongoId: order._id,
            vendorId,
            providerName,
            status:        'failed',
            failureReason: err.message || String(err),
        });
        throw new ApiError(502, err.message || 'Failed to create shipment with Shiprocket.');
    }

    // Persist DeliveryShipment record
    const shipment = await DeliveryShipment.create({
        orderId:              order.orderId,
        orderMongoId:         order._id,
        vendorId,
        providerName,
        externalShipmentId:   shipmentResult.externalId           || null,
        shiprocketOrderId:    shipmentResult.shiprocketOrderId   || null,
        shiprocketShipmentId: shipmentResult.shiprocketShipmentId|| null,
        awbCode:              shipmentResult.awbCode              || shipmentResult.externalId || null,
        courierId:            shipmentResult.courierId            || null,
        courierName:          shipmentResult.courierName          || null,
        trackingUrl:          shipmentResult.trackingUrl          || null,
        labelUrl:             shipmentResult.labelUrl             || null,
        status:               'created',
        pickupStatus:         'SCHEDULED',
        shipmentCreatedAt:    new Date(),
        idempotencyKey:       context.idempotencyKey,
        timeline: [{
            status:    shipmentResult.providerStatus || 'PICKUP SCHEDULED',
            timestamp: new Date(),
        }],
    });

    // Sync Order top-level & vendorItems status
    order.providerName          = providerName;
    order.externalShipmentId    = shipmentResult.externalId || null;
    order.awbCode               = shipmentResult.awbCode || shipmentResult.externalId || null;
    order.courierId             = shipmentResult.courierId || null;
    order.courierName           = shipmentResult.courierName || null;
    order.shiprocketOrderId    = shipmentResult.shiprocketOrderId || null;
    order.shiprocketShipmentId = shipmentResult.shiprocketShipmentId || null;
    order.trackingUrl           = shipmentResult.trackingUrl || null;
    order.labelUrl              = shipmentResult.labelUrl || null;
    order.providerStatus        = shipmentResult.providerStatus || 'PICKUP SCHEDULED';
    order.shipmentCreatedAt     = new Date();

    // Mark vendor's order item status to shipped
    order.vendorItems = (order.vendorItems || []).map((vi) =>
        String(vi.vendorId) === String(vendorId) ? { ...vi.toObject(), status: 'shipped' } : vi
    );

    if (order.status === 'pending' || order.status === 'processing') {
        order.status = 'shipped';
    }

    await order.save();

    res.status(201).json(
        new ApiResponse(201, { order, shipment, shipmentResult }, 'Shiprocket shipment generated successfully.')
    );
});

// ─── GET /api/vendor/orders/:id/shipment ─────────────────────────────────────
export const getVendorShipment = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found for this vendor.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
    }).lean();

    const pickupLocation = await resolveSellerPickupLocation(vendorId);
    const metrics = await resolvePackageMetrics(order.items);

    res.status(200).json(
        new ApiResponse(200, { order, shipment, pickupLocation, metrics }, 'Shipment details fetched.')
    );
});

// ─── GET /api/vendor/orders/:id/shipment/tracking ────────────────────────────
export const getVendorShipmentTracking = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found.');

    const awb = order.awbCode || order.externalShipmentId;
    if (!awb) {
        throw new ApiError(404, 'No active shipment tracking available for this order.');
    }

    const tracking = await getTrackingInfo({ externalShipmentId: awb });
    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
    }).select('timeline status externalShipmentId awbCode courierName trackingUrl labelUrl').lean();

    res.status(200).json(
        new ApiResponse(200, { liveTracking: tracking, shipment }, 'Tracking info fetched.')
    );
});

// ─── GET /api/vendor/orders/:id/shipment/label ────────────────────────────────
export const getVendorShipmentLabel = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
    });

    let labelUrl = shipment?.labelUrl || order.labelUrl;
    if (!labelUrl && shipment?.shiprocketShipmentId) {
        try {
            labelUrl = await shiprocketProvider.generateLabel(shipment.shiprocketShipmentId);
            if (labelUrl) {
                shipment.labelUrl = labelUrl;
                order.labelUrl = labelUrl;
                await Promise.all([shipment.save(), order.save()]);
            }
        } catch (err) {
            throw new ApiError(502, `Failed to generate shipping label: ${err.message}`);
        }
    }

    if (!labelUrl) throw new ApiError(404, 'Shipping label not available yet.');
    res.status(200).json(new ApiResponse(200, { labelUrl }, 'Shipping label fetched.'));
});

// ─── GET /api/vendor/orders/:id/shipment/manifest ─────────────────────────────
export const getVendorShipmentManifest = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
    });

    let manifestUrl = shipment?.manifestUrl || order.manifestUrl;
    if (!manifestUrl && shipment?.shiprocketShipmentId) {
        try {
            manifestUrl = await shiprocketProvider.generateManifest(shipment.shiprocketShipmentId);
            if (manifestUrl) {
                shipment.manifestUrl = manifestUrl;
                order.manifestUrl = manifestUrl;
                await Promise.all([shipment.save(), order.save()]);
            }
        } catch (err) {
            throw new ApiError(502, `Failed to generate manifest: ${err.message}`);
        }
    }

    if (!manifestUrl) throw new ApiError(404, 'Manifest document not available yet.');
    res.status(200).json(new ApiResponse(200, { manifestUrl }, 'Manifest fetched.'));
});

// ─── GET /api/vendor/orders/:id/shipment/invoice ──────────────────────────────
export const getVendorShipmentInvoice = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found.');

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
    });

    let invoiceUrl = shipment?.invoiceUrl || order.invoiceUrl;
    if (!invoiceUrl && (shipment?.shiprocketOrderId || order.shiprocketOrderId)) {
        try {
            const srOrderId = shipment?.shiprocketOrderId || order.shiprocketOrderId;
            invoiceUrl = await shiprocketProvider.generateInvoice(srOrderId);
            if (invoiceUrl) {
                shipment.invoiceUrl = invoiceUrl;
                order.invoiceUrl = invoiceUrl;
                await Promise.all([shipment.save(), order.save()]);
            }
        } catch (err) {
            throw new ApiError(502, `Failed to generate invoice: ${err.message}`);
        }
    }

    if (!invoiceUrl) throw new ApiError(404, 'Invoice document not available yet.');
    res.status(200).json(new ApiResponse(200, { invoiceUrl }, 'Invoice fetched.'));
});

// ─── POST /api/vendor/orders/:id/shipment/cancel ─────────────────────────────
export const cancelVendorShipment = asyncHandler(async (req, res) => {
    const vendorId = req.user.id;
    const order = await findVendorOrder(req.params.id, vendorId);
    if (!order) throw new ApiError(404, 'Order not found.');

    if (['delivered'].includes(order.status)) {
        throw new ApiError(409, 'Cannot cancel shipment for a delivered order.');
    }

    const shipment = await DeliveryShipment.findOne({
        $or: [{ orderId: order.orderId }, { orderMongoId: order._id }],
        vendorId,
        status: { $nin: ['cancelled', 'failed'] },
    });

    const result = await cancelShipment({
        externalShipmentId: order.externalShipmentId || shipment?.externalShipmentId,
        shiprocketOrderId:  order.shiprocketOrderId  || shipment?.shiprocketOrderId,
    });

    if (shipment) {
        shipment.status = 'cancelled';
        shipment.shipmentCancelledAt = new Date();
        shipment.timeline.push({ status: 'CANCELLED_BY_SELLER', timestamp: new Date() });
        await shipment.save();
    }

    order.shipmentCancelledAt = new Date();
    order.providerStatus      = 'CANCELLED';
    await order.save();

    res.status(200).json(new ApiResponse(200, { result }, 'Shipment cancellation requested.'));
});
