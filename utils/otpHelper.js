// const nodemailer = require('nodemailer');
// require('dotenv').config();

// const transporter = nodemailer.createTransport({
//     host: 'smtp-relay.brevo.com',
//     port: 587,
//     secure: false,
//     auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASS
//     },
//     tls: { rejectUnauthorized: false }
// });

// const sendOTP = async (toEmail, otp, type = 'verification') => {
//     // هنا بنحدد الكلام اللي هيتكتب حسب النوع
//     const subjectText = type === 'reset' ? 'Reset Your Password' : 'Confirm Your Email';
//     const titleText = type === 'reset' ? 'Password Reset Request' : 'Confirm Your Email';
//     const messageText = type === 'reset' ? 'We received a request to reset your password. Use the code below:' : 'Welcome to Dealio! Use the code below to verify your account.';

//     const mailOptions = {
//         from: '"Dealio" <dealio.eg7@gmail.com>',
//         to: toEmail,
//         subject: `${otp} - ${subjectText}`, // العنوان اللي بيظهر بره
//         html: `
//         <!DOCTYPE html>
//         <html>
//         <head>
//             <meta charset="utf-8">
//             <style>
//                 .main-container { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f4f4f4; padding: 40px 10px; }
//                 .content-card { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border-top: 6px solid #fce108; }
//                 .header { background-color: #000000; padding: 25px; text-align: center; }
//                 .body-content { padding: 40px 30px; text-align: center; }
//                 .otp-box { background-color: #000000; border-radius: 12px; padding: 20px; font-size: 35px; font-weight: bold; letter-spacing: 10px; color: #fce108; margin: 25px 0; border: 1px solid #333; }
//                 .footer { padding: 20px; text-align: center; font-size: 12px; color: #999; }
//             </style>
//         </head>
//         <body>
//             <div class="main-container">
//                 <div class="content-card">
//                     <div class="header">
//                         <table align="center" border="0" cellpadding="0" cellspacing="0">
//                             <tr>
//                                 <td style="padding: 0; vertical-align: middle;">
//                                     <img src="https://i.ibb.co/pBYpbyXd/logo.png" alt="D" width="45" style="display: block; border: 0; margin-right: -5px;" />
//                                 </td>
//                                 <td style="padding: 0; vertical-align: middle;">
//                                     <span style="color: #ffffff; font-size: 38px; font-weight: bold; font-family: sans-serif;">ealio</span>
//                                 </td>
//                             </tr>
//                         </table>
//                     </div>
                    
//                     <div class="body-content">
//                         <h2 style="color: #000; margin: 0; font-size: 22px;">${titleText}</h2>
//                         <p style="color: #555; font-size: 15px; line-height: 1.6; margin-top: 10px;">${messageText}</p>
                        
//                         <div class="otp-box">${otp}</div>
                        
//                         <p style="color: #999; font-size: 12px;">This code expires in 10 minutes.</p>
//                     </div>
                    
//                     <div class="footer">
//                         &copy; ${new Date().getFullYear()} Dealio Team.
//                     </div>
//                 </div>
//             </div>
//         </body>
//         </html>
//         `
//     };

//     try {
//         await transporter.sendMail(mailOptions);
//         console.log(`✅ Email Sent (${type}): Luxury Theme Ready!`);
//     } catch (error) {
//         console.error('❌ Email Error:', error.message);
//         throw error;
//     }
// };

// module.exports = { sendOTP };


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
                        <table align="center" border="0" cellpadding="0" cellspacing="0">
                            <tr>
                                <td style="padding: 0; vertical-align: middle;">
                                    <img src="https://i.ibb.co/pBYpbyXd/logo.png" alt="D" width="45" style="display: block; border: 0; margin-right: -5px;" />
                                </td>
                                <td style="padding: 0; vertical-align: middle;">
                                    <span style="color: #ffffff; font-size: 38px; font-weight: bold; font-family: sans-serif;">ealio</span>
                                </td>
                            </tr>
                        </table>
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

// بدل الكود القديم، استخدم ده:
try {
    // شيلنا الـ await من هنا عشان ميعطلش الكود
    transporter.sendMail(mailOptions).then(() => {
        console.log(`✅ Email Sent (${type})`);
    }).catch((err) => {
        console.error('❌ Email Async Error:', err.message);
    });

    // كدة السيرفر هيعتبر المهمة انتهت وهيرد على فلاتر فوراً
    return true; 
} catch (error) {
    console.error('❌ Setup Error:', error.message);
    // متبعتش throw error هنا عشان ميبوظش عملية التسجيل لو الإيميل بس هو اللي فيه مشكلة
}
};

module.exports = { sendOTP };