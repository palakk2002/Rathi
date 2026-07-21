/**
 * shiprocketProvider.js
 * ──────────────────────
 * Full implementation of IDeliveryProvider for Shiprocket.
 *
 * All methods throw ProviderError on failure so deliveryManager.js can
 * handle errors uniformly without knowing provider internals.
 */

import crypto from 'crypto';
import { shiprocketRequest, refreshShiprocketToken, ProviderError } from './shiprocketClient.js';
import { providerStatusToOrderStatus } from '../../deliveryStatusMapping.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getChannelId() {
    return process.env.SHIPROCKET_CHANNEL_ID || null;
}

/** Build the Shiprocket order payload from a ShipmentContext object. */
function buildOrderPayload(context) {
    const {
        orderId, pickup, drop, items, paymentMode,
        totalValue, weight, channelId,
    } = context;

    const orderItems = (items || []).map((item, idx) => ({
        name:               String(item.name || `Item ${idx + 1}`),
        sku:                String(item.sku   || `SKU-${idx}`),
        units:              Number(item.qty   || 1),
        selling_price:      String(Number(item.value || 0)),
        discount:           '',
        tax:                '',
        hsn:                item.hsn || '',
    }));

    return {
        order_id:             String(orderId),
        order_date:           new Date().toISOString().split('T')[0],
        channel_id:           channelId || getChannelId() || '',
        comment:              '',
        billing_customer_name: String(drop.name   || ''),
        billing_last_name:    '',
        billing_address:      String(drop.address || ''),
        billing_address_2:    '',
        billing_city:         String(drop.city    || ''),
        billing_pincode:      String(drop.pincode || ''),
        billing_state:        String(drop.state   || ''),
        billing_country:      'India',
        billing_email:        String(drop.email   || ''),
        billing_phone:        String(drop.phone   || ''),
        shipping_is_billing:  true,
        payment_method:       String(paymentMode  || 'PREPAID').toUpperCase() === 'COD' ? 'COD' : 'Prepaid',
        sub_total:            Number(totalValue   || 0),
        length:               Number(context.length || 10),
        breadth:              Number(context.breadth || 10),
        height:               Number(context.height  || 5),
        weight:               Number(weight          || 0.5),
        order_items:          orderItems,
        pickup_location:      String(pickup.name     || 'Primary'),
    };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export const shiprocketProvider = {
    name: 'shiprocket',

    // ── createShipment ─────────────────────────────────────────────────────
    async createShipment(context) {
        const payload = buildOrderPayload(context);

        // Step 1: Create order on Shiprocket
        const orderRes = await shiprocketRequest('POST', '/orders/create/adhoc', payload);
        const shipmentId  = orderRes?.shipment_id;
        const orderId     = orderRes?.order_id;

        if (!shipmentId) {
            throw new ProviderError(
                'NO_SHIPMENT_ID',
                `Shiprocket did not return a shipment_id. Response: ${JSON.stringify(orderRes)}`
            );
        }

        // Step 2: Generate AWB
        const awbPayload = {
            shipment_id: [shipmentId],
        };
        if (context.courierId) {
            awbPayload.courier_id = context.courierId;
        }

        const awbRes = await shiprocketRequest('POST', '/courier/assign/awb', awbPayload);
        const awb    = awbRes?.response?.data?.awb_code
                    || awbRes?.awb_code
                    || null;

        const trackingUrl = awb
            ? `https://shiprocket.co/tracking/${awb}`
            : null;

        return {
            externalId:     awb || String(shipmentId),
            trackingUrl,
            label:          null,  // fetch separately if needed via /courier/generate/label
            providerStatus: 'PICKUP SCHEDULED',
            shiprocketOrderId:   orderId,
            shiprocketShipmentId: shipmentId,
        };
    },

    // ── cancelShipment ─────────────────────────────────────────────────────
    async cancelShipment(context) {
        if (!context.externalShipmentId && !context.shiprocketOrderId) {
            return { cancelled: false, reason: 'No Shiprocket order ID available to cancel.' };
        }

        try {
            await shiprocketRequest('POST', '/orders/cancel', {
                ids: [context.shiprocketOrderId || context.externalShipmentId],
            });
            return { cancelled: true };
        } catch (err) {
            return { cancelled: false, reason: err.message };
        }
    },

    // ── getTrackingInfo ────────────────────────────────────────────────────
    async getTrackingInfo(context) {
        const awb = context.externalShipmentId;
        if (!awb) {
            return { providerStatus: null, location: null, etaMinutes: null, etaTimestamp: null, events: [] };
        }

        const res = await shiprocketRequest('GET', `/courier/track/awb/${awb}`);
        const td  = res?.tracking_data;

        if (!td) {
            return { providerStatus: null, location: null, etaMinutes: null, etaTimestamp: null, events: [] };
        }

        const currentStatus = td?.shipment_track?.[0]?.current_status || null;
        const events        = (td?.shipment_track_activities || []).map((e) => ({
            status:    e.activity,
            timestamp: e.date,
            location:  e.location,
        }));

        return {
            providerStatus: currentStatus,
            location:       null,   // Shiprocket does not expose lat/lng in tracking API
            etaMinutes:     null,
            etaTimestamp:   null,
            events,
        };
    },

    // ── getETA ─────────────────────────────────────────────────────────────
    async getETA(context) {
        // Shiprocket doesn't expose a dedicated ETA endpoint — return null safely.
        return { etaMinutes: null, etaTimestamp: null };
    },

    // ── getQuote ───────────────────────────────────────────────────────────
    async getQuote(context) {
        const { pickup, drop, weight, totalValue } = context;

        const params = new URLSearchParams({
            pickup_postcode:   String(pickup?.pincode  || ''),
            delivery_postcode: String(drop?.pincode    || ''),
            weight:            String(Number(weight    || 0.5)),
            cod:               String(String(context.paymentMode || '').toUpperCase() === 'COD' ? 1 : 0),
            declared_value:    String(Number(totalValue || 0)),
        });

        const res = await shiprocketRequest('GET', `/courier/serviceability/?${params.toString()}`);
        const available = res?.data?.available_courier_companies || [];

        if (available.length === 0) {
            throw new ProviderError('NO_COURIERS', 'No couriers available for this route.');
        }

        // Pick the cheapest available courier
        const cheapest = available.sort((a, b) => Number(a.freight_charge) - Number(b.freight_charge))[0];

        return {
            providerName:     'shiprocket',
            price:            Number(cheapest.freight_charge || 0),
            currency:         'INR',
            breakdown: {
                base: Number(cheapest.base_weight_charge    || 0),
                fuel: Number(cheapest.fuel_surcharge        || 0),
                gst:  Number(cheapest.freight_charge_gst   || 0),
            },
            estimatedMinutes: Number(cheapest.etd_hours    || 0) * 60 || null,
            validUntil:       null,
            courierId:        cheapest.courier_company_id,
            courierName:      cheapest.courier_name,
            rawCouriers:      available,
        };
    },

    // ── mapStatus ──────────────────────────────────────────────────────────
    mapStatus(providerStatus) {
        return providerStatusToOrderStatus('shiprocket', providerStatus);
    },

    // ── verifyWebhookSignature ─────────────────────────────────────────────
    verifyWebhookSignature(rawBody, headers) {
        const secret = process.env.SHIPROCKET_WEBHOOK_SECRET;
        if (!secret) {
            // If no secret is configured, warn and accept (so dev env still works)
            console.warn('[shiprocket] SHIPROCKET_WEBHOOK_SECRET not set — skipping signature check');
            return true;
        }

        const receivedSig = String(
            headers['x-shiprocket-signature'] ||
            headers['x-sr-signature']         ||
            ''
        ).trim();

        if (!receivedSig) return false;

        const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(body)
            .digest('hex');

        if (receivedSig.length !== expectedSig.length) return false;

        try {
            return crypto.timingSafeEqual(
                Buffer.from(receivedSig),
                Buffer.from(expectedSig)
            );
        } catch {
            return false;
        }
    },

    // ── parseWebhookPayload ────────────────────────────────────────────────
    parseWebhookPayload(rawBody, _headers) {
        let body;
        try {
            const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
            body = JSON.parse(raw);
        } catch (err) {
            throw new ProviderError('INVALID_WEBHOOK_BODY', 'Cannot parse Shiprocket webhook body as JSON', err);
        }

        // Shiprocket webhook payload shape:
        // { awb_code, current_status, shipment_id, order_id, etd, scans: [...] }
        const orderId        = String(body?.order_id     || body?.customer_order_id || '');
        const externalId     = String(body?.awb_code     || body?.shipment_id       || '');
        const providerStatus = String(body?.current_status || '');

        return {
            orderId,
            externalId,
            providerStatus,
            location: null,
            meta: body,
        };
    },

    // ── refreshToken ───────────────────────────────────────────────────────
    async refreshToken() {
        await refreshShiprocketToken();
    },
};

export default shiprocketProvider;
