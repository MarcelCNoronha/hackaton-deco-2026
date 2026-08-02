import { Resend } from "resend";
import { env } from "../config/env.js";

export interface EmailClient {
  send(params: { to: string; subject: string; html: string }): Promise<void>;
}

/** Thin wrapper around Resend — the only email-sending path in the app. */
export class ResendEmailClient implements EmailClient {
  private readonly resend: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.resend = new Resend(apiKey);
  }

  async send(params: { to: string; subject: string; html: string }): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: this.from,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
    if (error) throw new Error(`Resend error: ${error.message}`);
  }
}

/** Returns null when RESEND_API_KEY/RESEND_FROM_EMAIL aren't configured — callers fall back to
 *  returning the link directly in the API response instead of emailing it (today's behavior,
 *  and still how local dev works without a Resend account). */
export function buildEmailClient(): EmailClient | null {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return null;
  return new ResendEmailClient(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL);
}

function emailShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#0d0d0d;font-family:-apple-system,'Segoe UI',Roboto,Inter,sans-serif;">
    <table role="presentation" width="100%" style="background:#0d0d0d;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" style="background:#1a1a19;border-radius:14px;padding:32px;color:#ffffff;">
            <tr>
              <td>
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
                  <span style="display:inline-flex;width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#3987e5,#1c5cab);color:#fff;font-weight:800;font-size:13px;align-items:center;justify-content:center;">C</span>
                  <strong style="font-size:16px;">CatalogIA</strong>
                </div>
                <h1 style="font-size:18px;margin:0 0 12px;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildPasswordResetEmail(resetUrl: string): { subject: string; html: string } {
  return {
    subject: "Redefinir sua senha — CatalogIA",
    html: emailShell(
      "Redefinir senha",
      `<p style="color:#c3c2b7;font-size:14px;line-height:1.5;">Recebemos um pedido para redefinir sua senha. Clique no botão abaixo para escolher uma nova — o link expira em 1 hora.</p>
       <p style="margin:24px 0;"><a href="${resetUrl}" style="background:#3987e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px;font-weight:600;font-size:14px;display:inline-block;">Redefinir senha</a></p>
       <p style="color:#898781;font-size:12px;">Se você não pediu isso, pode ignorar este e-mail com segurança.</p>`,
    ),
  };
}

export function buildAccountSetupEmail(setupUrl: string): { subject: string; html: string } {
  return {
    subject: "Configure sua senha — CatalogIA",
    html: emailShell(
      "Você foi convidado para o CatalogIA",
      `<p style="color:#c3c2b7;font-size:14px;line-height:1.5;">Um administrador criou uma conta pra você. Clique no botão abaixo pra definir sua senha e acessar — o link expira em 1 hora.</p>
       <p style="margin:24px 0;"><a href="${setupUrl}" style="background:#3987e5;color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px;font-weight:600;font-size:14px;display:inline-block;">Definir senha</a></p>`,
    ),
  };
}
