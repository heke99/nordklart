import { getBranding } from '@/lib/branding/service'
import { escapeHtml } from '@/lib/email/escape-html'

export interface InviteEmailData {
  companyName: string
  inviterEmail: string
  inviteUrl: string
}

export function generateInviteEmailSubject(data: InviteEmailData): string {
  const { appName } = getBranding()
  return `Du har bjudits in till ${data.companyName} på ${appName.toLowerCase()}`
}

export function generateInviteEmailHtml(data: InviteEmailData): string {
  const companyName = escapeHtml(data.companyName)
  const inviterEmail = escapeHtml(data.inviterEmail)
  const { inviteUrl } = data
  const { appName } = getBranding()

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbjudan till ${companyName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <!-- Header -->
      <div style="margin-bottom: 28px;">
        <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${appName.toUpperCase()}</p>
        <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">
          Du har blivit inbjuden
        </h1>
        <p style="margin: 0; color: #666; font-size: 15px;">
          <strong>${inviterEmail}</strong> har bjudit in dig till <strong>${companyName}</strong> på ${appName.toLowerCase()}.
        </p>
      </div>

      <!-- CTA -->
      <div style="margin: 28px 0;">
        <a href="${inviteUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Acceptera inbjudan
        </a>
      </div>

      <!-- Info -->
      <p style="margin: 0; color: #999; font-size: 13px;">
        Länken är giltig i 7 dagar. Om du inte förväntade dig denna inbjudan kan du ignorera detta meddelande.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateInviteEmailText(data: InviteEmailData): string {
  const { appName } = getBranding()
  return `Du har bjudits in till ${data.companyName} på ${appName.toLowerCase()} av ${data.inviterEmail}.

Acceptera inbjudan: ${data.inviteUrl}

Länken är giltig i 7 dagar.`
}

// =============================================================================
// Team invite email templates
// =============================================================================

export interface TeamInviteEmailData {
  inviterEmail: string
  inviteUrl: string
}

export function generateTeamInviteEmailSubject(): string {
  const { appName } = getBranding()
  return `Du har bjudits in till ett team på ${appName.toLowerCase()}`
}

export function generateTeamInviteEmailHtml(data: TeamInviteEmailData): string {
  const inviterEmail = escapeHtml(data.inviterEmail)
  const { inviteUrl } = data
  const { appName } = getBranding()

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbjudan till team</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <!-- Header -->
      <div style="margin-bottom: 28px;">
        <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${appName.toUpperCase()}</p>
        <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">
          Du har blivit inbjuden till ett team
        </h1>
        <p style="margin: 0; color: #666; font-size: 15px;">
          <strong>${inviterEmail}</strong> har bjudit in dig som konsult. Du får tillgång till alla företag i teamet.
        </p>
      </div>

      <!-- CTA -->
      <div style="margin: 28px 0;">
        <a href="${inviteUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Acceptera inbjudan
        </a>
      </div>

      <!-- Info -->
      <p style="margin: 0; color: #999; font-size: 13px;">
        Länken är giltig i 7 dagar. Om du inte förväntade dig denna inbjudan kan du ignorera detta meddelande.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateTeamInviteEmailText(data: TeamInviteEmailData): string {
  const { appName } = getBranding()
  return `Du har bjudits in som konsult till ett team på ${appName.toLowerCase()} av ${data.inviterEmail}. Du får tillgång till alla företag i teamet.

Acceptera inbjudan: ${data.inviteUrl}

Länken är giltig i 7 dagar.`
}

// =============================================================================
// Agency (redovisningsbyrå) staff invite email templates
// =============================================================================

export interface AgencyInviteEmailData {
  agencyName: string
  inviterEmail: string
  inviteUrl: string
  roleLabel: string
}

export const AGENCY_INVITE_ROLE_LABELS: Record<string, string> = {
  agency_admin: 'byråadministratör',
  accountant: 'redovisningskonsult',
  payroll: 'lönekonsult',
  reviewer: 'granskare',
  read_only: 'medarbetare med läsbehörighet',
}

export function generateAgencyInviteEmailSubject(data: AgencyInviteEmailData): string {
  const { appName } = getBranding()
  return `Du har bjudits in till redovisningsbyrån ${data.agencyName} på ${appName.toLowerCase()}`
}

export function generateAgencyInviteEmailHtml(data: AgencyInviteEmailData): string {
  const agencyName = escapeHtml(data.agencyName)
  const inviterEmail = escapeHtml(data.inviterEmail)
  const roleLabel = escapeHtml(data.roleLabel)
  const { inviteUrl } = data
  const { appName } = getBranding()

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbjudan till ${agencyName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <!-- Header -->
      <div style="margin-bottom: 28px;">
        <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${appName.toUpperCase()}</p>
        <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">
          Du har blivit inbjuden till en redovisningsbyrå
        </h1>
        <p style="margin: 0; color: #666; font-size: 15px;">
          <strong>${inviterEmail}</strong> har bjudit in dig som ${roleLabel} till <strong>${agencyName}</strong> på ${appName.toLowerCase()}.
        </p>
      </div>

      <!-- CTA -->
      <div style="margin: 28px 0;">
        <a href="${inviteUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Acceptera inbjudan
        </a>
      </div>

      <!-- Info -->
      <p style="margin: 0; color: #999; font-size: 13px;">
        Länken är giltig i 7 dagar. Om du inte förväntade dig denna inbjudan kan du ignorera detta meddelande.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateAgencyInviteEmailText(data: AgencyInviteEmailData): string {
  const { appName } = getBranding()
  return `Du har bjudits in som ${data.roleLabel} till redovisningsbyrån ${data.agencyName} på ${appName.toLowerCase()} av ${data.inviterEmail}.

Acceptera inbjudan: ${data.inviteUrl}

Länken är giltig i 7 dagar.`
}

// =============================================================================
// Agency link request (to the client company's owners/admins)
// =============================================================================

export interface AgencyLinkRequestEmailData {
  agencyName: string
  companyName: string
  reviewUrl: string
}

export function generateAgencyLinkRequestEmailSubject(data: AgencyLinkRequestEmailData): string {
  return `${data.agencyName} begär åtkomst till ${data.companyName}`
}

export function generateAgencyLinkRequestEmailHtml(data: AgencyLinkRequestEmailData): string {
  const agencyName = escapeHtml(data.agencyName)
  const companyName = escapeHtml(data.companyName)
  const { appName } = getBranding()
  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Byrå begär åtkomst</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${appName.toUpperCase()}</p>
      <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">En byrå begär åtkomst</h1>
      <p style="margin: 0; color: #666; font-size: 15px;">
        Redovisningsbyrån <strong>${agencyName}</strong> vill få åtkomst till bokföringen för <strong>${companyName}</strong>.
        Ingen åtkomst ges förrän en ägare eller administratör godkänner kopplingen.
      </p>
      <div style="margin: 28px 0;">
        <a href="${data.reviewUrl}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          Granska begäran
        </a>
      </div>
      <p style="margin: 0; color: #999; font-size: 13px;">
        Känner du inte igen byrån kan du avslå begäran under Inställningar → Företag.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateAgencyLinkRequestEmailText(data: AgencyLinkRequestEmailData): string {
  return `Redovisningsbyrån ${data.agencyName} vill få åtkomst till bokföringen för ${data.companyName}.
Ingen åtkomst ges förrän en ägare eller administratör godkänner kopplingen.

Granska begäran: ${data.reviewUrl}`
}
