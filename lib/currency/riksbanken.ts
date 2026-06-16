import { createLogger } from '@/lib/logger'
import type { Currency, ExchangeRate } from '@/types'

const log = createLogger('riksbanken')

/** Riksbanken series IDs for each currency */
const SERIES_IDS: Record<Currency, string> = {
  SEK: '',
  EUR: 'SEKEURPMI',
  USD: 'SEKUSDPMI',
  GBP: 'SEKGBPPMI',
  NOK: 'SEKNOKPMI',
  DKK: 'SEKDKKPMI',
}

/**
 * Fetch exchange rates from Riksbanken API
 * Uses their public API for daily exchange rates
 */
export async function fetchExchangeRate(
  currency: Currency,
  date?: Date
): Promise<ExchangeRate | null> {
  if (currency === 'SEK') {
    return {
      currency: 'SEK',
      rate: 1,
      date: new Date().toISOString().split('T')[0],
    }
  }

  const targetDate = date || new Date()
  const formattedDate = targetDate.toISOString().split('T')[0]

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return null
  }

  try {
    // Riksbanken's public API endpoint
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${formattedDate}/${formattedDate}`

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
      next: { revalidate: 3600 }, // Cache for 1 hour
    })

    // 204 = no data for this date (e.g. rate not published yet today)
    // Also handle non-ok responses by falling back to a recent date range
    if (!response.ok || response.status === 204) {
      // Fetch the last 7 days to find the most recent available rate
      const to = formattedDate
      const fromDate = new Date(targetDate)
      fromDate.setDate(fromDate.getDate() - 7)
      const from = fromDate.toISOString().split('T')[0]

      const fallbackUrl = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${from}/${to}`
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: {
          Accept: 'application/json',
        },
        next: { revalidate: 3600 },
      })

      if (!fallbackResponse.ok || fallbackResponse.status === 204) {
        throw new Error(`Failed to fetch exchange rate: ${fallbackResponse.status}`)
      }

      const fallbackData = await fallbackResponse.json()
      if (fallbackData && fallbackData.length > 0) {
        const latest = fallbackData[fallbackData.length - 1]
        return {
          currency,
          rate: parseFloat(latest.value),
          date: latest.date,
        }
      }

      return null
    }

    const data = await response.json()
    if (data && data.length > 0) {
      return {
        currency,
        rate: parseFloat(data[0].value),
        date: data[0].date,
      }
    }

    return null
  } catch (error) {
    log.error('Error fetching exchange rate:', error)
    // Return fallback rates for development/testing
    return getFallbackRate(currency)
  }
}

/**
 * Fallback exchange rates for when API is unavailable
 * These should be updated periodically
 */
function getFallbackRate(currency: Currency): ExchangeRate {
  const fallbackRates: Record<Currency, number> = {
    SEK: 1,
    EUR: 11.5, // ~11.5 SEK per EUR
    USD: 10.5, // ~10.5 SEK per USD
    GBP: 13.5, // ~13.5 SEK per GBP
    NOK: 1.0, // ~1 SEK per NOK
    DKK: 1.55, // ~1.55 SEK per DKK
  }

  return {
    currency,
    rate: fallbackRates[currency],
    date: new Date().toISOString().split('T')[0],
  }
}

/**
 * Convert amount from one currency to SEK
 */
export function convertToSEK(
  amount: number,
  exchangeRate: number
): number {
  return amount * exchangeRate
}

/**
 * Format currency amount with proper symbol
 */
export function formatCurrencyAmount(
  amount: number,
  currency: Currency
): string {
  const symbols: Record<Currency, string> = {
    SEK: 'kr',
    EUR: '€',
    USD: '$',
    GBP: '£',
    NOK: 'kr',
    DKK: 'kr',
  }

  const formatted = new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

  if (currency === 'EUR' || currency === 'USD' || currency === 'GBP') {
    return `${symbols[currency]}${formatted}`
  }

  return `${formatted} ${currency}`
}

/**
 * Fetch exchange rates for multiple currencies in parallel.
 * Returns a Map with all requested currencies. Individual failures
 * use fallback rates so the Map is always fully populated.
 * SEK is always included with rate 1.
 */
export async function fetchMultipleRates(
  currencies: Currency[],
  date?: Date
): Promise<Map<Currency, ExchangeRate>> {
  const results = new Map<Currency, ExchangeRate>()

  // Always include SEK
  results.set('SEK', {
    currency: 'SEK',
    rate: 1,
    date: (date || new Date()).toISOString().split('T')[0],
  })

  const nonSek = currencies.filter(c => c !== 'SEK')
  if (nonSek.length === 0) return results

  const settled = await Promise.allSettled(
    nonSek.map(currency => fetchExchangeRate(currency, date))
  )

  for (let i = 0; i < nonSek.length; i++) {
    const currency = nonSek[i]
    const outcome = settled[i]

    if (outcome.status === 'fulfilled' && outcome.value) {
      results.set(currency, outcome.value)
    } else {
      // fetchExchangeRate already returns fallback on error,
      // but if it returned null or the promise rejected, use fallback
      results.set(currency, getFallbackRate(currency))
    }
  }

  return results
}

/**
 * Fetch exchange rates for a currency over a date range.
 * Uses the Riksbanken date-range endpoint. Returns a sorted array.
 */
export async function fetchRateRange(
  currency: Currency,
  fromDate: Date,
  toDate: Date
): Promise<ExchangeRate[]> {
  if (currency === 'SEK') {
    return [{
      currency: 'SEK',
      rate: 1,
      date: fromDate.toISOString().split('T')[0],
    }]
  }

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return []
  }

  const from = fromDate.toISOString().split('T')[0]
  const to = toDate.toISOString().split('T')[0]

  try {
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${from}/${to}`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      log.error(`Failed to fetch rate range: ${response.status}`)
      return []
    }

    const data = await response.json()
    if (!Array.isArray(data)) return []

    return data
      .map((item: { date: string; value: string }) => ({
        currency,
        rate: parseFloat(item.value),
        date: item.date,
      }))
      .sort((a: ExchangeRate, b: ExchangeRate) => a.date.localeCompare(b.date))
  } catch (error) {
    log.error('Error fetching rate range:', error)
    return []
  }
}

/**
 * Fetch the latest available exchange rate for a currency.
 * Useful when today's rate hasn't been published yet.
 */
export async function fetchLatestRate(
  currency: Currency
): Promise<ExchangeRate | null> {
  if (currency === 'SEK') {
    return {
      currency: 'SEK',
      rate: 1,
      date: new Date().toISOString().split('T')[0],
    }
  }

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return null
  }

  try {
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      log.error(`Failed to fetch latest rate: ${response.status}`)
      return null
    }

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) return null

    const latest = data[data.length - 1]
    return {
      currency,
      rate: parseFloat(latest.value),
      date: latest.date,
    }
  } catch (error) {
    log.error('Error fetching latest rate:', error)
    return getFallbackRate(currency)
  }
}
