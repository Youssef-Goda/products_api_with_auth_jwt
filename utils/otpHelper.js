const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
});

const sendOTP = async (toEmail, otp, type = 'verification') => {
    let subjectText, titleText, messageText, showOtp = true;

    // تخصيص الرسالة حسب النوع
    switch (type) {
        case 'reset':
            subjectText = 'Reset Your Password';
            titleText = 'Password Reset Request';
            messageText = 'We received a request to reset your password. Use the code below:';
            break;
        case 'welcome':
            subjectText = 'Welcome to Dealio!';
            titleText = 'Account Verified! 🎉';
            messageText = 'Your account has been successfully created. Welcome to the Dealio community!';
            showOtp = false;
            break;
        case 'reset_success':
            subjectText = 'Password Changed Successfully';
            titleText = 'Security Alert';
            messageText = 'Your password has been changed successfully. If this wasn\'t you, please contact us immediately.';
            showOtp = false;
            break;
        default: // verification
            subjectText = 'Confirm Your Email';
            titleText = 'Confirm Your Email';
            messageText = 'Welcome to Dealio! Use the code below to verify your account.';
    }

    const mailOptions = {
        from: '"Dealio" <dealio.eg7@gmail.com>',
        to: toEmail,
        subject: showOtp ? `${otp} - ${subjectText}` : subjectText,
        html: `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                .main-container { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f4f4f4; padding: 40px 10px; }
                .content-card { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-top: 6px solid #fce108; }
                .header { background-color: #000000; padding: 25px; text-align: center; }
                .body-content { padding: 40px 30px; text-align: center; }
                .otp-box { background-color: #000000; border-radius: 12px; padding: 20px; font-size: 35px; font-weight: bold; letter-spacing: 10px; color: #fce108; margin: 25px 0; border: 1px solid #333; }
                .footer { padding: 20px; text-align: center; font-size: 12px; color: #999; }
                .success-icon { font-size: 50px; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <div class="main-container">
                <div class="content-card">
                    <div class="header">
                        <span style="color: #fce108; font-size: 38px; font-weight: bold; font-family: sans-serif; letter-spacing: -1px;">Dealio</span>
                    </div>
                    
                    <div class="body-content">
                        ${!showOtp ? '<div class="success-icon">✅</div>' : ''}
                        <h2 style="color: #000; margin: 0; font-size: 22px;">${titleText}</h2>
                        <p style="color: #555; font-size: 15px; line-height: 1.6; margin-top: 10px;">${messageText}</p>
                        
                        ${showOtp ? `<div class="otp-box">${otp}</div>` : ''}
                        
                        ${showOtp ? '<p style="color: #999; font-size: 12px;">This code expires in 10 minutes.</p>' : ''}
                    </div>
                    
                    <div class="footer">
                        &copy; ${new Date().getFullYear()} Dealio Team.
                    </div>
                </div>
            </div>
        </body>
        </html>
        `
    };

try {
        // هنستخدم await هنا عشان نضمن إن فيرسال ميفصلش قبل ما يبعت
        // بس هنخلي العملية "أسرع" بأننا مش مستنيين رد طويل
        await transporter.sendMail(mailOptions);
        console.log(`✅ Email Sent (${type})`);
        return true;
    } catch (error) {
        // لو حصل مشكلة في الإيميل، هنطبعها بس مش هنخليها تعمل Crash للمشروع
        console.error('❌ Email Service Error:', error.message);
        
        // لو النوع OTP، ممكن نحتاج نرفع Error عشان اليوزر ميكملش
        // لكن لو welcome إيميل، هنرجّع true عادي عشان التسجيل يكمل
        if (type === 'verification' || type === 'reset') {
            throw new Error('Failed to send verification code');
        }
        return false; 
    }
};

