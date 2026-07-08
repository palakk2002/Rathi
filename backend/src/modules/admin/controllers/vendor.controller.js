import asyncHandler from '../../../utils/asyncHandler.js';
import ApiResponse from '../../../utils/ApiResponse.js';
import ApiError from '../../../utils/ApiError.js';
import Vendor from '../../../models/Vendor.model.js';
import Commission from '../../../models/Commission.model.js';
import { sendEmail } from '../../../services/email.service.js';
import { createNotification } from '../../../services/notification.service.js';

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toApiVendor = (vendorDoc) => {
    const vendor = typeof vendorDoc?.toObject === 'function'
        ? vendorDoc.toObject()
        : (vendorDoc || {});

    const normalizedId = vendor?._id ? String(vendor._id) : String(vendor?.id || '');
    const normalizedCommissionRate = Number(vendor.commissionRate);
    return {
        ...vendor,
        id: normalizedId,
        commissionRate: Number.isFinite(normalizedCommissionRate)
            ? normalizedCommissionRate / 100
            : 0
    };
};

// GET /api/admin/vendors
export const getAllVendors = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20, search } = req.query;
    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const numericLimit = Math.max(parseInt(limit, 10) || 20, 1);
    const skip = (numericPage - 1) * numericLimit;
    const filter = {};

    const allowedStatuses = new Set(['pending', 'approved', 'suspended', 'rejected', 'action_required']);
    if (typeof status === 'string' && status !== 'all' && allowedStatuses.has(status)) {
        filter.status = status;
    }

    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch) {
        const safeRegex = new RegExp(escapeRegex(trimmedSearch), 'i');
        filter.$or = [{ name: safeRegex }, { email: safeRegex }, { storeName: safeRegex }];
    }

    const vendors = await Vendor.find(filter)
        .select('-password -otp -otpExpiry')
        .populate('categories', 'name slug')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(numericLimit);
    const total = await Vendor.countDocuments(filter);
    res.status(200).json(
        new ApiResponse(200, {
            vendors: vendors.map(toApiVendor),
            total,
            page: numericPage,
            pages: Math.ceil(total / numericLimit)
        }, 'Vendors fetched.')
    );
});

// GET /api/admin/vendors/:id
export const getVendorDetail = asyncHandler(async (req, res) => {
    const vendor = await Vendor.findById(req.params.id).select('-password -otp -otpExpiry').populate('categories', 'name slug');
    if (!vendor) throw new ApiError(404, 'Vendor not found.');
    res.status(200).json(new ApiResponse(200, toApiVendor(vendor), 'Vendor detail fetched.'));
});

// PATCH /api/admin/vendors/:id/status
export const updateVendorStatus = asyncHandler(async (req, res) => {
    const { status, reason } = req.body;
    const allowed = ['approved', 'suspended', 'rejected', 'action_required'];
    if (!allowed.includes(status)) throw new ApiError(400, `Status must be one of: ${allowed.join(', ')}`);

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) throw new ApiError(404, 'Vendor not found.');

    vendor.status = status;
    if (status === 'suspended') {
        vendor.suspensionReason = reason || '';
    }

    const adminId = req.user.id;
    const adminName = req.user.name || 'Admin';

    vendor.verificationTimeline.push({
        status,
        remarks: reason || `Vendor account status updated to ${status}.`,
        updatedBy: adminId,
        updatedByName: adminName,
        updatedAt: new Date()
    });

    vendor.verificationAuditLog.push({
        action: `status_change_${status}`,
        details: `Administrator ${adminName} updated status to ${status}.${reason ? ` Reason/Remarks: ${reason}` : ''}`,
        performedBy: {
            id: adminId,
            name: adminName,
            role: 'admin'
        },
        timestamp: new Date()
    });

    await vendor.save();

    const statusMessageMap = {
        approved: `Your vendor account for ${vendor.storeName || vendor.name} has been approved.`,
        rejected: `Your vendor account for ${vendor.storeName || vendor.name} has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
        suspended: `Your vendor account for ${vendor.storeName || vendor.name} has been suspended.${reason ? ` Reason: ${reason}` : ''}`,
        action_required: `Your vendor account for ${vendor.storeName || vendor.name} requires action/re-upload.${reason ? ` Remarks: ${reason}` : ''}`,
    };
    const vendorMessage = statusMessageMap[status] || `Your vendor account status was updated to ${status}.`;

    await createNotification({
        recipientId: vendor._id,
        recipientType: 'vendor',
        title: 'Vendor Account Status Updated',
        message: vendorMessage,
        type: 'system',
        data: {
            status,
            reason: reason || '',
        },
    });

    try {
        const subjectStatus = status === 'action_required' ? 'Action Required' : `${status[0].toUpperCase()}${status.slice(1)}`;
        await sendEmail({
            to: vendor.email,
            subject: `Vendor Account ${subjectStatus}`,
            text: vendorMessage,
            html: `<p>${vendorMessage}</p>`,
        });
    } catch (err) {
        console.warn(`Vendor status email failed for ${vendor.email}: ${err.message}`);
    }

    res.status(200).json(new ApiResponse(200, toApiVendor(vendor), `Vendor ${status} successfully.`));
});

// PATCH /api/admin/vendors/:id/commission
export const updateCommissionRate = asyncHandler(async (req, res) => {
    const { commissionRate } = req.body;
    const parsedRate = Number(commissionRate);
    if (Number.isNaN(parsedRate) || parsedRate < 0) {
        throw new ApiError(400, 'Commission rate must be a valid non-negative number.');
    }
    const dbCommissionRate = parsedRate <= 1 ? parsedRate * 100 : parsedRate;
    if (dbCommissionRate > 100) throw new ApiError(400, 'Commission rate must be between 0 and 100.');

    const vendor = await Vendor.findByIdAndUpdate(req.params.id, { commissionRate: dbCommissionRate }, { new: true });
    if (!vendor) throw new ApiError(404, 'Vendor not found.');
    res.status(200).json(new ApiResponse(200, toApiVendor(vendor), 'Commission rate updated.'));
});

// GET /api/admin/vendors/:id/commissions
export const getVendorCommissions = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 20, status = 'all' } = req.query;

    const vendor = await Vendor.findById(id).select('_id');
    if (!vendor) throw new ApiError(404, 'Vendor not found.');

    const numericPage = Math.max(parseInt(page, 10) || 1, 1);
    const numericLimit = Math.max(parseInt(limit, 10) || 20, 1);
    const skip = (numericPage - 1) * numericLimit;

    const filter = { vendorId: vendor._id };
    if (status && status !== 'all') {
        filter.status = status;
    }

    const [commissions, total] = await Promise.all([
        Commission.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(numericLimit)
            .lean(),
        Commission.countDocuments(filter),
    ]);

    res.status(200).json(
        new ApiResponse(
            200,
            {
                commissions,
                total,
                page: numericPage,
                pages: Math.ceil(total / numericLimit),
            },
            'Vendor commissions fetched.'
        )
    );
});
