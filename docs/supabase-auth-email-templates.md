# Supabase Auth-emailmallar för Nordklart

Nordklarts vanliga `email_templates` i databasen styr inte Supabase Auths systemmail.
Bekräftelse av e-post, återställning av lösenord, magic links och Supabase-inbjudningar
konfigureras i **Supabase Dashboard → Authentication → Email Templates**.

## URL-konfiguration

I **Authentication → URL Configuration**:

```text
Site URL
https://nordklart.se
```

Tillåt minst:

```text
https://nordklart.se/**
https://www.nordklart.se/**
http://localhost:3000/**
https://*.vercel.app/**
```

Använd bara `app.nordklart.se` om den subdomänen faktiskt används.

## Viktigt

Använd `{{ .TokenHash }}` i mallarna nedan. Den vägen verifieras i
`/auth/callback` med `verifyOtp()` och fungerar även när länken öppnas i en
annan webbläsare eller e-postapp än den som användes vid signup.

Använd inte `{{ .ConfirmationURL }}` för nya Nordklart-mallar.

## Confirm signup

**Subject**

```text
Bekräfta din e-postadress
```

**Body (HTML)**

```html
<h2>Bekräfta din e-postadress</h2>
<p>Välkommen till Nordklart.</p>
<p>Bekräfta din e-postadress för att aktivera ditt konto och fortsätta.</p>
<p>
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email&flow=signup&next=/onboarding">
    Bekräfta e-post
  </a>
</p>
<p>Om du inte skapade ett Nordklart-konto kan du ignorera detta mejl.</p>
```

## Reset password

**Subject**

```text
Återställ ditt lösenord
```

**Body (HTML)**

```html
<h2>Återställ ditt lösenord</h2>
<p>Du har begärt att återställa lösenordet till ditt Nordklart-konto.</p>
<p>
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&flow=recovery&next=/reset-password">
    Välj nytt lösenord
  </a>
</p>
<p>Om du inte begärde detta kan du ignorera mejlet.</p>
```

## Magic Link

**Subject**

```text
Logga in i Nordklart
```

**Body (HTML)**

```html
<h2>Logga in i Nordklart</h2>
<p>
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=magiclink&flow=magiclink&next=/app">
    Logga in
  </a>
</p>
<p>Om du inte begärde länken kan du ignorera mejlet.</p>
```

## Invite user

**Subject**

```text
Du har blivit inbjuden till Nordklart
```

**Body (HTML)**

```html
<h2>Du har blivit inbjuden till Nordklart</h2>
<p>
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&flow=invite&next=/app">
    Acceptera inbjudan
  </a>
</p>
<p>Om du inte känner igen inbjudan kan du ignorera mejlet.</p>
```

## Change email address

**Subject**

```text
Bekräfta ny e-postadress
```

**Body (HTML)**

```html
<h2>Bekräfta ny e-postadress</h2>
<p>
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email_change&flow=email_change&next=/settings/account">
    Bekräfta ny e-postadress
  </a>
</p>
<p>Om du inte begärde ändringen ska du byta lösenord och kontakta ansvarig administratör.</p>
```

## Kontroll efter ändring

1. Skapa ett nytt konto i en annan browserprofil.
2. Öppna bekräftelselänken både i samma och annan browser.
3. Kontrollera att signup går till onboarding, inte reset password.
4. Testa `/forgot-password` och kontrollera att länken går till `/reset-password`.
5. Öppna en redan använd länk och kontrollera att rätt feltext visas.
6. Kontrollera `auth_audit_events` för `auth_callback_completed` och `auth_callback_failed`.
