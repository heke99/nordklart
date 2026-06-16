import type {
  SalesInvoiceDto, SalesInvoiceLineDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto,
  SupplierInvoiceDto, SupplierInvoiceLineDto,
  CustomerDto, SupplierDto,
  JournalDto, AccountingEntryDto,
  AccountingAccountDto, AccountType,
  CompanyInformationDto,
  AmountType, PartyDto,
} from '../dto';

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

function deriveInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const remaining = raw['RemainingAmount'] as number ?? 0;
  const total = raw['TotalAmount'] as number ?? 0;
  if (raw['IsCancelled'] === true) return 'cancelled';
  if (remaining === 0 && total > 0) return 'paid';
  if (raw['IsBooked'] === true) return 'booked';
  if (raw['IsSent'] === true || raw['SendType'] != null) return 'sent';
  return 'draft';
}

function buildParty(name: string, orgNumber?: string, raw?: Record<string, unknown>): PartyDto {
  return {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: raw ? {
      streetName: (raw['InvoiceAddress1'] ?? raw['Address1']) as string | undefined,
      additionalStreetName: (raw['InvoiceAddress2'] ?? raw['Address2']) as string | undefined,
      cityName: (raw['InvoiceCity'] ?? raw['City']) as string | undefined,
      postalZone: (raw['InvoicePostalCode'] ?? raw['PostalCode']) as string | undefined,
      countryCode: raw['CountryCode'] as string | undefined,
    } : undefined,
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: {
      email: (raw?.['EmailAddress'] ?? raw?.['Email']) as string | undefined,
      telephone: (raw?.['Telephone'] ?? raw?.['Phone']) as string | undefined,
    },
  };
}

export function mapVismaToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['CurrencyCode'] as string) ?? 'SEK';
  const total = raw['TotalAmount'] as number ?? 0;
  const remaining = raw['RemainingAmount'] as number ?? 0;

  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const lines: SalesInvoiceLineDto[] = rows.map((row, idx) => ({
    id: String(row['LineNumber'] ?? idx + 1),
    description: row['Text'] as string | undefined,
    quantity: row['Quantity'] as number | undefined,
    unitCode: row['UnitAbbreviation'] as string | undefined,
    unitPrice: row['UnitPrice'] != null ? amount(row['UnitPrice'] as number, currency) : undefined,
    lineExtensionAmount: amount(row['LineTotal'] as number ?? 0, currency),
    taxPercent: row['VatRatePercent'] as number | undefined,
    accountNumber: row['AccountNumber'] != null ? String(row['AccountNumber']) : undefined,
    articleNumber: row['ArticleNumber'] as string | undefined,
  }));

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: remaining === 0 && total > 0,
    balance: amount(remaining, currency),
  };

  return {
    id: String(raw['Id'] ?? ''),
    invoiceNumber: String(raw['InvoiceNumber'] ?? ''),
    issueDate: (raw['InvoiceDate'] as string) ?? '',
    dueDate: raw['DueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty(''),
    customer: buildParty(
      (raw['InvoiceCustomerName'] ?? '') as string,
      undefined,
    ),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    createdAt: raw['CreatedUtc'] as string | undefined,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['CurrencyCode'] as string) ?? 'SEK';
  const total = raw['TotalAmount'] as number ?? 0;
  const remaining = raw['RemainingAmount'] as number ?? 0;

  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const lines: SupplierInvoiceLineDto[] = rows.map((row, idx) => {
    const debit = (row['DebetAmount'] as number) ?? 0;
    const credit = (row['CreditAmount'] as number) ?? 0;
    const rowAmount = debit || credit;
    return {
      id: String(row['LineNumber'] ?? idx + 1),
      description: row['TransactionText'] as string | undefined,
      quantity: row['Quantity'] as number | undefined,
      lineExtensionAmount: amount(rowAmount, currency),
      accountNumber: row['AccountNumber'] != null ? String(row['AccountNumber']) : undefined,
    };
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: remaining === 0 && total > 0,
    balance: amount(remaining, currency),
  };

  return {
    id: String(raw['Id'] ?? ''),
    invoiceNumber: String(raw['InvoiceNumber'] ?? ''),
    issueDate: (raw['InvoiceDate'] as string) ?? '',
    dueDate: raw['DueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty((raw['SupplierName'] ?? '') as string),
    buyer: buildParty(''),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToCustomer(raw: Record<string, unknown>): CustomerDto {
  return {
    id: String(raw['Id'] ?? ''),
    customerNumber: String(raw['CustomerNumber'] ?? ''),
    type: raw['IsPrivatePerson'] === true ? 'private' : 'company',
    party: buildParty(
      (raw['Name'] as string) ?? '',
      raw['CorporateIdentityNumber'] as string | undefined,
      raw,
    ),
    active: raw['IsActive'] !== false,
    note: raw['Note'] as string | undefined,
    updatedAt: raw['ChangedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToSupplier(raw: Record<string, unknown>): SupplierDto {
  return {
    id: String(raw['Id'] ?? ''),
    supplierNumber: String(raw['SupplierNumber'] ?? ''),
    party: buildParty(
      (raw['Name'] as string) ?? '',
      raw['CorporateIdentityNumber'] as string | undefined,
      raw,
    ),
    active: raw['IsActive'] !== false,
    bankAccount: raw['BankAccountNumber'] as string | undefined,
    bankGiro: raw['BankGiro'] as string | undefined,
    plusGiro: raw['PlusGiro'] as string | undefined,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  const num = Number(raw['Number']);
  let type: AccountType | undefined;
  if (num >= 1000 && num < 2000) type = 'asset';
  else if (num >= 2000 && num < 3000) type = 'liability';
  else if (num >= 3000 && num < 4000) type = 'revenue';
  else if (num >= 4000 && num < 9000) type = 'expense';

  return {
    accountNumber: String(raw['Number'] ?? ''),
    name: (raw['Name'] as string) ?? '',
    type,
    vatCode: raw['VatCodeId'] != null ? String(raw['VatCodeId']) : undefined,
    active: raw['IsActive'] !== false,
    _raw: raw,
  };
}

export function mapVismaToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  return {
    companyName: (raw['Name'] as string) ?? '',
    organizationNumber: raw['CorporateIdentityNumber'] as string | undefined,
    legalEntity: {
      registrationName: (raw['Name'] as string) ?? '',
      companyId: raw['CorporateIdentityNumber'] as string | undefined,
      companyIdSchemeId: 'SE:ORGNR',
    },
    address: {
      streetName: raw['Address1'] as string | undefined,
      cityName: raw['City'] as string | undefined,
      postalZone: raw['PostalCode'] as string | undefined,
      countryCode: raw['CountryCode'] as string | undefined,
    },
    contact: {
      email: raw['Email'] as string | undefined,
      telephone: raw['Phone'] as string | undefined,
    },
    baseCurrency: raw['CurrencyCode'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToJournal(raw: Record<string, unknown>): JournalDto {
  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const entries: AccountingEntryDto[] = rows.map((row) => ({
    accountNumber: String(row['AccountNumber'] ?? ''),
    accountName: row['AccountName'] as string | undefined,
    debit: (row['DebitAmount'] as number) ?? 0,
    credit: (row['CreditAmount'] as number) ?? 0,
    description: row['Description'] as string | undefined,
  }));

  return {
    id: String(raw['Id'] ?? ''),
    journalNumber: String(raw['VoucherNumber'] ?? raw['Number'] ?? ''),
    description: raw['Description'] as string | undefined,
    registrationDate: (raw['VoucherDate'] as string) ?? '',
    entries,
    _raw: raw,
  };
}
