"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="sv" translate="no">
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body>
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="text-center space-y-4">
            <h2 className="text-xl font-semibold">Något gick fel</h2>
            <p className="text-muted-foreground">
              Ett oväntat fel inträffade. Försök igen.
            </p>
            <button
              onClick={reset}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Försök igen
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
