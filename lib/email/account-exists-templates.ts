import { getBranding } from '@/lib/branding/service'

/**
 * Sent instead of an error when someone registers with an e-mail address
 * that already has an account, so the signup form does not reveal which
 * addresses are customers.
 */
export function accountExistsEmail(appUrl: string) {
  const { appName } = getBranding()
  const loginUrl = `${appUrl}/login`
  const resetUrl = `${appUrl}/forgot-password`
  return {
    subject: `Du har redan ett konto hos ${appName}`,
    text: `Någon försökte registrera ett nytt konto hos ${appName} med den här e-postadressen, men det finns redan ett konto.

Var det du? Logga in: ${loginUrl}
Glömt lösenordet? Återställ det: ${resetUrl}

Var det inte du kan du ignorera det här meddelandet. Inget har ändrats på ditt konto.`,
    html: `<!DOCTYPE html>
<html lang="sv">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Du har redan ett konto</title></head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${appName.toUpperCase()}</p>
      <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">Du har redan ett konto</h1>
      <p style="margin: 0; color: #666; font-size: 15px;">Någon försökte registrera ett nytt konto med den här e-postadressen. Var det du kan du logga in direkt, eller återställa lösenordet om du glömt det.</p>
      <div style="margin: 28px 0;">
        <a href="${loginUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">Logga in</a>
        <a href="${resetUrl}" style="display: inline-block; margin-left: 12px; color: #111; font-size: 14px;">Återställ lösenord</a>
      </div>
      <p style="margin: 0; color: #999; font-size: 13px;">Var det inte du kan du ignorera det här meddelandet. Inget har ändrats på ditt konto.</p>
    </div>
  </div>
</body>
</html>`,
  }
}
