import https from 'https';
import http from 'http';
import { sendEmail, sendOTPEmail } from './email.service.js';

/**
 * Sends SMS via configured SMS Provider (Fast2SMS / Twilio / Custom HTTP)
 * Falls back to Email delivery and console logging when SMS gateway credentials are not configured or fail.
 * 
 * @param {Object} options
 * @param {string} options.phone - 10-digit recipient phone number
 * @param {string} options.otp - 6-digit OTP code
 * @param {string} [options.email] - Optional recipient email address for fallback delivery
 */
export const sendSMS = async ({ phone, otp, email }) => {
    const normalizedPhone = String(phone || '').replace(/\D/g, '').slice(-10);
    const message = `Your Raathi verification code is ${otp}. Valid for 10 minutes.`;

    const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
    let smsSent = false;

    // 1. Try Fast2SMS Provider if configured
    if (provider === 'fast2sms' || process.env.FAST2SMS_API_KEY) {
        const apiKey = process.env.FAST2SMS_API_KEY;
        if (apiKey) {
            try {
                await sendFast2SMS({ apiKey, phone: normalizedPhone, message, otp });
                smsSent = true;
                console.log(`[SMS] Fast2SMS sent successfully to +91${normalizedPhone}`);
            } catch (err) {
                console.error(`[SMS Error] Fast2SMS failed for ${normalizedPhone}:`, err.message);
            }
        }
    }

    // 2. Try Twilio Provider if configured
    if (!smsSent && (provider === 'twilio' || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN))) {
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const auth = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_PHONE_NUMBER;
        if (sid && auth && fromNumber) {
            try {
                await sendTwilioSMS({ sid, auth, fromNumber, phone: normalizedPhone, message });
                smsSent = true;
                console.log(`[SMS] Twilio SMS sent successfully to +91${normalizedPhone}`);
            } catch (err) {
                console.error(`[SMS Error] Twilio SMS failed for ${normalizedPhone}:`, err.message);
            }
        }
    }

    // Always log OTP to server console
    console.log(`[PHONE OTP] OTP for +91${normalizedPhone} is: ${otp}`);

    // 3. Dispatch Email OTP backup if user has a valid non-dummy email address
    if (email && !email.endsWith('@raathi.com')) {
        sendOTPEmail({
            to: email,
            otp,
            title: 'Login OTP Verification',
            userType: 'Customer',
        }).catch((err) => {
            console.warn(`[SMS Fallback Email] Failed to send email to ${email}: ${err.message}`);
        });
    }

    return { success: true, smsSent };
};


/**
 * Fast2SMS API integration (Popular Indian SMS Gateway)
 */
function sendFast2SMS({ apiKey, phone, message, otp }) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            route: 'otp',
            variables_values: otp,
            numbers: phone,
        });

        const req = https.request(
            'https://www.fast2sms.com/dev/bulkV2',
            {
                method: 'POST',
                headers: {
                    authorization: apiKey,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`Fast2SMS responded status ${res.statusCode}: ${body}`));
                    }
                });
            }
        );

        req.on('error', (err) => reject(err));
        req.write(postData);
        req.end();
    });
}

/**
 * Twilio REST API integration
 */
function sendTwilioSMS({ sid, auth, fromNumber, phone, message }) {
    return new Promise((resolve, reject) => {
        const toNumber = phone.startsWith('+') ? phone : `+91${phone}`;
        const params = new URLSearchParams({
            To: toNumber,
            From: fromNumber,
            Body: message,
        }).toString();

        const authHeader = 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64');

        const req = https.request(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
            {
                method: 'POST',
                headers: {
                    Authorization: authHeader,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(params),
                },
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`Twilio responded status ${res.statusCode}: ${body}`));
                    }
                });
            }
        );

        req.on('error', (err) => reject(err));
        req.write(params);
        req.end();
    });
}
