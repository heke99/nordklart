# Import och parsning

- Bevara råkälla, filhash, parserutfall och spårbar importidentitet.
- Validera filtyp, storlek, kodning och tenant innan bearbetning.
- SIE använder den dedikerade konto-/års-/dimensionsresolvern och ett separat
  finaliseringssteg; skapa inte parallell journalbokning i en route.
- Importer ska vara idempotenta och tydligt skilja förhandsgranskning från commit.
- Dokumentextraktion får föreslå data men får inte göra oåterkalleliga ekonomiska
  mutationer utan verifiering.

