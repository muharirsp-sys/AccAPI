import nodemailer from "nodemailer";

interface SendEmailOptions {
    to: string;
    subject: string;
    text: string;
    html?: string;
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
    },
});

export async function sendEmail({ to, subject, text, html }: SendEmailOptions) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
        console.warn("⚠️ SMTP credentials not configured. Email blocked:", { to, subject });
        return false;
    }

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM || `"ERP Support" <${process.env.SMTP_USER}>`,
            to,
            subject,
            text,
            html: html || `<p>${text}</p>`,
        });

        console.log("✉️ Email sent successfully! Message ID:", info.messageId);
        
        // Membantu proses Testing (Link Ethereal Preview akan muncul di terminal NextJS)
        if (process.env.SMTP_HOST === 'smtp.ethereal.email') {
            console.log("🔗 Preview test email: %s", nodemailer.getTestMessageUrl(info));
        }

        return true;
    } catch (error) {
        console.error("Failed to send email:", error);
        return false;
    }
}
