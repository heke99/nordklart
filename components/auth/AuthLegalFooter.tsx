import Link from "next/link";
import { NORDKLART_LEGAL_NAME, NORDKLART_ORG_NUMBER } from "@/lib/branding/legal-identity";

type AuthLegalFooterProps = {
  className?: string;
  compact?: boolean;
};

const legalLinks = [
  { label: "Allmänna villkor", href: "/allmanna-villkor" },
  { label: "Integritetspolicy", href: "/integritetspolicy" },
  { label: "Cookies", href: "/cookies" },
  {
    label: "Personuppgiftsbiträdesavtal",
    href: "/personuppgiftsbitradesavtal",
  },
];

export function AuthLegalFooter({
  className = "",
  compact = false,
}: AuthLegalFooterProps) {
  return (
    <div className={`text-center text-xs text-muted-foreground ${className}`}>
      {!compact && (
        <p className="mb-3 leading-relaxed">
          Nordklart är en tjänst från {NORDKLART_LEGAL_NAME}, org.nr {NORDKLART_ORG_NUMBER}. Genom att använda tjänsten godkänner du våra villkor och hur vi behandlar personuppgifter.
        </p>
      )}
      {compact && (
        <p className="mb-2 leading-relaxed">Nordklart tillhandahålls av {NORDKLART_LEGAL_NAME}, org.nr {NORDKLART_ORG_NUMBER}.</p>
      )}
      <nav
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2"
        aria-label="Juridiska länkar"
      >
        {legalLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function LegalInlineLinks() {
  return (
    <>
      <Link
        href="/allmanna-villkor"
        className="underline underline-offset-2 hover:text-foreground"
      >
        allmänna villkor
      </Link>{" "}
      och{" "}
      <Link
        href="/integritetspolicy"
        className="underline underline-offset-2 hover:text-foreground"
      >
        integritetspolicy
      </Link>
    </>
  );
}
