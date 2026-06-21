// lib/accounting-rules/rule-engine.ts

import type { EntityContext, PurchaseRuleInput, RuleDecision } from './types'
import { classifyAssetCandidate } from './asset-classification-engine'
import { evaluateDeductibility } from './deductibility-engine'
import { decideVatTreatment } from './vat-deduction-engine'

export function evaluatePurchaseForAccounting(
  input: PurchaseRuleInput,
  context: EntityContext,
): RuleDecision {
  const deductibility = evaluateDeductibility(input, context)
  const vat = decideVatTreatment(input, context)
  const assetCandidate = classifyAssetCandidate(input, context)

  const warnings = [...deductibility.warnings, ...vat.warnings]
  const vatDeductible = Math.round(
    (vat.deductiblePercentage * deductibility.deductiblePercentage) / 100,
  )

  if (deductibility.reviewSeverity === 'blocking') {
    return {
      decision: 'private',
      accountNumber: deductibility.accountNumber,
      vatTreatment: vat.vatTreatment,
      deductiblePercentage: 0,
      privatePercentage: 100,
      reasonCode: deductibility.reasonCode,
      explanationSv: deductibility.explanationSv,
      requiredEvidence: deductibility.requiredEvidence,
      reviewSeverity: 'blocking',
      warnings,
    }
  }

  if (assetCandidate && assetCandidate.decision === 'review_required') {
    return {
      decision: 'review_required',
      accountNumber: null,
      vatTreatment: vat.vatTreatment,
      deductiblePercentage: vatDeductible,
      privatePercentage: deductibility.privatePercentage,
      reasonCode: assetCandidate.reasonCode,
      explanationSv: assetCandidate.explanationSv,
      requiredEvidence: [
        ...deductibility.requiredEvidence,
        ...propertyEvidence(assetCandidate.reasonCode),
      ],
      reviewSeverity: assetCandidate.reviewSeverity,
      warnings,
      suggestedAsset: assetCandidate.suggestedAsset,
    }
  }

  if (assetCandidate?.decision === 'asset' && deductibility.deductiblePercentage === 100) {
    return {
      decision: 'asset',
      accountNumber: assetCandidate.suggestedAsset?.category === 'computer' ? '1250' : '1220',
      vatTreatment: vat.vatTreatment,
      deductiblePercentage: vatDeductible,
      privatePercentage: 0,
      reasonCode: assetCandidate.reasonCode,
      explanationSv: assetCandidate.explanationSv,
      requiredEvidence: deductibility.requiredEvidence,
      reviewSeverity: assetCandidate.reviewSeverity,
      warnings,
      suggestedAsset: assetCandidate.suggestedAsset,
    }
  }

  const decision = deductibility.privatePercentage > 0 ? 'mixed' : 'expense'

  const expenseAccountNumber =
    assetCandidate?.reasonCode === 'LOW_VALUE_INVENTORY_DIRECT_EXPENSE_2026'
      ? '5410'
      : deductibility.accountNumber

  return {
    decision,
    accountNumber: expenseAccountNumber,
    vatTreatment: vat.vatTreatment,
    deductiblePercentage: vatDeductible,
    privatePercentage: deductibility.privatePercentage,
    reasonCode: assetCandidate?.reasonCode ?? deductibility.reasonCode,
    explanationSv: assetCandidate?.explanationSv ?? deductibility.explanationSv,
    requiredEvidence: deductibility.requiredEvidence,
    reviewSeverity: maxSeverity(
      deductibility.reviewSeverity,
      assetCandidate?.reviewSeverity ?? 'none',
      vat.warnings.length ? 'warning' : 'none',
    ),
    warnings,
    suggestedAsset: assetCandidate?.suggestedAsset,
  }
}

function propertyEvidence(reasonCode: string) {
  if (reasonCode !== 'PROPERTY_REQUIRES_SPLIT_OR_REVIEW') return []

  return [
    {
      code: 'land_building_split',
      labelSv: 'fördelning mellan mark, byggnad och markanläggning',
    },
    {
      code: 'property_action_type',
      labelSv: 'bedömning av reparation, förbättring eller komponentbyte',
    },
  ]
}

function maxSeverity(
  ...levels: RuleDecision['reviewSeverity'][]
): RuleDecision['reviewSeverity'] {
  const order: Record<RuleDecision['reviewSeverity'], number> = {
    none: 0,
    info: 1,
    warning: 2,
    danger: 3,
    blocking: 4,
  }

  return levels.reduce(
    (max, level) => (order[level] > order[max] ? level : max),
    'none',
  )
}