# Tenancy och RLS

Tenantisolering kräver flera lager:

1. Server-side företagskontext från verifierat medlemskap.
2. Företagsfilter i applikationsfrågor.
3. RLS-policyer som förhindrar korsbolagsläsning och -skrivning.
4. Negativa tester med användare i andra företag.

Klientinskickat `company_id` är aldrig ensamt auktoritativt. Service-role-anrop
måste begränsas explicit och får inte kringgå tenantkontroller av bekvämlighet.
Guard-baslinjen innehåller två kända statiska migration/RLS-träffar som måste
granskas och elimineras eller dokumenteras med verifierad säker motsvarighet.

