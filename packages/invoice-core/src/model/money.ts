import Big from 'big.js'

export function big(value: string): Big {
  return new Big(value)
}

export function round2(value: Big): string {
  return value.round(2, Big.roundHalfUp).toFixed(2)
}
