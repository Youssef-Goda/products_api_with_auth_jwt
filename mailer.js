// const nodemailer = require('nodemailer');

// const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: {
//         user: 'dealio.eg7@gmail.com',
//         pass: 'toei cqff fvkx jwaw',
//     },
// });

// async function sendOTP(toEmail, otp) {
//     const mailOptions = {
//         from: 'dealio.eg7@gmail.com',
//         to: toEmail,
//         subject: `${otp} is the temporary password to verify your account on Dealio`,
//   text: `
// Hello,

// Your temporary password is: ${otp}

// Please note that this password is temporary and will expire in 5 minutes. If you encounter any problems, contact our customer support team.

// Thanks,
// Dealio Team
//         `,
//         html: `
//         <!DOCTYPE html>
//         <html>
//         <head>
//             <meta charset="utf-8">
//             <meta name="viewport" content="width=device-width, initial-scale=1.0">
//             <title>Dealio Account Verification</title>
//             <style>
//                 body {
//                     margin: 0;
//                     padding: 0;
//                     -webkit-text-size-adjust: 100%;
//                     -ms-text-size-adjust: 100%;
//                 }
//                 table, td {
//                     mso-table-lspace: 0pt !important;
//                     mso-table-rspace: 0pt !important;
//                 }
//                 img {
//                     -ms-interpolation-mode: bicubic;
//                 }
//                 @media screen and (max-width: 600px) {
//                     .content-wrapper {
//                         padding: 10px !important;
//                     }
//                     .otp-box {
//                         font-size: 20px !important;
//                         padding: 10px !important;
//                     }
//                 }
//             </style>
//         </head>
//         <body style="font-family: Arial, sans-serif; direction: ltr; text-align: left; background-color: #f4f4f4; margin: 0; padding: 0;">
//             <center style="width: 100%; background-color: #f4f4f4;">
//                 <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #eeeeee; box-shadow: 0 0 10px rgba(0,0,0,0.05);">
//                     <div class="content-wrapper" style="padding: 20px;">
//                         <h2 style="color:#000; font-size:24px; margin-top: 0;">Verify Your Account</h2>
//                         <p style="font-size: 16px; line-height: 24px; color: #333333;">Hello,</p>
//                         <p style="font-size: 16px; line-height: 24px; color: #333333;">Your temporary password is:</p>
//                         <div class="otp-box" style="background:#fff8dc; padding:15px; font-size:24px; text-align:center; letter-spacing:10px; margin:20px 0; border-radius: 8px; color: #000;">
//                             <strong>${otp}</strong>
//                         </div>
//                         <p style="font-size: 14px; line-height: 22px; color: #666666;">Please note that this password is temporary and will expire in 5 minutes. If you encounter any problems, contact our customer support team.</p>
//                         <p style="font-size: 16px; line-height: 24px; color: #333333;">Thanks,<br>Dealio Team</p>
//                     </div>
//                     <div style="background-color: #f8f8f8; padding: 15px; text-align: center; font-size: 12px; color: #999999;">
//                         &copy; ${new Date().getFullYear()} Dealio. All rights reserved.
//                     </div>
//                 </div>
//             </center>
//         </body>
//         </html>
//         `,
//     };

//     try {
//         let info = await transporter.sendMail(mailOptions);
//         console.log('Email sent: ' + info.response);
//     } catch (err) {
//         console.error('Error sending email: ', err);
//     }
// }

// module.exports = { sendOTP };



const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'dealio.eg7@gmail.com',
        pass: 'toei cqff fvkx jwaw',
    },
});

async function sendOTP(toEmail, otp) {
    const mailOptions = {
        from: 'dealio.eg7@gmail.com',
        to: toEmail,
        subject: `${otp} is the temporary password to verify your account on Dealio`,
        text: `
Hello,

Your temporary password is: ${otp}

Please note that this password is temporary and will expire in 5 minutes. If you encounter any problems, contact our customer support team.

Thanks,
Dealio Team
        `,
        html: `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dealio Account Verification</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    -webkit-text-size-adjust: 100%;
                    -ms-text-size-adjust: 100%;
                }
                table, td {
                    mso-table-lspace: 0pt !important;
                    mso-table-rspace: 0pt !important;
                }
                img {
                    -ms-interpolation-mode: bicubic;
                }
                @media screen and (max-width: 600px) {
                    .content-wrapper {
                        padding: 10px !important;
                    }
                    .otp-box {
                        font-size: 20px !important;
                        padding: 10px !important;
                    }
                }
            </style>
        </head>
        <body style="font-family: Arial, sans-serif; direction: ltr; text-align: left; background-color: #f4f4f4; margin: 0; padding: 0;">
            <center style="width: 100%; background-color: #f4f4f4;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #eeeeee; box-shadow: 0 0 10px rgba(0,0,0,0.05);">
                    <div class="content-wrapper" style="padding: 20px;">
                        <h2 style="color:#000; font-size:24px; margin-top: 0;">Verify Your Account</h2>
                        <p style="font-size: 16px; line-height: 24px; color: #333333;">Hello,</p>
                        <p style="font-size: 16px; line-height: 24px; color: #333333;">Your temporary password is:</p>
                        <div class="otp-box" style="background:#fff8dc; padding:15px; font-size:24px; text-align:center; letter-spacing:10px; margin:20px 0; border-radius: 8px; color: #000;">
                            <strong>${otp}</strong>
                        </div>
                        <p style="font-size: 14px; line-height: 22px; color: #666666;">Please note that this password is temporary and will expire in 5 minutes. If you encounter any problems, contact our customer support team.</p>
                        <p style="font-size: 16px; line-height: 24px; color: #333333;">Thanks,<br>Dealio Team</p>
                    </div>
                    <div style="background-color: #f8f8f8; padding: 15px; text-align: center; font-size: 12px; color: #999999;">
                        &copy; ${new Date().getFullYear()} Dealio. All rights reserved.
                    </div>
                </div>
            </center>
        </body>
        </html>
        `,
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
        return info; // مهم جداً نرجع النتيجة
    } catch (err) {
        console.error('Error sending email: ', err);
        throw err; // دي اللي هتخلي السيرفر "يحس" بالفشل ويوقف العملية
    }
}

module.exports = { sendOTP };