// ═════════════════════════════════════════════════════════════════════════════
// Order Confirmation Email
// ═════════════════════════════════════════════════════════════════════════════
const sendOrderConfirmationEmail = async (toEmail, order, firstName = 'Customer') => {
    const orderId = (order.id || '').toString().slice(0, 8).toUpperCase();
    const createdAt = order.created_at
        ? new Date(order.created_at).toLocaleDateString('en-EG', { year: 'numeric', month: 'long', day: 'numeric' })
        : new Date().toLocaleDateString('en-EG');

    const addr = order.shipping_addresses || {};
    const addrLine = [
        addr.street || addr.address_line_1 || '',
        addr.city || '',
        addr.governorate || addr.state || '',
    ].filter(Boolean).join(', ') || 'N/A';

    const items = Array.isArray(order.order_items) ? order.order_items : [];
    const itemsHtml = items.map(item => `
        <tr>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;">
                <div style="font-weight:600;font-size:13px;color:#222;">${item.product_name || 'Product'}</div>
                ${item.product_code ? `<div style="font-size:11px;color:#999;">${item.product_code}</div>` : ''}
            </td>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:center;color:#555;font-size:13px;">×${item.quantity}</td>
            <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;font-size:13px;color:#222;">
                ${parseFloat(item.subtotal || 0).toFixed(2)} EGP
            </td>
        </tr>`).join('');

    const paymentMap = { cod: '💵 Cash on Delivery', card: '💳 Credit / Debit Card', wallet: '📱 Digital Wallet' };
    const paymentLabel = paymentMap[order.payment_method] || order.payment_method || 'N/A';

    const mailOptions = {
        from: '"Dealio" <dealio.eg7@gmail.com>',
        to: toEmail,
        subject: `Order Confirmed #${orderId} — Dealio`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
            body{margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif;}
            .wrap{padding:40px 10px;}
            .card{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.1);border-top:6px solid #fce108;}
            .hdr{background:#000;padding:22px;text-align:center;}
            .bdy{padding:32px 28px;}
            .badge{display:inline-block;background:#fce108;color:#000;font-weight:bold;font-size:12px;padding:4px 12px;border-radius:20px;margin-bottom:16px;}
            h2{margin:0 0 8px;font-size:22px;color:#111;}
            p{color:#555;font-size:14px;line-height:1.6;margin:0 0 20px;}
            .lbl{font-size:11px;font-weight:700;letter-spacing:1px;color:#999;text-transform:uppercase;margin-bottom:8px;}
            .box{background:#f9f9f9;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#444;}
            table.it{width:100%;border-collapse:collapse;margin-bottom:20px;}
            table.it th{text-align:left;font-size:11px;letter-spacing:.8px;color:#999;text-transform:uppercase;padding:6px 8px;border-bottom:2px solid #f0f0f0;}
            table.it th:last-child{text-align:right;}table.it th:nth-child(2){text-align:center;}
            .tot{background:#000;border-radius:10px;padding:16px 18px;color:#fff;margin-bottom:24px;}
            .tr{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;color:#ccc;}
            .tr.g{font-size:16px;font-weight:bold;color:#fce108;margin-top:10px;border-top:1px solid #333;padding-top:10px;margin-bottom:0;}
            .ftr{padding:18px;text-align:center;font-size:12px;color:#bbb;}
        </style></head><body>
        <div class="wrap"><div class="card">
            <div class="hdr"><span style="color:#fce108;font-size:36px;font-weight:bold;letter-spacing:-1px;">Dealio</span></div>
            <div class="bdy">
                <div class="badge">✅ Order Confirmed</div>
                <h2>Thank you, ${firstName}!</h2>
                <p>Your order <strong>#${orderId}</strong> has been received and is being processed. We'll notify you when it ships!</p>
                <div class="lbl">Order Details</div>
                <div class="box">
                    📅 Date: <strong>${createdAt}</strong><br>
                    💳 Payment: <strong>${paymentLabel}</strong>
                    ${order.notes ? `<br>📝 Notes: <em>${order.notes}</em>` : ''}
                </div>
                <div class="lbl">Shipping Address</div>
                <div class="box">📍 ${addrLine}</div>
                <div class="lbl">Items</div>
                <table class="it">
                    <thead><tr><th>Product</th><th>Qty</th><th>Total</th></tr></thead>
                    <tbody>${itemsHtml}</tbody>
                </table>
                <div class="tot">
                    <div class="tr"><span>Subtotal </span><span>${parseFloat(order.subtotal||0).toFixed(2)} EGP</span></div>
                    ${order.tax ? `<div class="tr"><span>Tax </span><span>${parseFloat(order.tax).toFixed(2)} EGP</span></div>` : ''}
                    <div class="tr g"><span>Grand Total </span><span>${parseFloat(order.total||0).toFixed(2)} EGP</span></div>
                </div>
                <p style="text-align:center;color:#999;font-size:13px;">Questions? Reply to this email.</p>
            </div>
            <div class="ftr">&copy; ${new Date().getFullYear()} Dealio Team.</div>
        </div></div></body></html>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Order confirmation email sent to ${toEmail}`);
    } catch (err) {
        console.error('❌ Order email error:', err.message);
        // Non-fatal — order is already placed
    }
};

module.exports = { sendOTP, sendOrderConfirmationEmail };
// ═════════════════════════════════════════════════════════════════════════════
// New Login Security Email
// ═════════════════════════════════════════════════════════════════════════════
const sendNewLoginEmail = async (toEmail, deviceInfo, firstName = 'User') => {
    // Sanitize device info to prevent HTML injection
    const escapeHtml = (unsafe) => {
        return (unsafe || '').toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    };
    
    const safeDeviceInfo = escapeHtml(deviceInfo || 'Unknown Device');
    const timeNow = new Date().toLocaleString('en-EG', { dateStyle: 'long', timeStyle: 'short' });

    const mailOptions = {
        from: '"Dealio Security" <dealio.eg7@gmail.com>',
        to: toEmail,
        subject: 'New Login to your Dealio account',
        html: `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { margin: 0; padding: 0; background: #f4f4f4; font-family: 'Segoe UI', Arial, sans-serif; }
                .wrap { padding: 40px 10px; }
                .card { max-width: 500px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.1); border-top: 6px solid #fce108; }
                .hdr { background: #000; padding: 22px; text-align: center; }
                .bdy { padding: 32px 28px; }
                .badge { display: inline-block; background: #ffe6e6; color: #d32f2f; font-weight: bold; font-size: 12px; padding: 6px 14px; border-radius: 20px; margin-bottom: 16px; }
                h2 { margin: 0 0 12px; font-size: 22px; color: #111; }
                p { color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
                .box { background: #f9f9f9; border-left: 4px solid #fce108; padding: 16px; margin-bottom: 24px; font-size: 14px; color: #333; }
                .ftr { padding: 18px; text-align: center; font-size: 12px; color: #bbb; }
            </style>
        </head>
        <body>
            <div class="wrap">
                <div class="card">
                    <div class="hdr"><span style="color:#fce108;font-size:32px;font-weight:bold;letter-spacing:-1px;">Dealio</span></div>
                    <div class="bdy">
                        <div class="badge">Security Alert</div>
                        <h2>New Login Detected</h2>
                        <p>Hi ${escapeHtml(firstName)},</p>
                        <p>We noticed a new login to your Dealio account. If this was you, you don't need to do anything. If you don't recognize this activity, please change your password immediately.</p>
                        
                        <div class="box">
                            <strong>Login Details:</strong><br><br>
                            📱 <strong>Platform/Device:</strong> ${safeDeviceInfo}<br>
                            🕒 <strong>Time:</strong> ${timeNow}
                        </div>
                    </div>
                    <div class="ftr">&copy; ${new Date().getFullYear()} Dealio Security.</div>
                </div>
            </div>
        </body>
        </html>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Login alert email sent to ${toEmail}`);
    } catch (err) {
        // We log safely and DO NOT THROW, preventing login failure.
        console.error('❌ Login alert email error:', err.message);
    }
};

module.exports = { sendOTP, sendOrderConfirmationEmail, sendNewLoginEmail };