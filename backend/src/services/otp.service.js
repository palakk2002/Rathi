import crypto from 'crypto';
import { sendOTPEmail } from './email.service.js';

/**
 * Generates a 6-digit OTP and sets expiry (10 minutes)
 * @param {Object} user - Mongoose user/vendor document
 * @param {string} type - Purpose label (for logging)
 */
export const sendOTP = async (user, type = 'verification') => {
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save({ validateBeforeSave: false });

    // Format human-readable title & user type according to type tag
    let title = 'Verification Code';
    let userType = 'Account';
    if (type.includes('vendor')) {
        title = 'Seller Account Verification';
        userType = 'Seller';
    } else if (type.includes('email')) {
        title = 'Email Verification';
        userType = 'Customer';
    } else if (type.includes('login')) {
        title = 'Login Verification';
        userType = 'Account';
    }

    if (user.email) {
        sendOTPEmail({
            to: user.email,
            otp,
            title,
            userType,
        }).then(() => {
            console.log(`[OTP Email Success] Verification email sent to ${user.email}`);
        }).catch((err) => {
            console.error(`[OTP Email Error] Failed to send email to ${user.email}:`, err.message);
        });
    }

    if (process.env.NODE_ENV !== 'production') {
        console.log(`[OTP] ${type} OTP generated for ${user.email || user.phone}: ${otp}`);
    }

    return otp;
};

